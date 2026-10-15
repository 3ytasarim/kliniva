import "server-only";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import {
  appointments,
  clinicalServices,
  inventoryItems,
  inventoryLocations,
  outboxEvents,
  stockLots,
} from "@/server/db/schema";
import { AppError, isAppError } from "@/server/errors";
import { writeAudit, type AuditAction, type AuditActor } from "@/server/audit/audit";
import { actorOf, requirePermission, type AuthContext } from "@/server/auth/authz";
import {
  afterCommit,
  tenantQuery,
  tenantWhere,
  withSavepoint,
  type TenantScope,
} from "@/server/tenant/tenant-query";
import { outboxReadyTenantIds } from "@/server/tenant/system";
import { logger } from "@/server/log/logger";
import { uuidSchema } from "@/server/validation";
import {
  SEVERITY_OF,
  TYPE_LABELS,
  assertSafeText,
  timeOnly,
  whenLabel,
  type NotificationType,
} from "@/server/notifications/catalog";
import { resolveNotificationRecipients } from "@/server/notifications/recipients";
import {
  InAppNotificationChannel,
  type NotificationChannel,
  type NotificationMessage,
} from "@/server/notifications/channels";

/**
 * TRANSACTIONAL OUTBOX
 *
 *  Üretim: iş olayı ile AYNI transaction'da `enqueueOutbox(scope, …)` → iş geri alınırsa olay da yoktur; iş
 *  başarılıysa olay kaybolmaz. Yük yalnızca güvenli kimlik / kısa kod / zaman (hasta adı, telefon, not YOK).
 *
 *  İşleme: `processOutboxBatch()` — kiracı keşfi `kliniva.outbox_ready_tenants()` (yalnızca kimlik), sonra HER kiracı
 *  kendi RLS bağlamında: `SELECT … FOR UPDATE SKIP LOCKED LIMIT n` → aynı olayı iki işçi aynı anda işleyemez (satır
 *  kilidi transaction boyunca "işleniyor" talebidir; işçi çökerse kilit düşer, olay PENDING kalır). Her olay ayrı
 *  SAVEPOINT'te: biri başarısız olursa yalnızca o geri alınır.
 *
 *  Garanti: EN AZ BİR KEZ (exactly-once iddiası yok). Bildirimler tekilleştirme anahtarıyla idempotenttir → tekrar
 *  işleme yinelenen bildirim üretmez.
 *
 *  Yeniden deneme: başarısızlıkta attempt_count + 1, available_at ileri (1 / 5 / 15 / 60 dk); 5. denemeden sonra
 *  FAILED (+ OUTBOX_FAILED audit). DB'ye yalnızca güvenli hata KODU yazılır (mesaj / yığın izi / sır yok). İş
 *  transaction'ı geri alınmaz.
 */
export const OUTBOX_EVENT_TYPES = [
  "APPOINTMENT_CREATED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_CONFIRMED",
  "APPOINTMENT_CHECKED_IN",
  "APPOINTMENT_APPROVAL_REQUESTED",
  "APPOINTMENT_APPROVED",
  "APPOINTMENT_DECLINED",
  "STOCK_LOW",
  "STOCK_OUT",
  "LOT_EXPIRING_SOON",
  "LOT_EXPIRED",
  "LOT_RECALLED",
  "DOCUMENT_INTEGRITY_FAILED",
] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];
export type OutboxPayload = Record<string, string | number | boolean | null>;

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BACKOFF_MINUTES = [1, 5, 15, 60] as const;

const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  source: "SYSTEM",
  meta: { ipHash: null, userAgentSummary: null },
};

const autoProcess = () => process.env.OUTBOX_AUTOPROCESS !== "off";

/**
 * Olayı iş transaction'ına ekler. deduplicationKey verilirse aynı anahtarlı ikinci olay sessizce yok sayılır
 * (ör. SKT taraması). Commit sonrası (varsa) işlemci dürtülür.
 */
export async function enqueueOutbox(
  scope: TenantScope,
  e: {
    eventType: OutboxEventType;
    aggregateType: string;
    aggregateId: string;
    payload: OutboxPayload;
    deduplicationKey?: string;
  },
): Promise<{ id: string } | null> {
  const [row] = await scope.tx
    .insert(outboxEvents)
    .values({
      tenantId: scope.tenantId,
      eventType: e.eventType,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      payloadSafe: e.payload,
      deduplicationKey: e.deduplicationKey ?? null,
    })
    .onConflictDoNothing({ target: [outboxEvents.tenantId, outboxEvents.deduplicationKey] })
    .returning({ id: outboxEvents.id });
  if (row) {
    const tenantId = scope.tenantId;
    afterCommit(scope, () => kickOutbox(tenantId));
  }
  return row ?? null;
}

// ---------------------------------------------------------------- dürtme (commit sonrası, süreç içi)

const g = globalThis as unknown as { __klinivaOutboxKick?: Map<string, "running" | "rerun"> };
const kickState: Map<string, "running" | "rerun"> = (g.__klinivaOutboxKick ??= new Map());

/** Commit sonrası hemen işleme (gerçek zamanlı bildirim). Kiracı başına tek eşzamanlı çalışma; kaçanı poller yakalar. */
export function kickOutbox(tenantId: string): void {
  if (!autoProcess()) return;
  const state = kickState.get(tenantId);
  if (state) {
    kickState.set(tenantId, "rerun");
    return;
  }
  kickState.set(tenantId, "running");
  setImmediate(async () => {
    try {
      do {
        kickState.set(tenantId, "running");
        await processOutboxBatch({ tenantIds: [tenantId] });
      } while (kickState.get(tenantId) === "rerun");
    } catch (e) {
      logger.error("outbox.kick_failed", { error: e });
    } finally {
      kickState.delete(tenantId);
    }
  });
}

// ---------------------------------------------------------------- işlemci

export type ProcessResult = {
  claimed: number;
  processed: number;
  retried: number;
  failed: number;
  notificationsCreated: number;
};

/** Hata → güvenli kod (mesaj / yığın izi DB'ye yazılmaz). */
export function safeErrorCode(e: unknown): string {
  if (isAppError(e)) return e.code;
  const msg = e instanceof Error ? e.message : "";
  return /^[A-Z][A-Z0-9_]{1,59}$/.test(msg) ? msg : "HANDLER_ERROR";
}

export function nextAttemptAt(attempt: number, now: Date): Date {
  const minutes = OUTBOX_BACKOFF_MINUTES[Math.min(Math.max(attempt, 1), OUTBOX_BACKOFF_MINUTES.length) - 1]!;
  return new Date(now.getTime() + minutes * 60_000);
}

export async function processOutboxBatch(
  opts: {
    batchSize?: number;
    tenantIds?: string[];
    tenantLimit?: number;
    channel?: NotificationChannel;
  } = {},
): Promise<ProcessResult> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? Number(process.env.OUTBOX_BATCH_SIZE ?? 25), 1), 200);
  const channel = opts.channel ?? new InAppNotificationChannel();
  const total: ProcessResult = { claimed: 0, processed: 0, retried: 0, failed: 0, notificationsCreated: 0 };
  let tenantIds = opts.tenantIds;
  if (!tenantIds) {
    tenantIds = await outboxReadyTenantIds(opts.tenantLimit ?? 50);
  }
  for (const tenantId of tenantIds) {
    if (!uuidSchema.safeParse(tenantId).success) continue;
    const r = await tenantQuery({ tenantId }, (scope) => processTenant(scope, batchSize, channel));
    total.claimed += r.claimed;
    total.processed += r.processed;
    total.retried += r.retried;
    total.failed += r.failed;
    total.notificationsCreated += r.notificationsCreated;
  }
  return total;
}

async function processTenant(scope: TenantScope, batchSize: number, channel: NotificationChannel) {
  const res: ProcessResult = { claimed: 0, processed: 0, retried: 0, failed: 0, notificationsCreated: 0 };
  // SKIP LOCKED: başka işçinin tuttuğu olaylar atlanır → aynı olay aynı anda iki kez işlenmez.
  const rows = await scope.tx
    .select()
    .from(outboxEvents)
    .where(
      tenantWhere(
        outboxEvents,
        scope,
        eq(outboxEvents.status, "PENDING"),
        lte(outboxEvents.availableAt, sql`now()`),
      ),
    )
    .orderBy(asc(outboxEvents.availableAt), asc(outboxEvents.createdAt))
    .limit(batchSize)
    .for("update", { skipLocked: true });
  res.claimed = rows.length;
  for (const row of rows) {
    const attempt = row.attemptCount + 1;
    try {
      const created = await withSavepoint(scope, (inner) => handleEvent(inner, row, channel));
      await scope.tx
        .update(outboxEvents)
        .set({ status: "PROCESSED", processedAt: new Date(), attemptCount: attempt, lastErrorCode: null })
        .where(tenantWhere(outboxEvents, scope, eq(outboxEvents.id, row.id)));
      res.processed++;
      res.notificationsCreated += created;
    } catch (e) {
      const code = safeErrorCode(e);
      const now = new Date();
      if (attempt >= OUTBOX_MAX_ATTEMPTS) {
        await scope.tx
          .update(outboxEvents)
          .set({ status: "FAILED", attemptCount: attempt, lastErrorCode: code })
          .where(tenantWhere(outboxEvents, scope, eq(outboxEvents.id, row.id)));
        await writeAudit(scope, SYSTEM_ACTOR, {
          action: "OUTBOX_FAILED",
          entityType: "outbox_event",
          entityId: row.id,
          metadata: { eventType: row.eventType, attempts: attempt, code },
        });
        res.failed++;
      } else {
        await scope.tx
          .update(outboxEvents)
          .set({ attemptCount: attempt, lastErrorCode: code, availableAt: nextAttemptAt(attempt, now) })
          .where(tenantWhere(outboxEvents, scope, eq(outboxEvents.id, row.id)));
        res.retried++;
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------- olay → bildirim

type Row = typeof outboxEvents.$inferSelect;
type Draft = {
  type: NotificationType;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  branchId: string | null;
  /** Alıcıdan bağımsız tekilleştirme tabanı; alıcı kimliği eklenir. */
  dedupBase: string;
  recipients: Parameters<typeof resolveNotificationRecipients>[1];
  audit?: AuditAction;
};

const str = (p: OutboxPayload, k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);

async function handleEvent(scope: TenantScope, row: Row, channel: NotificationChannel): Promise<number> {
  const draft = await buildDraft(scope, row);
  if (!draft) return 0;
  const recipients = await resolveNotificationRecipients(scope, draft.recipients);
  let created = 0;
  for (const userId of recipients) {
    const msg: NotificationMessage = {
      recipientUserId: userId,
      type: draft.type,
      severity: SEVERITY_OF[draft.type],
      title: assertSafeText(draft.title),
      bodySafe: draft.body ? assertSafeText(draft.body) : null,
      entityType: draft.entityType,
      entityId: draft.entityId,
      branchId: draft.branchId,
      deduplicationKey: `${draft.dedupBase}:${userId}`,
      metadataSafe: { outboxEventId: row.id },
    };
    const r = await channel.send(scope, msg);
    if (r.delivered) created++;
  }
  // Bildirim kaydının kendisi iz bırakır; audit yalnızca stok / SKT / geri çağırma özetinde (olay başına bir kez).
  if (draft.audit && created > 0) {
    await writeAudit(scope, SYSTEM_ACTOR, {
      action: draft.audit,
      entityType: draft.entityType ?? "inventory",
      entityId: draft.entityId,
      branchId: draft.branchId,
      metadata: { eventType: row.eventType, recipients: created, outboxEventId: row.id },
    });
  }
  return created;
}

async function appointmentInfo(scope: TenantScope, id: string) {
  const [a] = await scope.tx
    .select({
      id: appointments.id,
      branchId: appointments.branchId,
      doctorId: appointments.doctorId,
      createdBy: appointments.createdByUserId,
      start: appointments.scheduledStart,
      timezone: appointments.timezone,
      service: clinicalServices.name,
    })
    .from(appointments)
    .leftJoin(
      clinicalServices,
      and(
        eq(clinicalServices.id, appointments.serviceId),
        eq(clinicalServices.tenantId, appointments.tenantId),
      ),
    )
    .where(tenantWhere(appointments, scope, eq(appointments.id, id)));
  return a ?? null;
}

async function stockInfo(scope: TenantScope, itemId: string, locationId: string) {
  const [r] = await scope.tx
    .select({
      item: inventoryItems.name,
      location: inventoryLocations.name,
      branchId: inventoryLocations.branchId,
    })
    .from(inventoryItems)
    .innerJoin(
      inventoryLocations,
      and(eq(inventoryLocations.tenantId, inventoryItems.tenantId), eq(inventoryLocations.id, locationId)),
    )
    .where(tenantWhere(inventoryItems, scope, eq(inventoryItems.id, itemId)));
  return r ?? null;
}

async function lotInfo(scope: TenantScope, lotId: string) {
  const [r] = await scope.tx
    .select({
      lotNumber: stockLots.lotNumber,
      expiryDate: stockLots.expiryDate,
      quantity: stockLots.quantity,
      recalledAt: stockLots.recalledAt,
      itemId: stockLots.inventoryItemId,
      item: inventoryItems.name,
      location: inventoryLocations.name,
      branchId: inventoryLocations.branchId,
    })
    .from(stockLots)
    .innerJoin(
      inventoryItems,
      and(eq(inventoryItems.id, stockLots.inventoryItemId), eq(inventoryItems.tenantId, stockLots.tenantId)),
    )
    .innerJoin(
      inventoryLocations,
      and(
        eq(inventoryLocations.id, stockLots.locationId),
        eq(inventoryLocations.tenantId, stockLots.tenantId),
      ),
    )
    .where(tenantWhere(stockLots, scope, eq(stockLots.id, lotId)));
  return r ?? null;
}

const dmy = (d: string | null) => (d ? d.split("-").reverse().join(".") : "—");
const qty = (v: string | number | boolean | null | undefined) => String(Number(v ?? 0));

async function buildDraft(scope: TenantScope, row: Row): Promise<Draft | null> {
  const p = row.payloadSafe;
  const type = row.eventType as OutboxEventType;
  if (type.startsWith("APPOINTMENT_")) {
    const a = await appointmentInfo(scope, row.aggregateId);
    if (!a) return null; // randevu yasal imhayla silinmişse: bildirilecek bir şey yok
    const when = whenLabel(a.start.toISOString(), a.timezone);
    const service = a.service ? ` · ${a.service}` : "";
    const base = {
      entityType: "appointment",
      entityId: a.id,
      branchId: a.branchId,
    };
    const rcp = {
      doctorId: a.doctorId,
      createdByUserId: a.createdBy,
      actorUserId: str(p, "actorUserId"),
      branchIds: [a.branchId],
    };
    switch (type) {
      case "APPOINTMENT_CREATED":
        return {
          ...base,
          type: "APPOINTMENT_CREATED",
          title: TYPE_LABELS.APPOINTMENT_CREATED,
          body: `${when}${service}`,
          dedupBase: `appointment-created:${a.id}`,
          recipients: { type: "APPOINTMENT_CREATED", ...rcp },
        };
      case "APPOINTMENT_RESCHEDULED": {
        const oldStart = str(p, "oldStart");
        const from = oldStart ? `${timeOnly(oldStart, a.timezone)} → ` : "";
        return {
          ...base,
          type: "APPOINTMENT_RESCHEDULED",
          title: TYPE_LABELS.APPOINTMENT_RESCHEDULED,
          body: `${from}${when}${service}`,
          // Her taşıma ayrı bir olaydır (aynı randevu birden çok kez taşınabilir).
          dedupBase: `appointment-rescheduled:${row.id}`,
          recipients: { type: "APPOINTMENT_RESCHEDULED", ...rcp },
        };
      }
      case "APPOINTMENT_CANCELLED":
        return {
          ...base,
          type: "APPOINTMENT_CANCELLED",
          title: TYPE_LABELS.APPOINTMENT_CANCELLED,
          body: `${when}${service}`,
          dedupBase: `appointment-cancelled:${a.id}`,
          recipients: { type: "APPOINTMENT_CANCELLED", ...rcp },
        };
      case "APPOINTMENT_CONFIRMED":
        return {
          ...base,
          type: "APPOINTMENT_CONFIRMED",
          title: TYPE_LABELS.APPOINTMENT_CONFIRMED,
          body: `${when}${service}`,
          dedupBase: `appointment-confirmed:${a.id}`,
          recipients: { type: "APPOINTMENT_CONFIRMED", ...rcp },
        };
      case "APPOINTMENT_CHECKED_IN":
        return {
          ...base,
          type: "PATIENT_CHECKED_IN",
          title: TYPE_LABELS.PATIENT_CHECKED_IN,
          body: `${when} randevunuz`,
          dedupBase: `patient-checkin:${a.id}`,
          recipients: { type: "PATIENT_CHECKED_IN", ...rcp },
        };
      case "APPOINTMENT_APPROVAL_REQUESTED":
        return {
          ...base,
          type: "APPOINTMENT_APPROVAL_REQUIRED",
          title: TYPE_LABELS.APPOINTMENT_APPROVAL_REQUIRED,
          body: `${when}${service}`,
          dedupBase: `appointment-approval:${a.id}`,
          recipients: { type: "APPOINTMENT_APPROVAL_REQUIRED", ...rcp },
        };
      case "APPOINTMENT_APPROVED":
        return {
          ...base,
          type: "APPOINTMENT_APPROVED",
          title: TYPE_LABELS.APPOINTMENT_APPROVED,
          body: `${when}${service}`,
          dedupBase: `appointment-approved:${a.id}`,
          recipients: { type: "APPOINTMENT_APPROVED", ...rcp },
        };
      case "APPOINTMENT_DECLINED":
        return {
          ...base,
          type: "APPOINTMENT_DECLINED",
          title: TYPE_LABELS.APPOINTMENT_DECLINED,
          body: `${when}${service} — slot yeniden müsait.`,
          dedupBase: `appointment-declined:${a.id}`,
          recipients: { type: "APPOINTMENT_DECLINED", ...rcp },
        };
    }
  }
  if (type === "STOCK_LOW" || type === "STOCK_OUT") {
    const itemId = row.aggregateId;
    const locationId = str(p, "locationId");
    if (!locationId) return null;
    const s = await stockInfo(scope, itemId, locationId);
    if (!s) return null;
    const nType: NotificationType = type === "STOCK_OUT" ? "OUT_OF_STOCK" : "LOW_STOCK";
    return {
      type: nType,
      title: TYPE_LABELS[nType],
      body:
        type === "STOCK_OUT"
          ? `${s.item} · ${s.location}: kullanılabilir stok kalmadı.`
          : `${s.item} · ${s.location}: kullanılabilir ${qty(p.usable)} (asgari ${qty(p.minimum)}).`,
      entityType: "inventory_item",
      entityId: itemId,
      branchId: s.branchId,
      // Eşik geçişi başına bir olay (döngü = outbox olayı): 4 → 3 yeni olay üretmez (geçiş değil).
      dedupBase: `${type === "STOCK_OUT" ? "out-of-stock" : "low-stock"}:${itemId}:${locationId}:${row.id}`,
      recipients: { type: nType, branchIds: [s.branchId] },
      audit: "LOW_STOCK_NOTIFICATION_CREATED",
    };
  }
  if (type === "LOT_EXPIRING_SOON" || type === "LOT_EXPIRED") {
    const l = await lotInfo(scope, row.aggregateId);
    // Miktarı 0'a inmiş / geri çağrılmış lot için gereksiz bildirim üretilmez.
    if (!l || Number(l.quantity) <= 0 || l.recalledAt) return null;
    const nType: NotificationType = type;
    return {
      type: nType,
      title: TYPE_LABELS[nType],
      body: `${l.item} · Lot ${l.lotNumber} · SKT ${dmy(l.expiryDate)} · ${l.location}`,
      entityType: "stock_lot",
      entityId: row.aggregateId,
      branchId: l.branchId,
      dedupBase: `${type === "LOT_EXPIRED" ? "lot-expired" : "lot-expiring"}:${row.aggregateId}:${l.expiryDate}`,
      recipients: { type: nType, branchIds: [l.branchId] },
      audit: "EXPIRY_NOTIFICATION_CREATED",
    };
  }
  if (type === "LOT_RECALLED") {
    const l = await lotInfo(scope, row.aggregateId);
    if (!l) return null;
    const branchIds = (str(p, "branchIds") ?? l.branchId).split(",").filter(Boolean);
    return {
      type: "LOT_RECALLED",
      title: TYPE_LABELS.LOT_RECALLED,
      // Geri çağırma gerekçesi ASLA bildirime yazılmaz.
      body: `${l.item} · Lot ${l.lotNumber} — yeni kullanım ve transfer kapatıldı.`,
      entityType: "stock_lot",
      entityId: row.aggregateId,
      branchId: l.branchId,
      dedupBase: `lot-recalled:${row.aggregateId}`,
      recipients: { type: "LOT_RECALLED", branchIds },
      audit: "LOT_RECALL_NOTIFICATION_CREATED",
    };
  }
  if (type === "DOCUMENT_INTEGRITY_FAILED") {
    return {
      type: "DOCUMENT_INTEGRITY_FAILED",
      title: TYPE_LABELS.DOCUMENT_INTEGRITY_FAILED,
      // Belge içeriği / hasta adı YOK.
      body: "Bir hasta belgesinde bütünlük kontrolü başarısız oldu.",
      entityType: "patient_document",
      entityId: row.aggregateId,
      branchId: str(p, "branchId"),
      dedupBase: `doc-integrity:${row.aggregateId}:${str(p, "part") ?? "x"}`,
      recipients: { type: "DOCUMENT_INTEGRITY_FAILED" },
    };
  }
  throw new Error("UNKNOWN_EVENT_TYPE");
}

// ---------------------------------------------------------------- yönetim: başarısız olaylar

export type FailedOutboxItem = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  attemptCount: number;
  status: string;
  createdAt: Date;
  lastErrorCode: string | null;
};

/** Yalnızca sahip / yönetici (kiracı geneli). Ham yük / yığın izi / sır GÖSTERİLMEZ. */
function requireFailedEventsAdmin(ctx: AuthContext) {
  requirePermission(ctx, "notification.admin.read_failed_events");
  if (!ctx.branchScope.all) throw new AppError("FORBIDDEN");
}

export async function listFailedOutboxEvents(
  ctx: AuthContext,
  input: { page?: number; limit?: number } = {},
): Promise<{ items: FailedOutboxItem[]; total: number; page: number; limit: number }> {
  requireFailedEventsAdmin(ctx);
  const limit = Math.min(Math.max(Number(input.limit ?? 25) || 25, 1), 100);
  const page = Math.max(Number(input.page ?? 1) || 1, 1);
  return tenantQuery(ctx, async (scope) => {
    const where = tenantWhere(outboxEvents, scope, eq(outboxEvents.status, "FAILED"));
    const [{ n }] = (await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(where)) as [{ n: number }];
    const items = await scope.tx
      .select({
        id: outboxEvents.id,
        eventType: outboxEvents.eventType,
        aggregateType: outboxEvents.aggregateType,
        aggregateId: outboxEvents.aggregateId,
        attemptCount: outboxEvents.attemptCount,
        status: outboxEvents.status,
        createdAt: outboxEvents.createdAt,
        lastErrorCode: outboxEvents.lastErrorCode,
      })
      .from(outboxEvents)
      .where(where)
      .orderBy(desc(outboxEvents.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);
    return { items, total: n, page, limit };
  });
}

/** Başarısız olayı yeniden kuyruğa alır (deneme sayacı sıfırlanır). İşleme yine idempotenttir. */
export async function retryFailedOutboxEvent(ctx: AuthContext, rawId: unknown): Promise<void> {
  requireFailedEventsAdmin(ctx);
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  await tenantQuery(ctx, async (scope) => {
    const r = await scope.tx
      .update(outboxEvents)
      // Zaman DB saatinden (uygulama sunucusu saati farklı olabilir → olay "henüz hazır değil" kalmasın).
      .set({ status: "PENDING", attemptCount: 0, availableAt: sql`now()`, lastErrorCode: null })
      .where(
        tenantWhere(outboxEvents, scope, eq(outboxEvents.id, id.data), eq(outboxEvents.status, "FAILED")),
      )
      .returning({ id: outboxEvents.id });
    if (!r.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "OUTBOX_FAILED",
      entityType: "outbox_event",
      entityId: id.data,
      metadata: { retryRequested: true },
    });
    const tenantId = scope.tenantId;
    afterCommit(scope, () => kickOutbox(tenantId));
  });
}
