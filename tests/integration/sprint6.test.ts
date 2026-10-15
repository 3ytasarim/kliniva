import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { auditLogs, notifications, outboxEvents } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant, tenantQuery } from "@/server/tenant/tenant-query";
import { createRoom } from "@/server/services/org";
import { assignDoctorBranch, createDoctor } from "@/server/services/doctors";
import { addWorkingHour } from "@/server/services/schedule";
import { createPatient } from "@/server/services/patients";
import { createClinicalService, setDoctorServices } from "@/server/services/clinical-services";
import { upsertClinicProfile } from "@/server/services/clinic";
import {
  approveAppointment,
  cancelAppointment,
  createAppointment,
  declineAppointment,
  listMyPendingApprovals,
  rescheduleAppointment,
  updateAppointmentStatus,
} from "@/server/services/appointments";
import { addStock, adjustStock, createInventoryItem, createLocation } from "@/server/services/inventory";
import { recallLot, recordPhysicalCount } from "@/server/services/lots";
import {
  archiveNotification,
  getNotificationPreferences,
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  setNotificationPreference,
} from "@/server/services/notifications";
import {
  enqueueOutbox,
  listFailedOutboxEvents,
  nextAttemptAt,
  processOutboxBatch,
  retryFailedOutboxEvent,
  type ProcessResult,
} from "@/server/notifications/outbox";
import { scanExpiryNotifications } from "@/server/notifications/expiry-scan";
import { openNotificationStream } from "@/server/notifications/sse";
import type { NotificationChannel } from "@/server/notifications/channels";
import { POST as readRoute } from "@/app/api/v1/notifications/[id]/read/route";
import { GET as streamRoute } from "@/app/api/v1/notifications/stream/route";
import { logout } from "@/server/auth/login";
import { addDays, dateInZone, isoDayOfWeek, parseTime, zonedDateTimeToUtc } from "@/lib/time";
import { apiRequest, cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Sprint 6 — transactional outbox, işlemci (SKIP LOCKED + tekilleştirme), yeniden deneme, bildirim güvenliği,
 * SSE (oturumdan alıcı), randevu bildirimleri, doktor onay modu, stok / SKT / geri çağırma uyarıları, RLS,
 * DB havuzu yük testi. Her şey uygulama rolüyle (kliniva_app); arka plan işleme kapalı → işlemci açıkça çağrılır.
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let D1: string; // docA'nın doktor kaydı
let D2: string; // docB'nin doktor kaydı
let R1: string;
let S: string;
let WH: string;
const P: string[] = [];
let seq = 0;

const owner = () => A.users.owner!.ctx;
const reception = () => A.users.reception!.ctx;
const today = () => dateInZone(new Date(), TZ);
const day = (n: number) => addDays(today(), n);
const process6 = (opts: { channel?: NotificationChannel; batchSize?: number } = {}) =>
  processOutboxBatch({ tenantIds: [A.id], ...opts });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};
const tally = (rs: string[]) =>
  rs.reduce<Record<string, number>>((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});

function monday(weeks: number): string {
  let d = addDays(today(), 7);
  while (isoDayOfWeek(d) !== 1) d = addDays(d, 1);
  return addDays(d, weeks * 7);
}
const at = (date: string, hhmm: string) => zonedDateTimeToUtc(date, parseTime(hhmm)!, TZ).toISOString();

async function book(o: { doctor?: string; patient?: string; date: string; time: string; room?: string }) {
  return (
    await createAppointment(reception(), {
      patientId: o.patient ?? P[0]!,
      branchId: A.branchA,
      doctorId: o.doctor ?? D1,
      serviceId: S,
      start: at(o.date, o.time),
      roomId: o.room,
    })
  ).id;
}
async function notesOf(user: keyof TestTenant["users"], type?: string) {
  const r = await listNotifications(A.users[user]!.ctx, { limit: 100 });
  return type ? r.items.filter((n) => n.type === type) : r.items;
}
const outboxFor = async (aggregateId: string) =>
  runInTenant(A.id, (s) =>
    s.tx
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, A.id), eq(outboxEvents.aggregateId, aggregateId))),
  );
const notificationsFor = async (entityId: string) =>
  runInTenant(A.id, (s) => s.tx.select().from(notifications).where(eq(notifications.entityId, entityId)));
const audits = async (action: string) =>
  runInTenant(A.id, (s) =>
    s.tx
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, action as typeof auditLogs.$inferSelect.action)),
  );
/** Kuyruk boşalana kadar işle. */
async function drain(): Promise<ProcessResult> {
  const total: ProcessResult = { claimed: 0, processed: 0, retried: 0, failed: 0, notificationsCreated: 0 };
  for (let i = 0; i < 50; i++) {
    const r = await process6();
    total.claimed += r.claimed;
    total.processed += r.processed;
    total.notificationsCreated += r.notificationsCreated;
    if (r.claimed === 0) break;
  }
  return total;
}

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    admin: { role: "CLINIC_ADMIN" },
    reception: { role: "RECEPTION" },
    invmgr: { role: "INVENTORY_MANAGER" },
    managerA: { role: "BRANCH_MANAGER", branch: "A" },
    docA: { role: "DOCTOR" },
    docB: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" }, docX: { role: "DOCTOR" } });

  R1 = (await createRoom(owner(), { branchId: A.branchA, name: "Oda 1", type: "PROCEDURE" })).id;
  D1 = (await createDoctor(owner(), { mode: "existing", userId: A.users.docA!.id, specialty: "Dermatoloji" }))
    .id;
  D2 = (await createDoctor(owner(), { mode: "existing", userId: A.users.docB!.id, specialty: "Estetik" })).id;
  for (const d of [D1, D2]) {
    await assignDoctorBranch(owner(), d, A.branchA);
    await addWorkingHour(owner(), {
      doctorId: d,
      branchId: A.branchA,
      dayOfWeek: 1,
      startTime: "08:00",
      endTime: "20:00",
    });
  }
  S = (
    await createClinicalService(owner(), {
      name: "PRP",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
    })
  ).id;
  for (const d of [D1, D2]) await setDoctorServices(owner(), { doctorId: d, services: [{ serviceId: S }] });
  WH = (await createLocation(owner(), { branchId: A.branchA, type: "BRANCH_WAREHOUSE", name: "Depo" })).id;
  for (let i = 0; i < 20; i++) {
    P.push(
      (
        await createPatient(owner(), {
          firstName: `Bildirim${i}`,
          lastName: "Hastası",
          phone: `0539${String(1000000 + i)}`,
          branchId: A.branchA,
        })
      ).id,
    );
  }
  // Kurulum olaylarını (varsa) temizle.
  await drain();
}, 300_000);

afterAll(cleanupTenants);

// ================================================================ transactional outbox
describe("Transactional outbox", () => {
  it("iş başarılı → outbox olayı aynı transaction'da; yükte hasta adı / telefon / not YOK", async () => {
    const id = await book({ date: monday(1), time: "09:00" });
    const ev = await outboxFor(id);
    expect(ev.map((e) => [e.eventType, e.status])).toEqual([["APPOINTMENT_CREATED", "PENDING"]]);
    expect(Object.keys(ev[0]!.payloadSafe).sort()).toEqual([
      "actorUserId",
      "appointmentId",
      "branchId",
      "doctorId",
    ]);
    expect(JSON.stringify(ev[0]!.payloadSafe)).not.toMatch(/Bildirim|Hastası|0539/);
  });

  it("iş geri alınırsa outbox olayı da YOK (randevu çakışması, ham rollback, stok reddi)", async () => {
    const count = async () =>
      (
        await runInTenant(A.id, (s) =>
          s.tx
            .select({ n: sql<number>`count(*)::int` })
            .from(outboxEvents)
            .where(eq(outboxEvents.tenantId, A.id)),
        )
      )[0]!.n;
    const before = await count();
    await book({ date: monday(1), time: "10:00" });
    const mid = await count();
    expect(mid).toBe(before + 1);
    expect(await code(book({ date: monday(1), time: "10:00", patient: P[1]! }))).toBe("APPOINTMENT_CONFLICT");
    expect(await count()).toBe(mid);
    const ghost = "11111111-1111-4111-8111-111111111111";
    await expect(
      runInTenant(A.id, async (s) => {
        await enqueueOutbox(s, {
          eventType: "APPOINTMENT_CREATED",
          aggregateType: "appointment",
          aggregateId: ghost,
          payload: { appointmentId: ghost },
        });
        throw new Error("ROLLBACK");
      }),
    ).rejects.toThrow("ROLLBACK");
    expect(await outboxFor(ghost)).toEqual([]);
    const item = (
      await createInventoryItem(owner(), { name: "Rollback ürün", code: "S6-RB", minimumStockLevel: "5" })
    ).id;
    await addStock(owner(), { inventoryItemId: item, locationId: WH, quantity: "6", kind: "INITIAL_STOCK" });
    expect(
      await code(
        adjustStock(owner(), {
          inventoryItemId: item,
          locationId: WH,
          direction: "OUT",
          quantity: "9",
          reason: "Fire",
        }),
      ),
    ).toBe("INSUFFICIENT_STOCK");
    expect(await outboxFor(item)).toEqual([]);
    await drain();
  });
});

// ================================================================ randevu bildirimleri
describe("Randevu bildirimleri", () => {
  it("oluştur / taşı / check-in / iptal → doktor bildirimi; işlemi yapan bildirim almaz; tekrar geçiş yinelenmez", async () => {
    const date = monday(2);
    const id = await book({ date, time: "09:00" });
    await drain();
    const created = (await notesOf("docA", "APPOINTMENT_CREATED")).filter(
      (n) => n.href === `/appointments/${id}`,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatch(/09:00 · PRP$/);
    // Bildirim içeriğinde hasta adı yok; yetki kontrollü bağlam (UI) hasta adını gösterir.
    expect(created[0]!.body).not.toMatch(/Bildirim0/);
    expect(created[0]!.context).toBe("09:00 — Bildirim0 Hastası");
    expect(await notesOf("reception", "APPOINTMENT_CREATED")).toEqual([]);
    expect(await notesOf("docB", "APPOINTMENT_CREATED")).toEqual([]);

    await rescheduleAppointment(reception(), id, { start: at(date, "11:00") });
    await drain();
    const moved = await notesOf("docA", "APPOINTMENT_RESCHEDULED");
    expect(moved).toHaveLength(1);
    expect(moved[0]!.body).toMatch(/^09:00 → .*11:00/);

    const todayId = await book({ date, time: "16:00", patient: P[19]! });
    await updateAppointmentStatus(reception(), todayId, { status: "CHECKED_IN" });
    expect(await code(updateAppointmentStatus(reception(), todayId, { status: "CHECKED_IN" }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    await drain();
    await drain();
    const checkins = (await notesOf("docA", "PATIENT_CHECKED_IN")).filter(
      (n) => n.href === `/appointments/${todayId}`,
    );
    expect(checkins).toHaveLength(1);
    expect(checkins[0]!.body).toMatch(/randevunuz$/);

    await cancelAppointment(reception(), id, { reason: "Hasta aradı — özel sebep 0532" });
    await drain();
    const cancelled = await notesOf("docA", "APPOINTMENT_CANCELLED");
    expect(cancelled).toHaveLength(1);
    expect(JSON.stringify(cancelled)).not.toMatch(/özel sebep|0532/);
  });

  it("aynı mantıksal olay ikinci kez kuyruğa girse de (at-least-once) bildirim TEK kalır", async () => {
    const id = await book({ date: monday(2), time: "14:00" });
    await drain();
    await runInTenant(A.id, (s) =>
      enqueueOutbox(s, {
        eventType: "APPOINTMENT_CREATED",
        aggregateType: "appointment",
        aggregateId: id,
        payload: { appointmentId: id, doctorId: D1, branchId: A.branchA, actorUserId: A.users.reception!.id },
      }),
    );
    const r = await drain();
    expect(r.processed).toBeGreaterThanOrEqual(1);
    expect(r.notificationsCreated).toBe(0);
    expect((await notificationsFor(id)).filter((n) => n.type === "APPOINTMENT_CREATED")).toHaveLength(1);
  });

  it("tercih: doktor yeni randevu bildirimini kapatabilir; güvenlik bildirimleri kapatılamaz", async () => {
    const doc = A.users.docB!.ctx;
    await setNotificationPreference(doc, { type: "APPOINTMENT_CREATED", inAppEnabled: false });
    expect(await code(setNotificationPreference(doc, { type: "LOT_RECALLED", inAppEnabled: false }))).toBe(
      "VALIDATION",
    );
    const prefs = await getNotificationPreferences(doc);
    expect(prefs.find((p) => p.type === "APPOINTMENT_CREATED")!.inAppEnabled).toBe(false);
    expect(prefs.find((p) => p.type === "LOT_RECALLED")).toMatchObject({
      mandatory: true,
      inAppEnabled: true,
    });
    const id = await book({ doctor: D2, date: monday(2), time: "15:00" });
    await drain();
    expect((await notificationsFor(id)).filter((n) => n.recipientUserId === A.users.docB!.id)).toEqual([]);
    await setNotificationPreference(doc, { type: "APPOINTMENT_CREATED", inAppEnabled: true });
  });
});

// ================================================================ işlemci: eşzamanlılık + yeniden deneme
describe("Outbox işlemcisi", () => {
  it("Outbox Concurrency: iki işçi aynı kuyruğu eşzamanlı işler → her mantıksal bildirim tam 1 kez", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++)
      ids.push(
        await book({
          date: monday(4),
          time: `${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
          patient: P[i]!,
        }),
      );
    let claimed = 0;
    for (let round = 0; round < 20; round++) {
      const [a, b] = await Promise.all([process6({ batchSize: 3 }), process6({ batchSize: 3 })]);
      claimed += a.claimed + b.claimed;
      if (a.claimed + b.claimed === 0) break;
    }
    expect(claimed).toBeGreaterThanOrEqual(12);
    for (const id of ids) {
      const ns = (await notificationsFor(id)).filter((n) => n.type === "APPOINTMENT_CREATED");
      expect(ns, id).toHaveLength(1);
      expect((await outboxFor(id)).every((e) => e.status === "PROCESSED")).toBe(true);
    }
  }, 120_000);

  it("Retry: kanal hatası → attempt +1, available_at ileri; 5. denemede FAILED + audit; hata kodu güvenli", async () => {
    const id = await book({ date: monday(5), time: "09:00" });
    const failing: NotificationChannel = {
      name: "IN_APP",
      async send() {
        throw new Error("SIMULATED_CHANNEL_DOWN");
      },
    };
    const leaking: NotificationChannel = {
      name: "IN_APP",
      async send() {
        // Bağlantı dizesi biçimli sahte hata (kaynakta sabit dize olarak tutulmaz — sır taraması).
        throw new Error(
          ["connect failed ", "postgres", ":/", "/user:secret@host/db at stack line 12"].join(""),
        );
      },
    };
    const t0 = Date.now();
    await process6({ channel: failing });
    let [ev] = await outboxFor(id);
    expect(ev!.status).toBe("PENDING");
    expect(ev!.attemptCount).toBe(1);
    expect(ev!.lastErrorCode).toBe("SIMULATED_CHANNEL_DOWN");
    expect(ev!.availableAt.getTime()).toBeGreaterThanOrEqual(t0 + 55_000);
    expect(nextAttemptAt(2, new Date(0)).getTime()).toBe(5 * 60_000);
    expect(nextAttemptAt(4, new Date(0)).getTime()).toBe(60 * 60_000);
    // Zamanı ilerletmek yerine available_at şimdiye çekilir (sahip rolüyle; yük / tip değişmez).
    const due = () =>
      getMigrationDb().transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${A.id}, true)`);
        await tx.execute(sql`update kliniva.outbox_events set available_at = now() where id = ${ev!.id}`);
      });
    for (let i = 2; i <= 5; i++) {
      await due();
      await process6({ channel: i === 3 ? leaking : failing });
      [ev] = await outboxFor(id);
      expect(ev!.attemptCount).toBe(i);
    }
    expect(ev!.status).toBe("FAILED");
    expect(JSON.stringify(ev)).not.toMatch(/secret|postgres:\/\/|stack/);
    const audit = (await audits("OUTBOX_FAILED")).find((a) => a.entityId === ev!.id);
    expect(audit?.metadataSafe).toMatchObject({ attempts: 5, code: "SIMULATED_CHANNEL_DOWN" });
    // randevu (iş) geri alınmadı
    expect((await notificationsFor(id)).length).toBe(0);

    // Yönetim: yalnızca sahip / yönetici; ham yük gösterilmez
    const list = await listFailedOutboxEvents(A.users.admin!.ctx);
    const row = list.items.find((x) => x.id === ev!.id)!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "aggregateId",
        "aggregateType",
        "attemptCount",
        "createdAt",
        "eventType",
        "id",
        "lastErrorCode",
        "status",
      ].sort(),
    );
    for (const who of ["reception", "docA", "invmgr", "managerA"] as const) {
      expect(await code(listFailedOutboxEvents(A.users[who]!.ctx)), who).toBe("FORBIDDEN");
    }
    await retryFailedOutboxEvent(owner(), ev!.id);
    await drain();
    [ev] = await outboxFor(id);
    expect(ev!.status).toBe("PROCESSED");
    expect((await notificationsFor(id)).filter((n) => n.type === "APPOINTMENT_CREATED")).toHaveLength(1);
  });
});

// ================================================================ bildirim güvenliği
describe("Bildirim güvenliği", () => {
  it("kullanıcı yalnızca kendi bildirimini görür / işaretler; başkasının kimliği NOT_FOUND; okunmamış sayısı doğru", async () => {
    const mine = (await notesOf("docA"))[0]!;
    for (const who of ["docB", "reception", "admin"] as const) {
      expect(
        (await notesOf(who)).some((n) => n.id === mine.id),
        who,
      ).toBe(false);
      expect(await code(markNotificationRead(A.users[who]!.ctx, mine.id)), who).toBe("NOT_FOUND");
      expect(await code(archiveNotification(A.users[who]!.ctx, mine.id)), who).toBe("NOT_FOUND");
    }
    expect(await code(markNotificationRead(B.users.owner!.ctx, mine.id))).toBe("NOT_FOUND");
    const res = await readRoute(
      apiRequest(`/api/v1/notifications/${mine.id}/read`, { method: "POST", token: A.users.docB!.token }),
      {
        params: Promise.resolve({ id: mine.id }),
      },
    );
    expect(res.status).toBe(404);
    const unread = await getUnreadNotificationCount(A.users.docA!.ctx);
    expect(unread).toBe((await listNotifications(A.users.docA!.ctx, { filter: "unread", limit: 100 })).total);
    await markNotificationRead(A.users.docA!.ctx, mine.id);
    await markNotificationRead(A.users.docA!.ctx, mine.id); // idempotent
    expect(await getUnreadNotificationCount(A.users.docA!.ctx)).toBe(
      unread - (mine.status === "UNREAD" ? 1 : 0),
    );
    const all = await markAllNotificationsRead(A.users.docA!.ctx);
    expect(await getUnreadNotificationCount(A.users.docA!.ctx)).toBe(0);
    expect(all.updated).toBeGreaterThanOrEqual(0);
    await archiveNotification(A.users.docA!.ctx, mine.id);
    expect((await notesOf("docA")).some((n) => n.id === mine.id)).toBe(false);
    expect((await audits("NOTIFICATION_READ")).some((a) => a.entityId === mine.id)).toBe(true);
  });

  it("DB: bildirim içeriği / outbox yükü uygulama rolünce değiştirilemez, silinemez; RLS ENABLE + FORCE", async () => {
    for (const stmt of [
      sql`update kliniva.notifications set title = 'hack'`,
      sql`update kliniva.notifications set recipient_user_id = ${A.users.docB!.id}`,
      sql`delete from kliniva.notifications`,
      sql`update kliniva.outbox_events set payload_safe = '{}'::jsonb`,
      sql`delete from kliniva.outbox_events`,
      sql`delete from kliniva.notification_preferences`,
    ]) {
      expect((await dbError(runInTenant(A.id, (s) => s.tx.execute(stmt)))).code).toBe("42501");
    }
    // Sahip rolü bile içerik değiştiremez (tetikleyici)
    const n =
      (await notesOf("docA"))[0] ??
      (await runInTenant(A.id, (s) => s.tx.select().from(notifications).limit(1)))[0];
    const err = await dbError(
      getMigrationDb().execute(sql`update kliniva.notifications set title = 'x' where id = ${n!.id}`),
    );
    expect(err.message).toMatch(/KLINIVA_IMMUTABLE/);
    const NEW = ["notifications", "notification_preferences", "outbox_events"];
    const r = await getPool().query(
      `select c.relname, c.relrowsecurity e, c.relforcerowsecurity f from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'kliniva' and c.relname = any($1)`,
      [NEW],
    );
    expect(r.rowCount).toBe(3);
    for (const row of r.rows) expect([row.relname, row.e, row.f]).toEqual([row.relname, true, true]);
    for (const t of NEW)
      expect((await getPool().query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
    const c = await getPool().connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.tenant_id', $1, true)", [B.id]);
      for (const t of NEW) {
        expect((await c.query(`select 1 from kliniva.${t} where tenant_id = $1`, [A.id])).rowCount, t).toBe(
          0,
        );
      }
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });

  it("POOLED_CONNECTION_TENANT_CONTEXT_LEAK_TEST (bildirim / outbox tabloları)", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const c1: PoolClient = await pool.connect();
      await c1.query("begin");
      await c1.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      expect((await c1.query("select count(*)::int n from kliniva.notifications")).rows[0].n).toBeGreaterThan(
        0,
      );
      expect((await c1.query("select count(*)::int n from kliniva.outbox_events")).rows[0].n).toBeGreaterThan(
        0,
      );
      await c1.query("commit");
      c1.release();
      const c2 = await pool.connect();
      expect(c2).toBe(c1);
      expect((await c2.query("select current_setting('app.tenant_id', true) as v")).rows[0]?.v ?? "").toBe(
        "",
      );
      for (const t of ["notifications", "notification_preferences", "outbox_events"]) {
        expect((await c2.query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
      }
      c2.release();
    } finally {
      await pool.end();
    }
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const ctx = i % 2 ? B.users.owner!.ctx : A.users.owner!.ctx;
        return tenantQuery(ctx, async (scope) => ({
          expected: ctx.tenantId,
          rows: (
            await scope.tx.execute<{ tenant_id: string }>(sql`select tenant_id from kliniva.notifications`)
          ).rows,
        }));
      }),
    );
    for (const s of seen) expect(s.rows.every((r) => r.tenant_id === s.expected)).toBe(true);
  });
});

// ================================================================ SSE
type Sse = { events: { event: string; data: Record<string, unknown> }[]; close: () => Promise<void> };

function streamRequest(token: string | null, query = ""): { req: Request; ac: AbortController } {
  const ac = new AbortController();
  const headers: Record<string, string> = { host: "localhost:3000" };
  if (token) headers.cookie = `kliniva_session=${encodeURIComponent(token)}`;
  return {
    req: new Request(`http://localhost:3000/api/v1/notifications/stream${query}`, {
      headers,
      signal: ac.signal,
    }),
    ac,
  };
}

function collect(res: Response, ac: AbortController): Sse {
  const events: Sse["events"] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) {
        events.push({ event: "__closed", data: {} });
        return;
      }
      buf += dec.decode(r.value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : {} });
      }
    }
  })();
  return {
    events,
    close: async () => {
      ac.abort();
      await reader.cancel().catch(() => undefined);
      await pump;
    },
  };
}
async function waitFor(pred: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("Realtime (SSE)", () => {
  it("oturumdan alıcı: ?userId= yok sayılır; doktor kendi sinyalini alır; başka kullanıcı / kiracı almaz; içerik yok", async () => {
    const docA = A.users.docA!;
    const recep = A.users.reception!;
    const a = streamRequest(docA.token, `?userId=${recep.id}&tenantId=${B.id}`);
    const sDoc = collect(await streamRoute(a.req), a.ac);
    const r = streamRequest(recep.token, `?userId=${docA.id}`);
    const sRecep = collect(await streamRoute(r.req), r.ac);
    const b = streamRequest(B.users.docX!.token);
    const sB = collect(await streamRoute(b.req), b.ac);
    try {
      expect(await waitFor(() => sDoc.events.some((e) => e.event === "ready"))).toBe(true);
      const id = await book({ date: monday(6), time: "09:00" });
      await drain();
      expect(await waitFor(() => sDoc.events.some((e) => e.event === "notification"))).toBe(true);
      const n = (await notificationsFor(id)).find((x) => x.recipientUserId === docA.id)!;
      // Aynı işleme turunda başka olaylar da işlenebilir → sinyal bildirim kimliğiyle eşleştirilir.
      expect(await waitFor(() => sDoc.events.some((e) => e.data.notificationId === n.id))).toBe(true);
      const sig = sDoc.events.find((e) => e.data.notificationId === n.id)!.data;
      expect(Object.keys(sig).sort()).toEqual(["createdAt", "notificationId", "severity", "type"]);
      expect(sig.type).toBe("APPOINTMENT_CREATED");
      await new Promise((res) => setTimeout(res, 300));
      // Doktorun bildirimleri başka kullanıcının / kiracının akışına ASLA düşmez.
      const docIds = new Set(
        (
          await runInTenant(A.id, (s2) =>
            s2.tx
              .select({ id: notifications.id })
              .from(notifications)
              .where(eq(notifications.recipientUserId, docA.id)),
          )
        ).map((x) => x.id),
      );
      expect(sRecep.events.some((e) => docIds.has(e.data.notificationId as string))).toBe(false);
      expect(sB.events.some((e) => e.event === "notification")).toBe(false);
    } finally {
      await Promise.all([sDoc.close(), sRecep.close(), sB.close()]);
    }
    // oturumsuz → 401
    const anon = await streamRoute(streamRequest(null).req);
    expect(anon.status).toBe(401);
  });

  it("kalp atışında oturum yeniden doğrulanır: çıkış → akış kapanır; kopmada abonelik temizlenir", async () => {
    const { token, ctx } = await loginFresh();
    const s = streamRequest(token);
    const sse = collect(await openNotificationStream(s.req, { heartbeatMs: 150 }), s.ac);
    expect(await waitFor(() => sse.events.some((e) => e.event === "heartbeat"))).toBe(true);
    await logout(token, ctx.meta);
    expect(await waitFor(() => sse.events.some((e) => e.event === "__closed"))).toBe(true);
    expect(sse.events.some((e) => e.event === "end")).toBe(true);
    await sse.close();
  });
});

/** Çıkış testi için ayrı oturum (fikstür oturumunu bozmamak için) — aynı kullanıcı, yeni token. */
async function loginFresh() {
  const { createSession } = await import("@/server/auth/session");
  const { authenticate } = await import("@/server/auth/context");
  const { token } = await createSession({
    tenantId: A.id,
    userId: A.users.docB!.id,
    state: "ACTIVE",
    meta: { ipHash: null, userAgentSummary: null },
  });
  const ctx = (await authenticate(token, { ipHash: null, userAgentSummary: null }))!;
  return { token, ctx };
}

// ================================================================ doktor onayı
describe("Doktor randevu onayı", () => {
  it("AUTO_ACCEPT → BOOKED; DOCTOR_APPROVAL → PENDING_APPROVAL slot (doktor / oda / hasta) tutar", async () => {
    const date = monday(7);
    const auto = await book({ date, time: "08:00" });
    expect((await listMyPendingApprovals(A.users.docA!.ctx)).some((x) => x.id === auto)).toBe(false);
    await upsertClinicProfile(owner(), {
      displayName: "Onay Klinik",
      appointmentApprovalMode: "DOCTOR_APPROVAL",
    });
    const pending = await book({ date, time: "09:00", room: R1, patient: P[2]! });
    const mine = await listMyPendingApprovals(A.users.docA!.ctx);
    expect(mine.find((x) => x.id === pending)?.status).toBe("PENDING_APPROVAL");
    expect(await code(book({ date, time: "09:00", patient: P[3]! }))).toBe("APPOINTMENT_CONFLICT");
    expect(await code(book({ doctor: D2, date, time: "09:00", room: R1, patient: P[3]! }))).toBe(
      "ROOM_APPOINTMENT_CONFLICT",
    );
    expect(await code(book({ doctor: D2, date, time: "09:00", patient: P[2]! }))).toBe(
      "PATIENT_APPOINTMENT_CONFLICT",
    );
    await drain();
    expect(
      (await notificationsFor(pending))
        .filter((n) => n.type === "APPOINTMENT_APPROVAL_REQUIRED")
        .map((n) => n.recipientUserId),
    ).toEqual([A.users.docA!.id]);

    // güvenlik: başka doktor NOT_FOUND; resepsiyon FORBIDDEN; kiracı B NOT_FOUND
    expect(await code(approveAppointment(A.users.docB!.ctx, pending))).toBe("NOT_FOUND");
    expect(await code(declineAppointment(A.users.docB!.ctx, pending))).toBe("NOT_FOUND");
    expect(await code(approveAppointment(reception(), pending))).toBe("FORBIDDEN");
    expect(await code(approveAppointment(B.users.docX!.ctx, pending))).toBe("NOT_FOUND");
    // sahip izne sahip ama doktor kaydı yok → NOT_FOUND (başka doktor adına onay yok)
    expect(await code(approveAppointment(owner(), pending))).toBe("NOT_FOUND");

    await approveAppointment(A.users.docA!.ctx, pending);
    expect(await code(approveAppointment(A.users.docA!.ctx, pending))).toBe("INVALID_STATUS_TRANSITION");
    await drain();
    expect(
      (await notesOf("reception", "APPOINTMENT_APPROVED")).some((n) => n.href === `/appointments/${pending}`),
    ).toBe(true);
    expect((await audits("APPOINTMENT_APPROVED")).some((a) => a.entityId === pending)).toBe(true);

    // Ret → CANCELLED, slot yeniden müsait
    const p2 = await book({ date, time: "10:00", patient: P[4]! });
    await declineAppointment(A.users.docA!.ctx, p2);
    expect(await code(declineAppointment(A.users.docA!.ctx, p2))).toBe("INVALID_STATUS_TRANSITION");
    expect(await code(book({ date, time: "10:00", patient: P[5]! }))).toBe("OK");
    await drain();
    expect(
      (await notesOf("reception", "APPOINTMENT_DECLINED")).some((n) => n.href === `/appointments/${p2}`),
    ).toBe(true);
    // DB: PENDING_APPROVAL → CHECKED_IN geçişi yok
    const p3 = await book({ date, time: "11:00", patient: P[6]! });
    expect(await code(updateAppointmentStatus(reception(), p3, { status: "CHECKED_IN" }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    await upsertClinicProfile(owner(), {
      displayName: "Onay Klinik",
      appointmentApprovalMode: "AUTO_ACCEPT",
    });
    await drain();
  });

  it("DB son savunma: iki eşzamanlı onay bekleyen randevu aynı slot için → 1 başarılı (exclusion constraint)", async () => {
    await upsertClinicProfile(owner(), {
      displayName: "Onay Klinik",
      appointmentApprovalMode: "DOCTOR_APPROVAL",
    });
    const date = monday(8);
    const results = await Promise.all(
      P.slice(0, 10).map((p) => code(book({ date, time: "09:30", patient: p }))),
    );
    expect(tally(results)).toEqual({ OK: 1, APPOINTMENT_CONFLICT: 9 });
    await upsertClinicProfile(owner(), {
      displayName: "Onay Klinik",
      appointmentApprovalMode: "AUTO_ACCEPT",
    });
    await drain();
  }, 120_000);
});

// ================================================================ stok uyarıları
describe("Stok / SKT / geri çağırma uyarıları", () => {
  it("LOW_STOCK eşik geçişi: 6 → 4 bir; 4 → 3 yok; 3 → 10 sıfırlar; 10 → 5 yeni", async () => {
    const item = (
      await createInventoryItem(owner(), { name: "Uyarı Punch", code: "S6-LOW", minimumStockLevel: "5" })
    ).id;
    await addStock(owner(), { inventoryItemId: item, locationId: WH, quantity: "6", kind: "INITIAL_STOCK" });
    const out = (q: string) =>
      adjustStock(owner(), {
        inventoryItemId: item,
        locationId: WH,
        direction: "OUT",
        quantity: q,
        reason: "Kullanım",
      });
    const lows = async () => (await outboxFor(item)).filter((e) => e.eventType === "STOCK_LOW").length;
    await out("2");
    expect(await lows()).toBe(1);
    await out("1");
    expect(await lows()).toBe(1);
    await addStock(owner(), { inventoryItemId: item, locationId: WH, quantity: "7" });
    expect(await lows()).toBe(1);
    await out("5");
    expect(await lows()).toBe(2);
    await drain();
    const inv = (await notesOf("invmgr", "LOW_STOCK")).filter((n) => n.href === `/inventory/items/${item}`);
    expect(inv).toHaveLength(2);
    expect(inv[0]!.body).toMatch(/Uyarı Punch · Depo: kullanılabilir \d+ \(asgari 5\)\./);
    for (const who of ["admin", "owner"] as const)
      expect((await notesOf(who, "LOW_STOCK")).length).toBeGreaterThanOrEqual(2);
    expect(await notesOf("docA", "LOW_STOCK")).toEqual([]);
    expect(await notesOf("reception", "LOW_STOCK")).toEqual([]);
    expect((await audits("LOW_STOCK_NOTIFICATION_CREATED")).length).toBeGreaterThanOrEqual(2);
  });

  it("OUT_OF_STOCK: 1 → 0 bir; 0 → 0 (sayım farksız) yinelenmez", async () => {
    const item = (await createInventoryItem(owner(), { name: "Uyarı Kit", code: "S6-OUT" })).id;
    await addStock(owner(), { inventoryItemId: item, locationId: WH, quantity: "1", kind: "INITIAL_STOCK" });
    await adjustStock(owner(), {
      inventoryItemId: item,
      locationId: WH,
      direction: "OUT",
      quantity: "1",
      reason: "Fire",
    });
    await recordPhysicalCount(owner(), {
      inventoryItemId: item,
      locationId: WH,
      countedQuantity: "0",
      apply: true,
    });
    expect(
      await code(
        adjustStock(owner(), {
          inventoryItemId: item,
          locationId: WH,
          direction: "OUT",
          quantity: "1",
          reason: "Tekrar",
        }),
      ),
    ).toBe("INSUFFICIENT_STOCK");
    expect((await outboxFor(item)).map((e) => e.eventType)).toEqual(["STOCK_OUT"]);
    await drain();
    expect(
      (await notesOf("invmgr", "OUT_OF_STOCK")).filter((n) => n.href === `/inventory/items/${item}`),
    ).toHaveLength(1);
  });

  it("SKT: pencereye giriş bir kez; tekrar tarama yinelenmez; süresi geçen bir kez; miktarı 0 lot bildirilmez; geri çağırma bir kez (gerekçesiz)", async () => {
    seq++;
    const item = (
      await createInventoryItem(owner(), {
        name: `SKT ürün ${seq}`,
        code: `S6-EXP-${seq}`,
        trackLots: true,
        trackExpiry: true,
      })
    ).id;
    const lotIn = async (n: string, exp: string, q: string) =>
      (
        await addStock(owner(), {
          inventoryItemId: item,
          locationId: WH,
          quantity: q,
          lotNumber: n,
          expiryDate: exp,
        })
      ).stockLotId!;
    const soon = await lotIn("EXP-SOON", day(5), "3");
    const past = await lotIn("EXP-PAST", day(-2), "2");
    const later = await lotIn("EXP-LATER", day(300), "2");
    const s1 = await scanExpiryNotifications({ tenantIds: [A.id] });
    expect([s1.expiringQueued, s1.expiredQueued]).toEqual([1, 1]);
    const s2 = await scanExpiryNotifications({ tenantIds: [A.id] });
    expect([s2.expiringQueued, s2.expiredQueued]).toEqual([0, 0]);
    expect(await outboxFor(later)).toEqual([]);
    await drain();
    expect(
      (await notesOf("invmgr", "LOT_EXPIRING_SOON")).filter((n) => n.href === `/inventory/lots/${soon}`),
    ).toHaveLength(1);
    expect(
      (await notesOf("invmgr", "LOT_EXPIRED")).filter((n) => n.href === `/inventory/lots/${past}`),
    ).toHaveLength(1);
    expect((await notesOf("invmgr", "LOT_EXPIRED"))[0]!.body).toMatch(
      /Lot EXP-PAST · SKT \d\d\.\d\d\.\d{4} · Depo/,
    );
    expect((await audits("EXPIRY_NOTIFICATION_CREATED")).length).toBeGreaterThanOrEqual(2);

    const SECRET = "Gizli-gerekce-55";
    await recallLot(owner(), { stockLotId: soon, reason: `${SECRET} kontaminasyon` });
    expect((await outboxFor(soon)).filter((e) => e.eventType === "LOT_RECALLED")).toHaveLength(1);
    await drain();
    for (const who of ["owner", "admin", "invmgr"] as const) {
      const rec = (await notesOf(who, "LOT_RECALLED")).filter((n) => n.href === `/inventory/lots/${soon}`);
      expect(rec, who).toHaveLength(1);
      expect(JSON.stringify(rec)).not.toContain(SECRET);
    }
    expect(await notesOf("docA", "LOT_RECALLED")).toEqual([]);
    expect((await audits("LOT_RECALL_NOTIFICATION_CREATED")).length).toBeGreaterThanOrEqual(1);
    // Geri çağrılmış lot SKT taramasında artık bildirim üretmez; miktarı 0 lot da.
    expect((await scanExpiryNotifications({ tenantIds: [A.id] })).expiringQueued).toBe(0);
  });
});

// ================================================================ gizlilik
describe("Gizlilik", () => {
  it("tüm outbox yükleri ve bildirim metinleri hasta adı / telefon / not içermez", async () => {
    const ev = await runInTenant(A.id, (s) => s.tx.select().from(outboxEvents));
    const ns = await runInTenant(A.id, (s) => s.tx.select().from(notifications));
    const dump =
      JSON.stringify(ev.map((e) => e.payloadSafe)) +
      JSON.stringify(ns.map((n) => [n.title, n.bodySafe, n.metadataSafe]));
    expect(dump).not.toMatch(/Bildirim\d|Hastası|0539\d|özel sebep/);
  });
});

// ================================================================ DB havuzu yük testi
describe("DB havuzu yük testi (outbox + SSE + randevu + stok aynı anda)", () => {
  it("DB_POOL_MAX=3: zaman aşımı 0; sonuçlar doğru", async () => {
    const pool = getPool();
    const maxConfigured = (pool as unknown as { options: { max: number } }).options.max;
    let peakTotal = 0;
    let peakWaiting = 0;
    const sampler = setInterval(() => {
      peakTotal = Math.max(peakTotal, pool.totalCount);
      peakWaiting = Math.max(peakWaiting, pool.waitingCount);
    }, 2);
    const date = monday(9);
    const item = (
      await createInventoryItem(owner(), { name: "Havuz ürün", code: "S6-POOL", minimumStockLevel: "3" })
    ).id;
    await addStock(owner(), { inventoryItemId: item, locationId: WH, quantity: "10", kind: "INITIAL_STOCK" });
    const streams = await Promise.all(
      (["docA", "docB", "reception", "invmgr", "admin"] as const).map(async (u) => {
        const s = streamRequest(A.users[u]!.token);
        return collect(await openNotificationStream(s.req, { heartbeatMs: 200 }), s.ac);
      }),
    );
    let all: string[] = [];
    try {
      all = await Promise.all([
        ...P.slice(0, 15).map((p) => code(book({ date, time: "12:00", patient: p }))),
        ...Array.from({ length: 15 }, () =>
          code(
            adjustStock(owner(), {
              inventoryItemId: item,
              locationId: WH,
              direction: "OUT",
              quantity: "1",
              reason: "Yük",
            }),
          ),
        ),
        ...Array.from({ length: 6 }, () => code(process6({ batchSize: 5 }))),
        ...(["docA", "docB", "reception", "invmgr"] as const).map((u) =>
          code(listNotifications(A.users[u]!.ctx, { limit: 25 })),
        ),
      ]);
      await drain();
    } finally {
      clearInterval(sampler);
      await Promise.all(streams.map((s) => s.close()));
    }
    const timeouts = all.filter((r) => /timeout/i.test(r)).length;
    const appt = tally(all.slice(0, 15));
    const stock = tally(all.slice(15, 30));
    writeFileSync(
      join(tmpdir(), "kliniva-pool-load-s6.json"),
      JSON.stringify({
        maxConfigured,
        peakTotal,
        peakWaiting,
        timeouts,
        appt,
        stock,
        streams: streams.length,
      }),
    );
    expect(timeouts).toBe(0);
    expect(all.filter((r) => r.startsWith("UNEXPECTED"))).toEqual([]);
    expect(peakTotal).toBeLessThanOrEqual(maxConfigured);
    expect(appt).toEqual({ OK: 1, APPOINTMENT_CONFLICT: 14 });
    expect(stock).toEqual({ OK: 10, INSUFFICIENT_STOCK: 5 });
    // 10 → 0: tek LOW (3'e iniş) + tek OUT (0'a iniş)
    expect((await outboxFor(item)).map((e) => e.eventType).sort()).toEqual(["STOCK_LOW", "STOCK_OUT"]);
  }, 180_000);
});
