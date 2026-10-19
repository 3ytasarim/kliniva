import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLogs, notifications, outboxEvents, patientTasks } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant } from "@/server/tenant/tenant-query";
import { createPatient } from "@/server/services/patients";
import {
  closeTask,
  createTask,
  editTask,
  getMyTaskCounts,
  listAssignableUsers,
  listTasks,
} from "@/server/services/tasks";
import { processOutboxBatch } from "@/server/notifications/outbox";
import { addDays, dateInZone } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Sprint 8.3 — hasta görevleri: atama kuralı (şube + task.read), görünürlük (kendi / yönetici / şube), kapatma
 * (geri açılmaz), şifreli başlık (audit / bildirimde yok), TASK_ASSIGNED bildirimi ve DB değişmezliği.
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let P: string;
const today = () => dateInZone(new Date(), TZ);
const SECRET = "Patoloji sonucunu paylaş";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION", branch: "A" },
    recB: { role: "RECEPTION", branch: "B" },
    doc: { role: "DOCTOR" },
    stock: { role: "INVENTORY_MANAGER" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  P = (
    await createPatient(A.users.owner!.ctx, {
      firstName: "Gorev",
      lastName: "Hasta",
      phone: "05391120001",
      branchId: A.branchA,
    })
  ).id;
}, 120_000);

afterAll(cleanupTenants);

const base = () => ({
  patientId: P,
  taskType: "OUTGOING_CALL",
  title: SECRET,
  dueDate: addDays(today(), 1),
  dueTime: "10:00",
});

describe("Hasta görevleri", () => {
  it("atama: yalnızca şubede görev görebilen aktif kullanıcıya; başkasına atanınca bildirim (başlık / hasta yok)", async () => {
    const rec = A.users.reception!.ctx;
    const assignable = (await listAssignableUsers(rec, A.branchA)).map((u) => u.id);
    expect(assignable).toEqual(
      expect.arrayContaining([A.users.doc!.id, A.users.reception!.id, A.users.owner!.id]),
    );
    expect(assignable).not.toContain(A.users.recB!.id); // B şubesi rolü
    expect(assignable).not.toContain(A.users.stock!.id); // task.read yok
    expect(await code(createTask(rec, { ...base(), assigneeUserId: A.users.recB!.id }))).toBe("VALIDATION");
    expect(await code(createTask(rec, { ...base(), assigneeUserId: B.users.owner!.id }))).toBe("VALIDATION");
    expect(await code(createTask(A.users.stock!.ctx, { ...base(), assigneeUserId: A.users.stock!.id }))).toBe(
      "FORBIDDEN",
    );

    const t = await createTask(rec, { ...base(), notes: "Sonuç: benign", assigneeUserId: A.users.doc!.id });
    await createTask(rec, { ...base(), title: "Kendime not", assigneeUserId: A.users.reception!.id });
    const events = await runInTenant(A.id, (s) =>
      s.tx.select().from(outboxEvents).where(eq(outboxEvents.eventType, "TASK_ASSIGNED")),
    );
    expect(events).toHaveLength(1); // kendine atama bildirim üretmez
    await processOutboxBatch({ tenantIds: [A.id] });
    const ns = await runInTenant(A.id, (s) =>
      s.tx.select().from(notifications).where(eq(notifications.type, "TASK_ASSIGNED")),
    );
    expect(ns.map((n) => [n.recipientUserId, n.title, n.entityId])).toEqual([
      [A.users.doc!.id, "Size görev atandı", t.id],
    ]);
    expect(ns[0]!.bodySafe).toMatch(/Giden arama/);
    expect(JSON.stringify(ns)).not.toMatch(/Patoloji|Gorev|benign/);
  });

  it("görünürlük: doktor yalnızca kendi görevlerini, resepsiyon şubesindekileri görür; B şubesi göremez / kapatamaz", async () => {
    const doc = A.users.doc!.ctx;
    const mine = await listTasks(doc, { scope: "mine" });
    expect(mine.map((t) => t.title)).toEqual([SECRET]);
    expect(mine[0]).toMatchObject({ notes: "Sonuç: benign", patientName: "Gorev Hasta", canUpdate: true });
    expect((await listTasks(doc, { scope: "all" })).map((t) => t.title)).toEqual([SECRET]);
    const recAll = await listTasks(A.users.reception!.ctx, { scope: "all" });
    expect(recAll).toHaveLength(2);
    const recB = A.users.recB!.ctx;
    expect(await listTasks(recB, { scope: "all" })).toEqual([]);
    expect(await code(closeTask(recB, mine[0]!.id, { status: "DONE" }))).toBe("NOT_FOUND");
    expect(await code(listTasks(B.users.owner!.ctx, { patientId: P }))).toBe("NOT_FOUND");
  });

  it("kapatma: atanan kişi sonuçlandırır; kapanan görev değişmez; sayaçlar; düzenle / yeniden ata bildirimi", async () => {
    const doc = A.users.doc!.ctx;
    const rec = A.users.reception!.ctx;
    const [t] = await listTasks(doc, { scope: "mine" });
    await closeTask(doc, t!.id, { status: "UNREACHABLE", result: "Telefon kapalı" });
    expect(await code(closeTask(doc, t!.id, { status: "DONE" }))).toBe("CONFLICT");
    expect(await code(editTask(rec, t!.id, { title: "Yeni başlık" }))).toBe("CONFLICT");
    const done = await listTasks(doc, { scope: "mine", view: "done" });
    expect(done[0]).toMatchObject({ status: "UNREACHABLE", result: "Telefon kapalı", canUpdate: false });

    // Geciken görev + sayaçlar
    const late = await createTask(rec, {
      ...base(),
      title: "Dünkü arama",
      dueDate: addDays(today(), -1),
      assigneeUserId: A.users.doc!.id,
    });
    expect(await getMyTaskCounts(doc)).toMatchObject({ open: 1, overdue: 1 });
    expect((await listTasks(doc, { scope: "mine", view: "overdue" })).map((x) => x.id)).toEqual([late.id]);
    // Yeniden atama → yeni kişiye bildirim olayı; eski atanan artık göremez
    await editTask(rec, late.id, { assigneeUserId: A.users.owner!.id, dueDate: today(), dueTime: "23:59" });
    expect(await getMyTaskCounts(doc)).toMatchObject({ open: 0 });
    const ev = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.eventType, "TASK_ASSIGNED"), eq(outboxEvents.aggregateId, late.id))),
    );
    expect(ev.map((e) => (e.payloadSafe as { assigneeUserId: string }).assigneeUserId)).toEqual([
      A.users.doc!.id,
      A.users.owner!.id,
    ]);

    // Şifreli başlık; audit'te başlık / not / sonuç yok
    const raw = await runInTenant(A.id, (s) => s.tx.select().from(patientTasks));
    expect(JSON.stringify(raw)).not.toMatch(/Patoloji|benign|Telefon kapalı|Dünkü/);
    const audits = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(sql`${auditLogs.action} like 'PATIENT_TASK_%'`),
    );
    expect(audits.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(audits)).not.toMatch(/Patoloji|benign|Telefon kapalı|Dünkü/);
  });

  it("DB: silinemez, kapanan görev ve kimlik sütunları değişmez; RLS", async () => {
    const [closed] = await runInTenant(A.id, (s) =>
      s.tx.select().from(patientTasks).where(eq(patientTasks.status, "UNREACHABLE")),
    );
    expect(
      (
        await dbError(
          runInTenant(A.id, (s) => s.tx.delete(patientTasks).where(eq(patientTasks.id, closed!.id))),
        )
      ).code,
    ).toBe("42501");
    const reopen = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .update(patientTasks)
          .set({ status: "OPEN", completedAt: null, completedByUserId: null })
          .where(eq(patientTasks.id, closed!.id)),
      ),
    );
    expect(reopen.message).toMatch(/KLINIVA_IMMUTABLE/);
    const [open] = await runInTenant(A.id, (s) =>
      s.tx.select().from(patientTasks).where(eq(patientTasks.status, "OPEN")),
    );
    const other = (
      await createPatient(A.users.owner!.ctx, {
        firstName: "Baska",
        lastName: "Hasta",
        phone: "05391120002",
        branchId: A.branchA,
      })
    ).id;
    const moved = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.update(patientTasks).set({ patientId: other }).where(eq(patientTasks.id, open!.id)),
      ),
    );
    expect(moved.message).toMatch(/KLINIVA_IMMUTABLE/);
    const fromB = await runInTenant(B.id, (s) =>
      s.tx.execute<{ n: number }>(
        sql`select count(*)::int n from kliniva.patient_tasks where tenant_id = ${A.id}`,
      ),
    );
    expect(fromB.rows[0]!.n).toBe(0);
  });
});
