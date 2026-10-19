import "server-only";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  inventoryLocations,
  notificationPreferences,
  notifications,
  patientDocuments,
  stockLots,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import {
  actorOf,
  canAccessBranch,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { uuidSchema } from "@/server/validation";
import { visibleAppointmentSummaries } from "@/server/services/appointments";
import type { NotificationView } from "@/types/notifications";
import {
  CATEGORY_OF,
  MANDATORY_TYPES,
  NOTIFICATION_TYPES,
  TYPE_LABELS,
  typesOfCategory,
  type NotificationCategory,
  type NotificationType,
} from "@/server/notifications/catalog";

/**
 * Bildirim merkezi servisleri. Her çağrı: notification.read_own + kiracı (RLS) + ALICI kapsamı — kullanıcı
 * YALNIZCA kendi bildirimlerini görür / işaretler. Başka kullanıcının (aynı kiracı dahil) bildirim kimliği → NOT_FOUND.
 * Alıcı her zaman oturumdan (ctx.userId) gelir; istemci parametresinden ASLA.
 */
export const listNotificationsInput = z.object({
  filter: z.enum(["all", "unread", "appointments", "inventory", "security", "tasks"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type { NotificationView } from "@/types/notifications";

const own = (scope: TenantScope, ctx: AuthContext, ...conds: (SQL | undefined)[]) =>
  tenantWhere(notifications, scope, eq(notifications.recipientUserId, ctx.userId), ...conds);

function filterCond(filter: z.infer<typeof listNotificationsInput>["filter"]): SQL | undefined {
  if (filter === "unread") return eq(notifications.status, "UNREAD");
  if (filter === "all") return sql`${notifications.status} <> 'ARCHIVED'`;
  return and(
    inArray(notifications.type, typesOfCategory(filter)),
    sql`${notifications.status} <> 'ARCHIVED'`,
  );
}

async function unreadCount(scope: TenantScope, ctx: AuthContext): Promise<number> {
  const [r] = await scope.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(own(scope, ctx, eq(notifications.status, "UNREAD")));
  return r?.n ?? 0;
}

export async function getUnreadNotificationCount(ctx: AuthContext): Promise<number> {
  requirePermission(ctx, "notification.read_own");
  return tenantQuery(ctx, (scope) => unreadCount(scope, ctx));
}

export async function listNotifications(
  ctx: AuthContext,
  input: unknown = {},
): Promise<{ items: NotificationView[]; total: number; unread: number; page: number; limit: number }> {
  requirePermission(ctx, "notification.read_own");
  const data = parseInput(listNotificationsInput, input);
  return tenantQuery(ctx, async (scope) => {
    const where = own(scope, ctx, filterCond(data.filter));
    const [{ n }] = (await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(where)) as [{ n: number }];
    const rows = await scope.tx
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(data.limit)
      .offset((data.page - 1) * data.limit);
    const links = await resolveNotificationLinks(scope, ctx, rows);
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        category: CATEGORY_OF[r.type],
        severity: r.severity,
        title: r.title,
        body: r.bodySafe,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
        href: links.get(r.id)?.href ?? null,
        context: links.get(r.id)?.context ?? null,
      })),
      total: n,
      unread: await unreadCount(scope, ctx),
      page: data.page,
      limit: data.limit,
    };
  });
}

/**
 * Varlık referanslarını YETKİ KONTROLLÜ çözer — varlık türü başına tek toplu sorgu (N+1 yok). Kullanıcı varlığı
 * artık göremiyorsa (şube kapsamı, doktor kendi kapsamı, izin kaybı) bağlantı ve bağlam verilmez.
 */
async function resolveNotificationLinks(
  scope: TenantScope,
  ctx: AuthContext,
  rows: (typeof notifications.$inferSelect)[],
): Promise<Map<string, { href: string; context: string | null }>> {
  const out = new Map<string, { href: string; context: string | null }>();
  const idsOf = (t: string) => [
    ...new Set(rows.filter((r) => r.entityType === t && r.entityId).map((r) => r.entityId!)),
  ];

  const apptIds = idsOf("appointment");
  if (apptIds.length) {
    const visible = await visibleAppointmentSummaries(scope, ctx, apptIds);
    for (const r of rows) {
      const v = r.entityType === "appointment" && r.entityId ? visible.get(r.entityId) : undefined;
      if (v)
        out.set(r.id, { href: `/appointments/${r.entityId}`, context: `${v.localStart} — ${v.patientName}` });
    }
  }

  // Görev bildirimi: alıcı görevin atandığı kişidir; görev listesine (bana atananlar) bağlanır.
  if (hasPermission(ctx, "task.read")) {
    for (const r of rows) {
      if (r.entityType === "patient_task" && r.entityId) out.set(r.id, { href: "/tasks", context: null });
    }
  }

  if (hasPermission(ctx, "inventory.read")) {
    for (const r of rows) {
      if (r.entityType === "inventory_item" && r.entityId)
        out.set(r.id, { href: `/inventory/items/${r.entityId}`, context: null });
    }
  }

  const lotIds = idsOf("stock_lot");
  if (lotIds.length && hasPermission(ctx, "inventory.lot.read")) {
    const lots = await scope.tx
      .select({ id: stockLots.id, branchId: inventoryLocations.branchId })
      .from(stockLots)
      .innerJoin(
        inventoryLocations,
        and(
          eq(inventoryLocations.id, stockLots.locationId),
          eq(inventoryLocations.tenantId, stockLots.tenantId),
        ),
      )
      .where(tenantWhere(stockLots, scope, inArray(stockLots.id, lotIds)));
    const ok = new Set(lots.filter((l) => canAccessBranch(ctx, l.branchId)).map((l) => l.id));
    for (const r of rows) {
      if (r.entityType === "stock_lot" && r.entityId && ok.has(r.entityId)) {
        out.set(r.id, { href: `/inventory/lots/${r.entityId}`, context: null });
      }
    }
  }

  const docIds = idsOf("patient_document");
  if (docIds.length && hasPermission(ctx, "patient.document.read")) {
    const docs = await scope.tx
      .select({
        id: patientDocuments.id,
        patientId: patientDocuments.patientId,
        branchId: patientDocuments.branchId,
      })
      .from(patientDocuments)
      .where(tenantWhere(patientDocuments, scope, inArray(patientDocuments.id, docIds)));
    const byId = new Map(docs.filter((d) => canAccessBranch(ctx, d.branchId)).map((d) => [d.id, d]));
    for (const r of rows) {
      const d = r.entityType === "patient_document" && r.entityId ? byId.get(r.entityId) : undefined;
      // Bağlam yok: belge içeriği / hasta adı bildirimde gösterilmez; yetkili yönetici ayrıntıyı belgede görür.
      if (d) out.set(r.id, { href: `/patients/${d.patientId}?tab=documents`, context: null });
    }
  }
  return out;
}

function parseNotificationId(raw: unknown): string {
  const id = uuidSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND");
  return id.data;
}

/** Okundu işaretle — yalnızca KENDİ bildirimi (başkasınınki NOT_FOUND). Tekrar çağrı idempotenttir. */
export async function markNotificationRead(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "notification.read_own");
  const id = parseNotificationId(rawId);
  await tenantQuery(ctx, async (scope) => {
    const [n] = await scope.tx
      .select({ id: notifications.id, status: notifications.status })
      .from(notifications)
      .where(own(scope, ctx, eq(notifications.id, id)))
      .for("update");
    if (!n) throw new AppError("NOT_FOUND");
    if (n.status !== "UNREAD") return;
    await scope.tx
      .update(notifications)
      .set({ status: "READ", readAt: new Date() })
      .where(own(scope, ctx, eq(notifications.id, id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "NOTIFICATION_READ",
      entityType: "notification",
      entityId: id,
    });
  });
}

export async function markAllNotificationsRead(ctx: AuthContext): Promise<{ updated: number }> {
  requirePermission(ctx, "notification.read_own");
  return tenantQuery(ctx, async (scope) => {
    const r = await scope.tx
      .update(notifications)
      .set({ status: "READ", readAt: new Date() })
      .where(own(scope, ctx, eq(notifications.status, "UNREAD")))
      .returning({ id: notifications.id });
    if (r.length) {
      await writeAudit(scope, actorOf(ctx), {
        action: "NOTIFICATIONS_MARKED_READ",
        entityType: "notification",
        entityId: null,
        metadata: { updated: r.length },
      });
    }
    return { updated: r.length };
  });
}

/** Arşivle — yalnızca KENDİ bildirimi. Fiziksel silme yoktur. */
export async function archiveNotification(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "notification.read_own");
  const id = parseNotificationId(rawId);
  await tenantQuery(ctx, async (scope) => {
    const [n] = await scope.tx
      .select({ id: notifications.id, status: notifications.status })
      .from(notifications)
      .where(own(scope, ctx, eq(notifications.id, id)))
      .for("update");
    if (!n) throw new AppError("NOT_FOUND");
    if (n.status === "ARCHIVED") return;
    await scope.tx
      .update(notifications)
      .set({ status: "ARCHIVED", archivedAt: new Date() })
      .where(own(scope, ctx, eq(notifications.id, id)));
  });
}

// ---------------------------------------------------------------- tercihler

export type NotificationPreferenceView = {
  type: NotificationType;
  label: string;
  category: NotificationCategory;
  inAppEnabled: boolean;
  mandatory: boolean;
};

export async function getNotificationPreferences(ctx: AuthContext): Promise<NotificationPreferenceView[]> {
  requirePermission(ctx, "notification.preference.manage_own");
  return tenantQuery(ctx, async (scope) => {
    const rows = await scope.tx
      .select({ type: notificationPreferences.notificationType, inApp: notificationPreferences.inAppEnabled })
      .from(notificationPreferences)
      .where(tenantWhere(notificationPreferences, scope, eq(notificationPreferences.userId, ctx.userId)));
    const map = new Map(rows.map((r) => [r.type, r.inApp]));
    return NOTIFICATION_TYPES.map((t) => ({
      type: t,
      label: TYPE_LABELS[t],
      category: CATEGORY_OF[t],
      mandatory: MANDATORY_TYPES.has(t),
      inAppEnabled: MANDATORY_TYPES.has(t) ? true : (map.get(t) ?? true),
    }));
  });
}

export const setNotificationPreferenceInput = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  inAppEnabled: z.preprocess((v) => v === true || v === "true" || v === "on", z.boolean()),
});

/** Güvenlik açısından kritik tipler kapatılamaz (VALIDATION). */
export async function setNotificationPreference(ctx: AuthContext, input: unknown): Promise<void> {
  requirePermission(ctx, "notification.preference.manage_own");
  const data = parseInput(setNotificationPreferenceInput, input);
  if (MANDATORY_TYPES.has(data.type) && !data.inAppEnabled) {
    throw new AppError("VALIDATION", { fields: ["type"], message: "Bu güvenlik bildirimi kapatılamaz." });
  }
  await tenantQuery(ctx, (scope) =>
    scope.tx
      .insert(notificationPreferences)
      .values({
        tenantId: scope.tenantId,
        userId: ctx.userId,
        notificationType: data.type,
        inAppEnabled: data.inAppEnabled,
      })
      .onConflictDoUpdate({
        target: [
          notificationPreferences.tenantId,
          notificationPreferences.userId,
          notificationPreferences.notificationType,
        ],
        set: { inAppEnabled: data.inAppEnabled, updatedAt: new Date() },
      }),
  );
}
