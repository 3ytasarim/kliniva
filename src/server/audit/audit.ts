import "server-only";
import { auditLogs } from "@/server/db/schema";
import { isSensitiveKey, sanitizeString } from "@/server/log/sanitize";
import type { TenantScope } from "@/server/tenant/tenant-query";
import type { RequestMeta } from "@/server/security/request-meta";

/**
 * Denetim kaydı (audit log). Kayıt, işlemle AYNI transaction içinde yazılır: işlem geri alınırsa kayıt da düşer,
 * işlem başarılıysa kaydı atlamak mümkün değildir.
 *
 * Asla yazılmaz: sağlık bilgisi, hasta notu, parola, token, DATABASE_URL, şifreleme anahtarı, imza/PDF içeriği,
 * hasta adı/telefonu. Kayıt yalnızca kimlikler (UUID) ve kısa, yapısal bayraklar içerir.
 */
export type AuditAction =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "SESSION_REVOKED_ALL"
  | "MFA_ENROLLMENT_STARTED"
  | "MFA_ENABLED"
  | "MFA_FAILED"
  | "ACCESS_DENIED"
  | "PATIENT_VIEWED"
  | "PATIENT_HEALTH_VIEWED"
  | "PATIENT_CREATED"
  | "PATIENT_UPDATED"
  | "PATIENT_DOCUMENT_GENERATED"
  | "PATIENT_DOCUMENT_PRESENTED"
  | "PATIENT_DOCUMENT_VIEWED"
  | "PATIENT_DOCUMENT_SIGNED"
  | "DOCUMENT_TEMPLATE_VERSION_CREATED"
  | "DOCUMENT_TEMPLATE_PUBLISHED"
  | "PERMISSION_CHANGED"
  | "USER_CREATED"
  | "BRANCH_CREATED"
  | "BRANCH_UPDATED"
  | "ROOM_CREATED"
  // Sprint 1
  | "CLINIC_PROFILE_UPDATED"
  | "CLINIC_LOGO_UPDATED"
  | "BRANCH_DEACTIVATED"
  | "BRANCH_WORKING_HOURS_UPDATED"
  | "ROOM_UPDATED"
  | "ROOM_DEACTIVATED"
  | "DOCTOR_CREATED"
  | "DOCTOR_UPDATED"
  | "DOCTOR_BRANCH_ASSIGNED"
  | "DOCTOR_BRANCH_REMOVED"
  | "DOCTOR_SCHEDULE_CREATED"
  | "DOCTOR_SCHEDULE_UPDATED"
  | "DOCTOR_SCHEDULE_DELETED"
  | "DOCTOR_ROOM_ASSIGNED"
  | "DOCTOR_ROOM_CHANGED"
  | "DOCTOR_ROOM_UNASSIGNED"
  | "DOCTOR_EXCEPTION_CREATED"
  | "DOCTOR_EXCEPTION_DELETED"
  | "BRANCH_CLOSURE_CREATED"
  | "BRANCH_CLOSURE_DELETED"
  // Sprint 2
  | "PATIENT_DUPLICATE_WARNING"
  | "PATIENT_DOCUMENT_CREATED"
  | "PATIENT_DOCUMENT_DOWNLOADED"
  | "PATIENT_DOCUMENT_VOIDED"
  | "PATIENT_DOCUMENT_INTEGRITY_FAILED"
  | "CONSENT_GRANTED"
  | "CONSENT_DENIED"
  | "CONSENT_REVOKED"
  // Sprint 3
  | "CLINICAL_SERVICE_CREATED"
  | "CLINICAL_SERVICE_UPDATED"
  | "DOCTOR_SERVICES_UPDATED"
  | "APPOINTMENT_CREATED"
  | "APPOINTMENT_VIEWED"
  | "APPOINTMENT_UPDATED"
  | "APPOINTMENT_RESCHEDULED"
  | "APPOINTMENT_CONFIRMED"
  | "APPOINTMENT_CHECKED_IN"
  | "APPOINTMENT_STARTED"
  | "APPOINTMENT_COMPLETED"
  | "APPOINTMENT_CANCELLED"
  | "APPOINTMENT_NO_SHOW"
  | "APPOINTMENT_CONFLICT"
  | "DOCTOR_AVAILABILITY_VIEWED"
  // Sprint 4
  | "INVENTORY_CATEGORY_CREATED"
  | "INVENTORY_CATEGORY_UPDATED"
  | "INVENTORY_ITEM_CREATED"
  | "INVENTORY_ITEM_UPDATED"
  | "INVENTORY_ITEM_DEACTIVATED"
  | "INVENTORY_LOCATION_CREATED"
  | "INVENTORY_LOCATION_UPDATED"
  | "STOCK_INITIALIZED"
  | "STOCK_ADDED"
  | "STOCK_ADJUSTED"
  | "STOCK_TRANSFERRED"
  | "PATIENT_MATERIAL_USAGE_CREATED"
  | "PATIENT_MATERIAL_USAGE_UPDATED"
  | "PATIENT_MATERIAL_USAGE_FINALIZED"
  | "PATIENT_MATERIAL_USAGE_VOIDED"
  | "SERVICE_MATERIAL_TEMPLATE_UPDATED"
  | "LOW_STOCK_VIEWED"
  | "STOCK_BALANCE_MISMATCH"
  | "STOCK_BALANCE_RECONCILED"
  // Sprint 5
  | "LOT_CREATED"
  | "LOT_STOCK_ADDED"
  | "LOT_TRANSFERRED"
  | "LOT_METADATA_CORRECTED"
  | "LOT_RECALLED"
  | "LOT_EXPIRY_VIEWED"
  | "EXPIRED_STOCK_WRITTEN_OFF"
  | "PHYSICAL_COUNT_RECORDED"
  | "PATIENT_LOT_USAGE_FINALIZED"
  | "LOT_PATIENT_TRACE_VIEWED";

export type AuditSource = "USER" | "SYSTEM" | "AI_VOICE" | "API";

/** Yalnızca kısa yapısal değerler: bayrak, sayı, kod/UUID. Serbest metin (isim, not) kabul edilmez. */
export type AuditMetadata = Record<string, string | number | boolean | null>;

export type AuditActor = {
  userId: string | null;
  source: AuditSource;
  meta: RequestMeta;
};

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
/** Kod benzeri değer: boşluk/Türkçe harf/@ içermez → isim, e-posta, serbest metin buradan geçemez. */
const CODE_VALUE_RE = /^[A-Za-z0-9_.:,\-]{0,200}$/;
const MAX_KEYS = 20;

export function sanitizeAuditMetadata(input: AuditMetadata | undefined): AuditMetadata {
  const out: AuditMetadata = {};
  if (!input) return out;
  for (const [k, v] of Object.entries(input).slice(0, MAX_KEYS)) {
    if (!KEY_RE.test(k)) continue;
    // Boolean bayrak (ör. hasHealthNotes) içerik taşıyamaz; hassas görünen anahtarda yalnızca bayrağa izin verilir.
    if (typeof v === "boolean") out[k] = v;
    else if (isSensitiveKey(k)) continue;
    else if (v === null) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") {
      const cleaned = sanitizeString(v);
      if (cleaned === v && CODE_VALUE_RE.test(v)) out[k] = v;
    }
  }
  return out;
}

export async function writeAudit(
  scope: TenantScope,
  actor: AuditActor,
  entry: {
    action: AuditAction;
    entityType: string;
    entityId?: string | null;
    branchId?: string | null;
    metadata?: AuditMetadata;
  },
): Promise<void> {
  await scope.tx.insert(auditLogs).values({
    tenantId: scope.tenantId,
    userId: actor.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    branchId: entry.branchId ?? null,
    source: actor.source,
    ipHash: actor.meta.ipHash,
    userAgentSummary: actor.meta.userAgentSummary,
    metadataSafe: sanitizeAuditMetadata(entry.metadata),
  });
}
