import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { doctorProfiles, notificationPreferences, roles, userRoles, users } from "@/server/db/schema";
import { tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { MANDATORY_TYPES, type NotificationType } from "@/server/notifications/catalog";

/**
 * Olay bazlı alıcı çözümü — tüm kiracıyı DEĞİL, yalnızca ilgili kişileri bilgilendirir:
 *
 *  randevu oluşturuldu / taşındı / onaylandı   → randevunun doktoru
 *  randevu iptal                                → doktor + randevuyu oluşturan operasyon kullanıcısı
 *  hasta giriş yaptı / onay gerekli             → doktor
 *  doktor onayladı / reddetti                   → randevuyu oluşturan kullanıcı
 *  düşük / tükenen stok, SKT yaklaşan / geçen   → stok sorumlusu (lokasyonun şubesini kapsayan) + yönetici + sahip
 *  lot geri çağrıldı                            → sahip + yönetici + etkilenen şubeleri kapsayan stok sorumluları
 *  belge bütünlüğü / güvenlik                   → sahip + yönetici
 *
 * İşlemi yapan kullanıcı (actor) randevu olaylarında hariç tutulur. Pasif kullanıcı bildirim almaz. Kullanıcı
 * tercihiyle kapatılmış tip atlanır — güvenlik açısından kritik tipler (MANDATORY_TYPES) hariç.
 */
export type RecipientInput = {
  type: NotificationType;
  /** Olayın şubesi (rol kapsamı için). */
  branchIds?: string[];
  doctorId?: string | null;
  createdByUserId?: string | null;
  actorUserId?: string | null;
  /** Doğrudan alıcılar (ör. görevin atandığı kişi). */
  userIds?: string[];
};

const INVENTORY_ALERT_ROLES = ["INVENTORY_MANAGER", "CLINIC_ADMIN", "CLINIC_OWNER"];
const ADMIN_ROLES = ["CLINIC_OWNER", "CLINIC_ADMIN"];

async function doctorUser(scope: TenantScope, doctorId: string | null | undefined): Promise<string[]> {
  if (!doctorId) return [];
  const rows = await scope.tx
    .select({ userId: doctorProfiles.userId })
    .from(doctorProfiles)
    .innerJoin(users, and(eq(users.id, doctorProfiles.userId), eq(users.tenantId, doctorProfiles.tenantId)))
    .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.id, doctorId), eq(users.active, true)));
  return rows.map((r) => r.userId).filter((x): x is string => Boolean(x));
}

/**
 * Rol anahtarına göre aktif kullanıcılar. branchIds verilirse: kiracı geneli atama (branch_id NULL) VEYA bu
 * şubelerden birine atanmış olanlar. Sistem rolleri (tenant_id NULL) ve kiracıya özel roller anahtarla eşleşir.
 */
async function usersWithRoles(scope: TenantScope, keys: string[], branchIds?: string[]): Promise<string[]> {
  const branchCond =
    branchIds && branchIds.length
      ? or(isNull(userRoles.branchId), inArray(userRoles.branchId, branchIds))
      : undefined;
  const rows = await scope.tx
    .selectDistinct({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(users, and(eq(users.id, userRoles.userId), eq(users.tenantId, userRoles.tenantId)))
    .where(
      tenantWhere(
        userRoles,
        scope,
        inArray(roles.key, keys),
        or(isNull(roles.tenantId), eq(roles.tenantId, scope.tenantId)),
        eq(users.active, true),
        branchCond,
      ),
    );
  return rows.map((r) => r.userId);
}

async function activeUsers(scope: TenantScope, ids: (string | null | undefined)[]): Promise<string[]> {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!list.length) return [];
  const rows = await scope.tx
    .select({ id: users.id })
    .from(users)
    .where(tenantWhere(users, scope, inArray(users.id, list), eq(users.active, true)));
  return rows.map((r) => r.id);
}

export async function resolveNotificationRecipients(
  scope: TenantScope,
  input: RecipientInput,
): Promise<string[]> {
  let ids: string[] = [];
  switch (input.type) {
    case "APPOINTMENT_CREATED":
    case "APPOINTMENT_RESCHEDULED":
    case "APPOINTMENT_CONFIRMED":
    case "PATIENT_CHECKED_IN":
    case "APPOINTMENT_READY_FOR_DOCTOR":
    case "APPOINTMENT_APPROVAL_REQUIRED":
      ids = await doctorUser(scope, input.doctorId);
      break;
    case "APPOINTMENT_CANCELLED":
      ids = [
        ...(await doctorUser(scope, input.doctorId)),
        ...(await activeUsers(scope, [input.createdByUserId])),
      ];
      break;
    case "APPOINTMENT_APPROVED":
    case "APPOINTMENT_DECLINED":
      ids = await activeUsers(scope, [input.createdByUserId]);
      break;
    case "LOW_STOCK":
    case "OUT_OF_STOCK":
    case "LOT_EXPIRING_SOON":
    case "LOT_EXPIRED":
      ids = await usersWithRoles(scope, INVENTORY_ALERT_ROLES, input.branchIds);
      break;
    case "LOT_RECALLED":
      ids = [
        ...(await usersWithRoles(scope, ADMIN_ROLES)),
        ...(await usersWithRoles(scope, ["INVENTORY_MANAGER"], input.branchIds)),
      ];
      break;
    case "DOCUMENT_INTEGRITY_FAILED":
    case "SYSTEM_SECURITY_ALERT":
      ids = await usersWithRoles(scope, ADMIN_ROLES);
      break;
    case "TASK_ASSIGNED":
      // Kendine görev atayan kişi bildirim almaz.
      ids = (await activeUsers(scope, input.userIds ?? [])).filter((id) => id !== input.actorUserId);
      break;
  }
  const isAppointmentEvent = input.type.startsWith("APPOINTMENT_") || input.type === "PATIENT_CHECKED_IN";
  let out = [...new Set(ids)];
  if (isAppointmentEvent && input.actorUserId) out = out.filter((id) => id !== input.actorUserId);
  if (!out.length || MANDATORY_TYPES.has(input.type)) return out;
  // Uygulama içi kanal kapatılmışsa atla (yalnızca kritik olmayan tipler).
  const off = await scope.tx
    .select({ userId: notificationPreferences.userId })
    .from(notificationPreferences)
    .where(
      tenantWhere(
        notificationPreferences,
        scope,
        inArray(notificationPreferences.userId, out),
        eq(notificationPreferences.notificationType, input.type),
        sql`${notificationPreferences.inAppEnabled} = false`,
      ),
    );
  const blocked = new Set(off.map((r) => r.userId));
  return out.filter((id) => !blocked.has(id));
}
