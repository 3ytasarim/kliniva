/**
 * Kliniva AI — veritabanı şeması (Drizzle).
 *
 * Tüm tablolar mevcut Neon veritabanındaki ayrı "kliniva" Postgres şemasında yaşar; böylece aynı veritabanındaki
 * olası başka tablolarla çakışmaz. Yeni veritabanı oluşturulmaz.
 *
 * Kiracı (tenant) izolasyonu üç katmanlıdır:
 *   1. Kiracıya ait her tabloda tenant_id NOT NULL.
 *   2. Kiracı içi ilişkiler bileşik yabancı anahtarla (tenant_id, x_id) kurulur → başka kiracının şubesine/hastasına
 *      bağlanan satır veritabanı seviyesinde reddedilir.
 *   3. Satır düzeyi güvenlik (RLS, FORCE) — politikalar drizzle/0001_security.sql içinde. Uygulama kodu kiracı
 *      tablolarına yalnızca tenantQuery() üzerinden erişir (bkz. src/server/tenant/tenant-query.ts).
 *
 * Veri sınıfları: docs/DATA_CLASSIFICATION.md (yorumlarda [SINIF] olarak işaretli).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { TemplateChoice } from "@/types/patients";

export const kliniva = pgSchema("kliniva");

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------- enum'lar

export const tenantStatus = kliniva.enum("tenant_status", ["ACTIVE", "SUSPENDED"]);
export const sessionState = kliniva.enum("session_state", ["MFA_PENDING", "ACTIVE"]);
export const auditSource = kliniva.enum("audit_source", ["USER", "SYSTEM", "AI_VOICE", "API"]);
export const documentType = kliniva.enum("document_type", [
  "KVKK_DISCLOSURE",
  "EXPLICIT_CONSENT",
  "TREATMENT_CONSENT",
  "OTHER",
  "COMMERCIAL_COMMUNICATION_CONSENT",
]);
/** DRAFT (içerik snapshot'ı sabit) → PRESENTED → SIGNED; VOIDED = geçersiz kılma kaydı (fiziksel silme değil). */
export const patientDocumentStatus = kliniva.enum("patient_document_status", [
  "DRAFT",
  "PRESENTED",
  "SIGNED",
  "VOIDED",
]);
export const signerType = kliniva.enum("signer_type", ["PATIENT", "PARENT", "LEGAL_GUARDIAN"]);
/** Aydınlatma (READ_AND_INFORMED) ile açık rıza (GRANTED/DENIED) ayrı değerlerdir; birbirine dönüştürülmez. */
export const consentValue = kliniva.enum("consent_value", ["READ_AND_INFORMED", "GRANTED", "DENIED"]);
export const roomType = kliniva.enum("room_type", [
  "EXAMINATION",
  "PROCEDURE",
  "TREATMENT",
  "LASER",
  "CONSULTATION",
  "SURGERY",
  "OTHER",
]);
export const scheduleExceptionType = kliniva.enum("schedule_exception_type", ["ALL_DAY", "TIME_RANGE"]);

// ---------------------------------------------------------------- platform tabloları (kiracı dışı)

/** [INTERNAL] Klinik / kiracı. */
export const tenants = kliniva.table("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: tenantStatus("status").notNull().default("ACTIVE"),
  /** Hasta dosya numarası sayacı (kiracı başına artan). */
  patientSeq: integer("patient_seq").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** [INTERNAL] Yetki anahtarları (ör. patient.read). Sistem genelidir. */
export const permissions = kliniva.table("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  description: text("description").notNull(),
  createdAt: createdAt(),
});

/** [INTERNAL] Rol. tenant_id NULL → sistem rolü (CLINIC_OWNER vb.); dolu → ileride kiracıya özel rol. */
export const roles = kliniva.table(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique("roles_tenant_key_uq").on(t.tenantId, t.key).nullsNotDistinct()],
);

export const rolePermissions = kliniva.table(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

/** [INTERNAL] Sabit pencereli hız sınırlama sayaçları. Anahtar HMAC özetidir (e-posta/IP düz metin değil). */
export const rateLimits = kliniva.table("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

// ---------------------------------------------------------------- kiracı tabloları (RLS: FORCE)

/** [INTERNAL] Şube. */
export const branches = kliniva.table(
  "branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code"),
    city: text("city").notNull(),
    district: text("district"),
    address: text("address"),
    phone: text("phone"),
    email: text("email"),
    timezone: text("timezone").notNull().default("Europe/Istanbul"),
    active: boolean("active").notNull().default(true),
    /** true → branch_working_hours müsaitlik hesabında doktor saatleriyle kesiştirilir. */
    workingHoursEnabled: boolean("working_hours_enabled").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("branches_tenant_id_uq").on(t.tenantId, t.id),
    unique("branches_tenant_code_uq").on(t.tenantId, t.code),
    index("branches_tenant_idx").on(t.tenantId),
  ],
);

/** [INTERNAL] Oda / muayene odası. */
export const rooms = kliniva.table(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    name: text("name").notNull(),
    code: text("code"),
    type: roomType("type").notNull().default("OTHER"),
    floor: text("floor"),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "rooms_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
    /** Oda atamaları (tenant_id, branch_id, room_id) ile bağlanır → oda başka şubeye/kiracıya ait olamaz. */
    unique("rooms_tenant_branch_id_uq").on(t.tenantId, t.branchId, t.id),
    unique("rooms_branch_name_uq").on(t.branchId, t.name),
    unique("rooms_branch_code_uq").on(t.branchId, t.code),
    index("rooms_tenant_branch_idx").on(t.tenantId, t.branchId),
  ],
);

/** [PERSONAL] Klinik personeli (kullanıcı). Parola Argon2id özeti; 2FA sırrı AES-256-GCM ile şifreli. */
export const users = kliniva.table(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    passwordHash: text("password_hash").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phone: text("phone"),
    active: boolean("active").notNull().default(true),
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    /** [SENSITIVE_PERSONAL] encryptField() çıktısı. Kurulum tamamlanana kadar twoFactorEnabled=false kalır. */
    twoFactorSecretEncrypted: text("two_factor_secret_encrypted"),
    /** TOTP tekrar oynatma (replay) koruması: son kabul edilen 30 sn'lik adım. */
    twoFactorLastUsedStep: bigint("two_factor_last_used_step", { mode: "number" }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("users_tenant_id_uq").on(t.tenantId, t.id),
    unique("users_tenant_email_uq").on(t.tenantId, t.emailNormalized),
  ],
);

/**
 * [SENSITIVE_PERSONAL] Sunucu tarafı oturum. Çerezdeki ham token asla saklanmaz; yalnızca SHA-256 özeti.
 * Token özetiyle aranır (RLS dışı platform tablosu) ama (tenant_id, user_id) bileşik FK ile kullanıcıya bağlıdır.
 */
export const sessions = kliniva.table(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    state: sessionState("state").notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipHash: text("ip_hash"),
    userAgentSummary: text("user_agent_summary"),
  },
  (t) => [
    foreignKey({
      name: "sessions_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete("cascade"),
    index("sessions_user_idx").on(t.userId),
  ],
);

/** Kullanıcı ↔ rol ataması. branch_id NULL → kiracı geneli; dolu → yalnızca o şube kapsamı. */
export const userRoles = kliniva.table(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "no action" }),
    branchId: uuid("branch_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "user_roles_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "user_roles_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
    unique("user_roles_assignment_uq").on(t.userId, t.roleId, t.branchId).nullsNotDistinct(),
    index("user_roles_tenant_user_idx").on(t.tenantId, t.userId),
  ],
);

/**
 * Hasta. Kimlik/iletişim alanları [PERSONAL]; notes_encrypted [HEALTH_SPECIAL_CATEGORY] — yalnızca şifreli,
 * yalnızca patient.health.read yetkisiyle çözülür.
 */
export const patients = kliniva.table(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Ana şube (DB sütunu tarihsel olarak branch_id). Yetki için tek başına kullanılmaz → patient_branches. */
    primaryBranchId: uuid("branch_id"),
    patientNumber: text("patient_number").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phone: text("phone").notNull(),
    /** Ülke farkındalıklı E.164 (ör. +905321234567) — arama ve olası kopya tespiti için. */
    phoneNormalized: text("phone_normalized"),
    secondaryPhone: text("secondary_phone"),
    email: text("email"),
    emailNormalized: text("email_normalized"),
    birthDate: date("birth_date"),
    gender: text("gender"),
    nationality: text("nationality"),
    preferredLanguage: text("preferred_language").notNull().default("TR"),
    address: text("address"),
    city: text("city"),
    district: text("district"),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    /** [SENSITIVE_PERSONAL] TC kimlik no — yalnızca şifreli; düz metin asla yazılmaz. */
    nationalIdEncrypted: text("national_id_encrypted"),
    notesEncrypted: text("notes_encrypted"),
    active: boolean("active").notNull().default(true),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "patients_branch_fk",
      columns: [t.tenantId, t.primaryBranchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("no action"),
    unique("patients_tenant_id_uq").on(t.tenantId, t.id),
    unique("patients_tenant_number_uq").on(t.tenantId, t.patientNumber),
    index("patients_tenant_branch_idx").on(t.tenantId, t.primaryBranchId),
    index("patients_tenant_phone_idx").on(t.tenantId, t.phoneNormalized),
    index("patients_tenant_email_idx").on(t.tenantId, t.emailNormalized),
  ],
);

/**
 * [INTERNAL] Denetim kaydı — yalnızca eklenir (UPDATE veritabanı tetikleyicisiyle engelli).
 * metadata_safe yalnızca sanitizeAuditMetadata() çıktısı alır; sağlık verisi / not / parola / token içermez.
 */
export const auditLogs = kliniva.table(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    branchId: uuid("branch_id"),
    source: auditSource("source").notNull(),
    ipHash: text("ip_hash"),
    userAgentSummary: text("user_agent_summary"),
    metadataSafe: jsonb("metadata_safe")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("audit_logs_tenant_entity_idx").on(t.tenantId, t.entityType, t.entityId),
  ],
);

export type { TemplateChoice };

/**
 * [INTERNAL] Belge şablonu. Her satır bir VERSİYONDUR. Yayımlanan (published_at dolu) şablonun metni/seçimleri
 * değiştirilemez (tetikleyici); yeni metin = yeni versiyon. tenant_id NULL → platform şablonu (salt okunur).
 */
export const documentTemplates = kliniva.table(
  "document_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    type: documentType("type").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    choices: jsonb("choices")
      .$type<TemplateChoice[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    active: boolean("active").notNull().default(true),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [unique("document_templates_version_uq").on(t.tenantId, t.type, t.version).nullsNotDistinct()],
);

/**
 * [HEALTH_SPECIAL_CATEGORY] Hastaya sunulan / imzalanan belge örneği.
 * SIGNED olduktan sonra UPDATE ve DELETE veritabanı tetikleyicisiyle engellidir (immutable).
 * İmza görüntüsü ve PDF yalnızca özel (private) depolama anahtarıyla tutulur; public URL yoktur.
 */
export const patientDocuments = kliniva.table(
  "patient_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    documentTemplateId: uuid("document_template_id")
      .notNull()
      .references(() => documentTemplates.id, { onDelete: "no action" }),
    documentVersion: integer("document_version").notNull(),
    status: patientDocumentStatus("status").notNull().default("DRAFT"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    presentedAt: timestamp("presented_at", { withTimezone: true }),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    /** İmzalayan kişinin adı (hasta veya yasal temsilci). */
    signedByName: text("signed_by_name"),
    signerType: signerType("signer_type"),
    guardianName: text("guardian_name"),
    guardianRelationship: text("guardian_relationship"),
    signatureStorageKey: text("signature_storage_key"),
    pdfStorageKey: text("pdf_storage_key"),
    /** Final PDF baytlarının SHA-256'sı. */
    documentSha256: text("document_sha256"),
    /**
     * [HEALTH_SPECIAL_CATEGORY] Hastaya gösterilen belgenin TAM içerik snapshot'ı (başlık, metin, seçim şeması) —
     * AES-256-GCM şifreli; DRAFT oluşturulurken yazılır ve bir daha değişmez. Şablon değişse/silinse bile hastanın
     * gerçekte gördüğü ve imzaladığı metin kanıtlanabilir.
     */
    contentSnapshotEncrypted: text("content_snapshot_encrypted"),
    /** Snapshot'ın kanonik JSON SHA-256'sı (önizleme == imza doğrulaması). */
    contentSha256: text("content_sha256"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id"),
    voidReason: text("void_reason"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "patient_documents_patient_fk",
      columns: [t.tenantId, t.patientId],
      foreignColumns: [patients.tenantId, patients.id],
    }).onDelete("no action"),
    foreignKey({
      name: "patient_documents_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("no action"),
    unique("patient_documents_tenant_id_uq").on(t.tenantId, t.id),
    index("patient_documents_tenant_patient_idx").on(t.tenantId, t.patientId),
  ],
);

/** [HEALTH_SPECIAL_CATEGORY] Belgedeki her seçim. İmzalı belgenin seçimleri değiştirilemez (tetikleyici). */
export const consentChoices = kliniva.table(
  "consent_choices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientDocumentId: uuid("patient_document_id").notNull(),
    key: text("key").notNull(),
    value: consentValue("value").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "consent_choices_document_fk",
      columns: [t.tenantId, t.patientDocumentId],
      foreignColumns: [patientDocuments.tenantId, patientDocuments.id],
    }).onDelete("cascade"),
    unique("consent_choices_document_key_uq").on(t.patientDocumentId, t.key),
    unique("consent_choices_tenant_id_uq").on(t.tenantId, t.id),
  ],
);

// ================================================================ Sprint 1 — klinik profili ve doktor planlama
// Gün: ISO-8601 (1 = Pazartesi … 7 = Pazar). Saatler şubenin YEREL saatidir (branches.timezone); gerçek zaman
// damgaları (ileride randevular) UTC timestamptz olarak tutulacaktır. Çakışma kuralları için exclusion
// constraint'ler drizzle/0004_scheduling_security.sql içindedir.

/** [INTERNAL] Klinik profili (kiracı başına bir). Logo özel depoda (logoStorageKey) tutulur. */
export const clinicProfiles = kliniva.table(
  "clinic_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    legalName: text("legal_name"),
    phone: text("phone"),
    email: text("email"),
    website: text("website"),
    address: text("address"),
    city: text("city"),
    district: text("district"),
    country: text("country").notNull().default("TR"),
    logoStorageKey: text("logo_storage_key"),
    timezone: text("timezone").notNull().default("Europe/Istanbul"),
    defaultAppointmentDurationMinutes: integer("default_appointment_duration_minutes").notNull().default(30),
    /** Okunabilir hasta numarası öneki (KLI-000001). */
    patientNumberPrefix: text("patient_number_prefix").notNull().default("KLI"),
    /** Randevu: şimdiden en az kaç dakika sonrası alınabilir (0 = hemen). */
    minBookingNoticeMinutes: integer("min_booking_notice_minutes").notNull().default(0),
    /** Randevu: en fazla kaç gün ilerisi. */
    maxBookingDaysAhead: integer("max_booking_days_ahead").notNull().default(365),
    /** İptalde gerekçe zorunlu mu. */
    cancellationReasonRequired: boolean("cancellation_reason_required").notNull().default(true),
    /** Uygun saat listesinin adımı (dakika). */
    slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(15),
    /** Negatif stok — bu sürümde her zaman false (DB check + bakiye check). */
    allowNegativeStock: boolean("allow_negative_stock").notNull().default(false),
    /** "Yakında süresi dolacak" penceresi (gün). */
    expiryWarningDays: integer("expiry_warning_days").notNull().default(30),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("clinic_profiles_prefix_ck", sql`${t.patientNumberPrefix} ~ '^[A-Z0-9]{2,8}$'`),
    check("clinic_profiles_duration_ck", sql`${t.defaultAppointmentDurationMinutes} between 5 and 480`),
    check("clinic_profiles_notice_ck", sql`${t.minBookingNoticeMinutes} between 0 and 10080`),
    check("clinic_profiles_horizon_ck", sql`${t.maxBookingDaysAhead} between 1 and 730`),
    check("clinic_profiles_slot_ck", sql`${t.slotIntervalMinutes} in (5, 10, 15, 20, 30, 60)`),
    check("clinic_profiles_negative_stock_ck", sql`${t.allowNegativeStock} = false`),
    check("clinic_profiles_expiry_warning_ck", sql`${t.expiryWarningDays} between 1 and 365`),
  ],
);

/** [INTERNAL] Şubenin haftalık açılış saatleri (şube + gün benzersiz). */
export const branchWorkingHours = kliniva.table(
  "branch_working_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    dayOfWeek: smallint("day_of_week").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    startTime: time("start_time"),
    endTime: time("end_time"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "branch_working_hours_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
    unique("branch_working_hours_day_uq").on(t.branchId, t.dayOfWeek),
    check("branch_working_hours_day_ck", sql`${t.dayOfWeek} between 1 and 7`),
    check(
      "branch_working_hours_time_ck",
      sql`(not ${t.enabled}) or (${t.startTime} is not null and ${t.endTime} is not null and ${t.startTime} < ${t.endTime})`,
    ),
  ],
);

/** [PERSONAL] Doktor profili — kullanıcıdan ayrı; bir kullanıcının en fazla bir doktor profili olur. */
export const doctorProfiles = kliniva.table(
  "doctor_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull().unique(),
    title: text("title"),
    specialty: text("specialty").notNull(),
    subSpecialty: text("sub_specialty"),
    licenseNumber: text("license_number"),
    bio: text("bio"),
    defaultAppointmentDurationMinutes: integer("default_appointment_duration_minutes").notNull().default(30),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "doctor_profiles_user_fk",
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete("cascade"),
    unique("doctor_profiles_tenant_id_uq").on(t.tenantId, t.id),
    check("doctor_profiles_duration_ck", sql`${t.defaultAppointmentDurationMinutes} between 5 and 480`),
  ],
);

/** Doktor ↔ şube. Çalışma saati ve oda ataması yalnızca bu bağ varsa yapılabilir (bileşik FK). */
export const doctorBranches = kliniva.table(
  "doctor_branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "doctor_branches_doctor_fk",
      columns: [t.tenantId, t.doctorId],
      foreignColumns: [doctorProfiles.tenantId, doctorProfiles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "doctor_branches_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
    unique("doctor_branches_doctor_branch_uq").on(t.doctorId, t.branchId),
    unique("doctor_branches_tenant_doctor_branch_uq").on(t.tenantId, t.doctorId, t.branchId),
  ],
);

/** Doktorun haftalık çalışma blokları. Aynı gün birden çok blok olabilir; örtüşme exclusion constraint ile yasak. */
export const doctorWorkingHours = kliniva.table(
  "doctor_working_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    dayOfWeek: smallint("day_of_week").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "doctor_working_hours_doctor_branch_fk",
      columns: [t.tenantId, t.doctorId, t.branchId],
      foreignColumns: [doctorBranches.tenantId, doctorBranches.doctorId, doctorBranches.branchId],
    }).onDelete("cascade"),
    check("doctor_working_hours_day_ck", sql`${t.dayOfWeek} between 1 and 7`),
    check("doctor_working_hours_time_ck", sql`${t.startTime} < ${t.endTime}`),
    index("doctor_working_hours_doctor_idx").on(t.tenantId, t.doctorId, t.dayOfWeek),
  ],
);

/**
 * Doktor oda ataması: haftalık (day_of_week) VEYA belirli tarih override'ı (effective_date) — ikisinden tam biri.
 * Oda, (tenant_id, branch_id, room_id) bileşik FK ile aynı kiracı + aynı şubeye ait olmak zorundadır.
 */
export const doctorRoomAssignments = kliniva.table(
  "doctor_room_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    roomId: uuid("room_id").notNull(),
    dayOfWeek: smallint("day_of_week"),
    effectiveDate: date("effective_date"),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "doctor_room_assignments_doctor_branch_fk",
      columns: [t.tenantId, t.doctorId, t.branchId],
      foreignColumns: [doctorBranches.tenantId, doctorBranches.doctorId, doctorBranches.branchId],
    }).onDelete("cascade"),
    foreignKey({
      name: "doctor_room_assignments_room_fk",
      columns: [t.tenantId, t.branchId, t.roomId],
      foreignColumns: [rooms.tenantId, rooms.branchId, rooms.id],
    }).onDelete("cascade"),
    check("doctor_room_assignments_kind_ck", sql`(${t.dayOfWeek} is null) <> (${t.effectiveDate} is null)`),
    check("doctor_room_assignments_day_ck", sql`${t.dayOfWeek} is null or ${t.dayOfWeek} between 1 and 7`),
    check("doctor_room_assignments_time_ck", sql`${t.startTime} < ${t.endTime}`),
    index("doctor_room_assignments_room_idx").on(t.tenantId, t.roomId),
    index("doctor_room_assignments_doctor_idx").on(t.tenantId, t.doctorId),
  ],
);

/** Doktor izin / çalışmama kaydı (tüm gün veya saat aralığı). branch_id NULL → tüm şubeler. */
export const doctorScheduleExceptions = kliniva.table(
  "doctor_schedule_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    branchId: uuid("branch_id"),
    date: date("date").notNull(),
    type: scheduleExceptionType("type").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    reason: text("reason"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "doctor_schedule_exceptions_doctor_fk",
      columns: [t.tenantId, t.doctorId],
      foreignColumns: [doctorProfiles.tenantId, doctorProfiles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "doctor_schedule_exceptions_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
    check(
      "doctor_schedule_exceptions_time_ck",
      sql`(${t.type} = 'ALL_DAY' and ${t.startTime} is null and ${t.endTime} is null) or (${t.type} = 'TIME_RANGE' and ${t.startTime} is not null and ${t.endTime} is not null and ${t.startTime} < ${t.endTime})`,
    ),
    index("doctor_schedule_exceptions_doctor_date_idx").on(t.tenantId, t.doctorId, t.date),
  ],
);

/** Şube kapalı günleri (resmi tatil, yarım gün vb.). */
export const branchClosures = kliniva.table(
  "branch_closures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    date: date("date").notNull(),
    allDay: boolean("all_day").notNull().default(true),
    startTime: time("start_time"),
    endTime: time("end_time"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "branch_closures_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
    check(
      "branch_closures_time_ck",
      sql`(${t.allDay} and ${t.startTime} is null and ${t.endTime} is null) or ((not ${t.allDay}) and ${t.startTime} is not null and ${t.endTime} is not null and ${t.startTime} < ${t.endTime})`,
    ),
    index("branch_closures_branch_date_idx").on(t.tenantId, t.branchId, t.date),
  ],
);

// ================================================================ Sprint 2 — hasta CRM + KVKK

/**
 * Hasta ↔ şube geçmişi. Şube kapsamlı kullanıcı yalnızca yetkili olduğu şubeyle İLİŞKİLİ hastaları görür
 * (yalnızca primaryBranchId'ye bakılmaz). Kiracı + hasta + şube benzersiz.
 */
export const patientBranches = kliniva.table(
  "patient_branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "patient_branches_patient_fk",
      columns: [t.tenantId, t.patientId],
      foreignColumns: [patients.tenantId, patients.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "patient_branches_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }).onDelete("cascade"),
    unique("patient_branches_uq").on(t.tenantId, t.patientId, t.branchId),
    index("patient_branches_branch_idx").on(t.tenantId, t.branchId),
  ],
);

/**
 * Açık rızanın geri çekilmesi. Orijinal ConsentChoice (GRANTED) ve imzalı belge DEĞİŞMEZ; güncel durum
 * (REVOKED) bu kayıttan türetilir. Yalnızca eklenir (UPDATE/DELETE yetkisi yok). Aydınlatma geri çekilemez (tetikleyici).
 */
export const consentRevocations = kliniva.table(
  "consent_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    consentChoiceId: uuid("consent_choice_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
    revokedByUserId: uuid("revoked_by_user_id"),
    channel: text("channel").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "consent_revocations_patient_fk",
      columns: [t.tenantId, t.patientId],
      foreignColumns: [patients.tenantId, patients.id],
    }).onDelete("no action"),
    foreignKey({
      name: "consent_revocations_choice_fk",
      columns: [t.tenantId, t.consentChoiceId],
      foreignColumns: [consentChoices.tenantId, consentChoices.id],
    }).onDelete("no action"),
    unique("consent_revocations_choice_uq").on(t.consentChoiceId),
    check(
      "consent_revocations_channel_ck",
      sql`${t.channel} in ('IN_PERSON', 'PHONE', 'EMAIL', 'WRITTEN', 'PORTAL', 'OTHER')`,
    ),
    index("consent_revocations_patient_idx").on(t.tenantId, t.patientId),
  ],
);

// ---------------------------------------------------------------- Sprint 3: hizmetler + randevular

export const appointmentStatus = kliniva.enum("appointment_status", [
  "DRAFT",
  "BOOKED",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
]);
export const appointmentSource = kliniva.enum("appointment_source", [
  "STAFF",
  "DOCTOR",
  "PATIENT_PORTAL",
  "AI_VOICE",
  "API",
]);
export const appointmentEventType = kliniva.enum("appointment_event_type", [
  "CREATED",
  "RESCHEDULED",
  "CONFIRMED",
  "CHECKED_IN",
  "STARTED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "NOTES_UPDATED",
]);

/** [INTERNAL] Klinik hizmeti / işlem tipi (Muayene 30 dk, PRP 45 dk …). Oda tipi kısıtı isteğe bağlı. */
export const clinicalServices = kliniva.table(
  "clinical_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code"),
    description: text("description"),
    defaultDurationMinutes: integer("default_duration_minutes").notNull().default(30),
    requiresRoom: boolean("requires_room").notNull().default(true),
    /** NULL / boş → oda tipi kısıtı yok (aktif her oda). */
    allowedRoomTypes: roomType("allowed_room_types").array(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("clinical_services_tenant_id_uq").on(t.tenantId, t.id),
    unique("clinical_services_tenant_name_uq").on(t.tenantId, t.name),
    unique("clinical_services_tenant_code_uq").on(t.tenantId, t.code),
    check("clinical_services_duration_ck", sql`${t.defaultDurationMinutes} between 5 and 480`),
  ],
);

/** Doktorun verebildiği hizmetler (+ isteğe bağlı süre override'ı). */
export const doctorServices = kliniva.table(
  "doctor_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    durationMinutesOverride: integer("duration_minutes_override"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "doctor_services_doctor_fk",
      columns: [t.tenantId, t.doctorId],
      foreignColumns: [doctorProfiles.tenantId, doctorProfiles.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "doctor_services_service_fk",
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [clinicalServices.tenantId, clinicalServices.id],
    }).onDelete("cascade"),
    unique("doctor_services_uq").on(t.tenantId, t.doctorId, t.serviceId),
    check(
      "doctor_services_duration_ck",
      sql`${t.durationMinutesOverride} is null or ${t.durationMinutesOverride} between 5 and 480`,
    ),
  ],
);

/**
 * [PERSONAL] Randevu. Zamanlar UTC (timestamptz); timezone = şubenin IANA saat dilimi (gösterim için).
 * Çakışmalar (doktor / oda / hasta) aktif statülerde exclusion constraint ile VERİTABANINDA imkânsızdır
 * (0008_appointments_security.sql). Durum geçişleri tetikleyiciyle korunur; fiziksel silme yoktur.
 */
export const appointments = kliniva.table(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    patientId: uuid("patient_id").notNull(),
    doctorId: uuid("doctor_id").notNull(),
    roomId: uuid("room_id"),
    serviceId: uuid("service_id"),
    status: appointmentStatus("status").notNull().default("BOOKED"),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }).notNull(),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    source: appointmentSource("source").notNull().default("STAFF"),
    /** [SENSITIVE] Operasyon notu — AES-256-GCM (tıbbi kayıt DEĞİL). */
    notesEncrypted: text("notes_encrypted"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    updatedByUserId: uuid("updated_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    noShowAt: timestamp("no_show_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id"),
    cancellationReason: text("cancellation_reason"),
  },
  (t) => [
    foreignKey({
      name: "appointments_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "appointments_patient_fk",
      columns: [t.tenantId, t.patientId],
      foreignColumns: [patients.tenantId, patients.id],
    }),
    foreignKey({
      name: "appointments_doctor_fk",
      columns: [t.tenantId, t.doctorId],
      foreignColumns: [doctorProfiles.tenantId, doctorProfiles.id],
    }),
    /** Oda aynı kiracı + AYNI şubeye ait olmak zorunda. */
    foreignKey({
      name: "appointments_room_fk",
      columns: [t.tenantId, t.branchId, t.roomId],
      foreignColumns: [rooms.tenantId, rooms.branchId, rooms.id],
    }),
    foreignKey({
      name: "appointments_service_fk",
      columns: [t.tenantId, t.serviceId],
      foreignColumns: [clinicalServices.tenantId, clinicalServices.id],
    }),
    unique("appointments_tenant_id_uq").on(t.tenantId, t.id),
    unique("appointments_tenant_id_patient_branch_uq").on(t.tenantId, t.id, t.patientId, t.branchId),
    check("appointments_time_ck", sql`${t.scheduledStart} < ${t.scheduledEnd}`),
    check(
      "appointments_duration_ck",
      sql`${t.durationMinutes} between 5 and 480 and extract(epoch from (${t.scheduledEnd} - ${t.scheduledStart})) = ${t.durationMinutes} * 60`,
    ),
    index("appointments_branch_start_idx").on(t.tenantId, t.branchId, t.scheduledStart),
    index("appointments_doctor_start_idx").on(t.tenantId, t.doctorId, t.scheduledStart),
    index("appointments_patient_start_idx").on(t.tenantId, t.patientId, t.scheduledStart),
    index("appointments_room_start_idx").on(t.tenantId, t.roomId, t.scheduledStart),
  ],
);

/** Randevu geçmişi — yalnızca ekleme. metadata_safe yalnızca kimlik / zaman / kısa kod (hasta içeriği YOK). */
export const appointmentEvents = kliniva.table(
  "appointment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    appointmentId: uuid("appointment_id").notNull(),
    type: appointmentEventType("type").notNull(),
    fromStatus: appointmentStatus("from_status"),
    toStatus: appointmentStatus("to_status"),
    actorUserId: uuid("actor_user_id"),
    source: appointmentSource("source").notNull().default("STAFF"),
    metadataSafe: jsonb("metadata_safe")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "appointment_events_appointment_fk",
      columns: [t.tenantId, t.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }),
    index("appointment_events_appointment_idx").on(t.tenantId, t.appointmentId, t.createdAt),
  ],
);

// ---------------------------------------------------------------- Sprint 4: stok

export const inventoryUnit = kliniva.enum("inventory_unit", [
  "PIECE",
  "BOX",
  "PACK",
  "BOTTLE",
  "ML",
  "LITER",
  "GRAM",
  "KG",
  "PAIR",
  "SET",
  "OTHER",
]);
export const inventoryLocationType = kliniva.enum("inventory_location_type", ["BRANCH_WAREHOUSE", "ROOM"]);
export const stockMovementType = kliniva.enum("stock_movement_type", [
  "INITIAL_STOCK",
  "PURCHASE",
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
  "TRANSFER",
  "PATIENT_USAGE",
  "RETURN_FROM_PATIENT_USAGE",
  "WRITE_OFF",
]);
export const materialUsageStatus = kliniva.enum("material_usage_status", ["DRAFT", "FINALIZED", "VOIDED"]);

/** Miktar: numeric(14,3) — float YOK. Drizzle string döndürür. */
const qty = (name: string) => numeric(name, { precision: 14, scale: 3 });

/** [INTERNAL] Stok kategorisi. */
export const inventoryCategories = kliniva.table(
  "inventory_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("inventory_categories_tenant_id_uq").on(t.tenantId, t.id),
    unique("inventory_categories_tenant_name_uq").on(t.tenantId, t.name),
  ],
);

/** [INTERNAL] Stok / sarf ürünü. Birim dönüşümü yok: tüm hareketler ürünün birimiyle. */
export const inventoryItems = kliniva.table(
  "inventory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code"),
    barcode: text("barcode"),
    categoryId: uuid("category_id"),
    unit: inventoryUnit("unit").notNull().default("PIECE"),
    trackInventory: boolean("track_inventory").notNull().default(true),
    /** Lot / son kullanma takibi — Sprint 4'te model temeli; lot bazlı tüketim Sprint 5. */
    trackLots: boolean("track_lots").notNull().default(false),
    trackExpiry: boolean("track_expiry").notNull().default(false),
    minimumStockLevel: qty("minimum_stock_level"),
    active: boolean("active").notNull().default(true),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "inventory_items_category_fk",
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [inventoryCategories.tenantId, inventoryCategories.id],
    }),
    unique("inventory_items_tenant_id_uq").on(t.tenantId, t.id),
    unique("inventory_items_tenant_code_uq").on(t.tenantId, t.code),
    unique("inventory_items_tenant_barcode_uq").on(t.tenantId, t.barcode),
    check("inventory_items_min_ck", sql`${t.minimumStockLevel} is null or ${t.minimumStockLevel} >= 0`),
    check("inventory_items_expiry_requires_lots_ck", sql`not ${t.trackExpiry} or ${t.trackLots}`),
    index("inventory_items_tenant_name_idx").on(t.tenantId, t.name),
  ],
);

/** Stok lokasyonu: şube deposu (room_id NULL) veya oda (room_id zorunlu, oda başına tek lokasyon). */
export const inventoryLocations = kliniva.table(
  "inventory_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    type: inventoryLocationType("type").notNull(),
    roomId: uuid("room_id"),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "inventory_locations_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "inventory_locations_room_fk",
      columns: [t.tenantId, t.branchId, t.roomId],
      foreignColumns: [rooms.tenantId, rooms.branchId, rooms.id],
    }),
    unique("inventory_locations_tenant_id_uq").on(t.tenantId, t.id),
    unique("inventory_locations_tenant_branch_id_uq").on(t.tenantId, t.branchId, t.id),
    unique("inventory_locations_branch_name_uq").on(t.tenantId, t.branchId, t.name),
    unique("inventory_locations_room_uq").on(t.tenantId, t.roomId),
    check("inventory_locations_room_ck", sql`(${t.type} = 'ROOM') = (${t.roomId} is not null)`),
  ],
);

/**
 * Bakiye (önbellek): yalnızca stock_movements tetikleyicisi yazar — uygulama rolü yalnızca okur.
 * quantity >= 0 (negatif stok yok). Kaynak gerçek: hareket defteri.
 */
export const stockBalances = kliniva.table(
  "stock_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    quantity: qty("quantity").notNull().default("0"),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "stock_balances_item_fk",
      columns: [t.tenantId, t.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "stock_balances_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id],
    }),
    unique("stock_balances_uq").on(t.tenantId, t.inventoryItemId, t.locationId),
    check("stock_balances_non_negative_ck", sql`${t.quantity} >= 0`),
    index("stock_balances_location_idx").on(t.tenantId, t.locationId, t.inventoryItemId),
  ],
);

/** Lot / son kullanma temeli (Sprint 5: lot bazlı tüketim). */
export const stockLots = kliniva.table(
  "stock_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    /** Lot / parti numarası — zorunlu, hareket gördükten sonra değişmez. */
    lotNumber: text("lot_number").notNull(),
    /** SKT (DATE, saat dilimi yok): şubenin yerel takviminde o günün SONUNA kadar geçerli. */
    expiryDate: date("expiry_date"),
    /** Bakiye önbelleği — yalnızca defter tetikleyicisi değiştirir (uygulama rolünde sütun UPDATE yetkisi yok). */
    quantity: qty("quantity").notNull().default("0"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    supplierReference: text("supplier_reference"),
    active: boolean("active").notNull().default(true),
    /** Geri çağırma — geri alınamaz; gerekçe AES-256-GCM. */
    recalledAt: timestamp("recalled_at", { withTimezone: true }),
    recalledByUserId: uuid("recalled_by_user_id"),
    recallReasonEncrypted: text("recall_reason_encrypted"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "stock_lots_item_fk",
      columns: [t.tenantId, t.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "stock_lots_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id],
    }),
    unique("stock_lots_tenant_id_uq").on(t.tenantId, t.id),
    /** Hareket / tahsis bağlantıları lotun AYNI ürün + AYNI lokasyona ait olduğunu bu anahtarla doğrular. */
    unique("stock_lots_tenant_id_item_location_uq").on(t.tenantId, t.id, t.inventoryItemId, t.locationId),
    unique("stock_lots_identity_uq").on(t.tenantId, t.inventoryItemId, t.locationId, t.lotNumber),
    check("stock_lots_non_negative_ck", sql`${t.quantity} >= 0`),
    check("stock_lots_number_ck", sql`length(trim(${t.lotNumber})) between 1 and 64`),
    index("stock_lots_expiry_idx").on(t.tenantId, t.expiryDate),
  ],
);

/** [PERSONAL] Hasta / randevu bazlı sarf kullanımı. DRAFT stok düşürmez; FINALIZED değişmez; VOIDED ters hareket. */
export const patientMaterialUsages = kliniva.table(
  "patient_material_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    patientId: uuid("patient_id").notNull(),
    appointmentId: uuid("appointment_id"),
    branchId: uuid("branch_id").notNull(),
    roomId: uuid("room_id"),
    doctorId: uuid("doctor_id"),
    status: materialUsageStatus("status").notNull().default("DRAFT"),
    /** [SENSITIVE] hasta bağlantılı not — AES-256-GCM. */
    notesEncrypted: text("notes_encrypted"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    finalizedByUserId: uuid("finalized_by_user_id"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedByUserId: uuid("voided_by_user_id"),
    voidReason: text("void_reason"),
  },
  (t) => [
    foreignKey({
      name: "patient_material_usages_patient_fk",
      columns: [t.tenantId, t.patientId],
      foreignColumns: [patients.tenantId, patients.id],
    }),
    foreignKey({
      name: "patient_material_usages_branch_fk",
      columns: [t.tenantId, t.branchId],
      foreignColumns: [branches.tenantId, branches.id],
    }),
    foreignKey({
      name: "patient_material_usages_room_fk",
      columns: [t.tenantId, t.branchId, t.roomId],
      foreignColumns: [rooms.tenantId, rooms.branchId, rooms.id],
    }),
    foreignKey({
      name: "patient_material_usages_doctor_fk",
      columns: [t.tenantId, t.doctorId],
      foreignColumns: [doctorProfiles.tenantId, doctorProfiles.id],
    }),
    /** Randevu AYNI kiracı + AYNI hasta + AYNI şube olmak zorunda (DB seviyesinde). */
    foreignKey({
      name: "patient_material_usages_appointment_fk",
      columns: [t.tenantId, t.appointmentId, t.patientId, t.branchId],
      foreignColumns: [appointments.tenantId, appointments.id, appointments.patientId, appointments.branchId],
    }),
    unique("patient_material_usages_tenant_id_uq").on(t.tenantId, t.id),
    index("patient_material_usages_patient_idx").on(t.tenantId, t.patientId, t.createdAt),
    index("patient_material_usages_appointment_idx").on(t.tenantId, t.appointmentId),
  ],
);

export const patientMaterialUsageItems = kliniva.table(
  "patient_material_usage_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientUsageId: uuid("patient_usage_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    quantity: qty("quantity").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "pmu_items_usage_fk",
      columns: [t.tenantId, t.patientUsageId],
      foreignColumns: [patientMaterialUsages.tenantId, patientMaterialUsages.id],
    }),
    foreignKey({
      name: "pmu_items_item_fk",
      columns: [t.tenantId, t.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "pmu_items_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id],
    }),
    unique("pmu_items_tenant_id_item_location_uq").on(t.tenantId, t.id, t.inventoryItemId, t.locationId),
    unique("pmu_items_uq").on(t.tenantId, t.patientUsageId, t.inventoryItemId, t.locationId),
    check("pmu_items_quantity_ck", sql`${t.quantity} > 0`),
  ],
);

/**
 * Stok hareket DEFTERİ — kaynak gerçek. Yalnızca eklenir (UPDATE / DELETE yok; düzeltme = ters hareket).
 * Bakiyeyi tetikleyici günceller; çıkışta yetersiz stok → hareket reddedilir.
 */
export const stockMovements = kliniva.table(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    movementType: stockMovementType("movement_type").notNull(),
    fromLocationId: uuid("from_location_id"),
    toLocationId: uuid("to_location_id"),
    quantity: qty("quantity").notNull(),
    patientId: uuid("patient_id"),
    appointmentId: uuid("appointment_id"),
    patientUsageId: uuid("patient_usage_id"),
    /** Lot takipli ürün: kaynak / hedef lot (lot AYNI ürün + AYNI lokasyon — bileşik FK). */
    fromStockLotId: uuid("from_stock_lot_id"),
    toStockLotId: uuid("to_stock_lot_id"),
    reference: text("reference"),
    reason: text("reason"),
    createdByUserId: uuid("created_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "stock_movements_item_fk",
      columns: [t.tenantId, t.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }),
    foreignKey({
      name: "stock_movements_from_fk",
      columns: [t.tenantId, t.fromLocationId],
      foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id],
    }),
    foreignKey({
      name: "stock_movements_to_fk",
      columns: [t.tenantId, t.toLocationId],
      foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id],
    }),
    foreignKey({
      name: "stock_movements_patient_fk",
      columns: [t.tenantId, t.patientId],
      foreignColumns: [patients.tenantId, patients.id],
    }),
    foreignKey({
      name: "stock_movements_appointment_fk",
      columns: [t.tenantId, t.appointmentId],
      foreignColumns: [appointments.tenantId, appointments.id],
    }),
    foreignKey({
      name: "stock_movements_usage_fk",
      columns: [t.tenantId, t.patientUsageId],
      foreignColumns: [patientMaterialUsages.tenantId, patientMaterialUsages.id],
    }),
    foreignKey({
      name: "stock_movements_from_lot_fk",
      columns: [t.tenantId, t.fromStockLotId, t.inventoryItemId, t.fromLocationId],
      foreignColumns: [stockLots.tenantId, stockLots.id, stockLots.inventoryItemId, stockLots.locationId],
    }),
    foreignKey({
      name: "stock_movements_to_lot_fk",
      columns: [t.tenantId, t.toStockLotId, t.inventoryItemId, t.toLocationId],
      foreignColumns: [stockLots.tenantId, stockLots.id, stockLots.inventoryItemId, stockLots.locationId],
    }),
    index("stock_movements_from_lot_idx").on(t.tenantId, t.fromStockLotId),
    index("stock_movements_to_lot_idx").on(t.tenantId, t.toStockLotId),
    check("stock_movements_quantity_ck", sql`${t.quantity} > 0`),
    check(
      "stock_movements_shape_ck",
      sql`case ${t.movementType}
        when 'TRANSFER' then ${t.fromLocationId} is not null and ${t.toLocationId} is not null and ${t.fromLocationId} <> ${t.toLocationId}
        when 'INITIAL_STOCK' then ${t.fromLocationId} is null and ${t.toLocationId} is not null
        when 'PURCHASE' then ${t.fromLocationId} is null and ${t.toLocationId} is not null
        when 'ADJUSTMENT_IN' then ${t.fromLocationId} is null and ${t.toLocationId} is not null
        when 'RETURN_FROM_PATIENT_USAGE' then ${t.fromLocationId} is null and ${t.toLocationId} is not null and ${t.patientUsageId} is not null
        when 'PATIENT_USAGE' then ${t.fromLocationId} is not null and ${t.toLocationId} is null and ${t.patientUsageId} is not null
        else ${t.fromLocationId} is not null and ${t.toLocationId} is null end`,
    ),
    index("stock_movements_item_idx").on(t.tenantId, t.inventoryItemId, t.createdAt),
    index("stock_movements_from_idx").on(t.tenantId, t.fromLocationId, t.createdAt),
    index("stock_movements_to_idx").on(t.tenantId, t.toLocationId, t.createdAt),
    index("stock_movements_usage_idx").on(t.tenantId, t.patientUsageId),
  ],
);

/** Hizmet malzeme şablonu — YALNIZCA öneri; stok düşürmez. */
export const serviceMaterialTemplates = kliniva.table(
  "service_material_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    clinicalServiceId: uuid("clinical_service_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    defaultQuantity: qty("default_quantity").notNull(),
    required: boolean("required").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "smt_service_fk",
      columns: [t.tenantId, t.clinicalServiceId],
      foreignColumns: [clinicalServices.tenantId, clinicalServices.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "smt_item_fk",
      columns: [t.tenantId, t.inventoryItemId],
      foreignColumns: [inventoryItems.tenantId, inventoryItems.id],
    }).onDelete("cascade"),
    unique("smt_uq").on(t.tenantId, t.clinicalServiceId, t.inventoryItemId),
    check("smt_quantity_ck", sql`${t.defaultQuantity} > 0`),
  ],
);

// ---------------------------------------------------------------- Sprint 5: lot tahsisi

/**
 * Hasta kullanım kalemi → lot tahsisi (bir kalem birden fazla lottan karşılanabilir). DRAFT iken elle seçim
 * (FEFO'yu geçersiz kılma) burada tutulur; kesinleşmede gerçek tahsis yazılır ve değişmez. Lot, kalemin AYNI
 * ürün + AYNI lokasyonuna ait olmak zorundadır (iki bileşik FK).
 */
export const patientMaterialUsageAllocations = kliniva.table(
  "patient_material_usage_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    patientUsageItemId: uuid("patient_usage_item_id").notNull(),
    inventoryItemId: uuid("inventory_item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    stockLotId: uuid("stock_lot_id").notNull(),
    quantity: qty("quantity").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "pmu_alloc_item_fk",
      columns: [t.tenantId, t.patientUsageItemId, t.inventoryItemId, t.locationId],
      foreignColumns: [
        patientMaterialUsageItems.tenantId,
        patientMaterialUsageItems.id,
        patientMaterialUsageItems.inventoryItemId,
        patientMaterialUsageItems.locationId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "pmu_alloc_lot_fk",
      columns: [t.tenantId, t.stockLotId, t.inventoryItemId, t.locationId],
      foreignColumns: [stockLots.tenantId, stockLots.id, stockLots.inventoryItemId, stockLots.locationId],
    }),
    unique("pmu_alloc_uq").on(t.tenantId, t.patientUsageItemId, t.stockLotId),
    check("pmu_alloc_quantity_ck", sql`${t.quantity} > 0`),
    index("pmu_alloc_lot_idx").on(t.tenantId, t.stockLotId),
  ],
);
