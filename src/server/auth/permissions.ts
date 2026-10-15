/**
 * RBAC kataloğu — tek doğruluk kaynağı. Veritabanına `syncRbacCatalog()` ile (seed) idempotent olarak yazılır.
 *
 * Yetki kontrolü HER ZAMAN sunucuda yapılır; arayüzde bir düğmeyi gizlemek güvenlik değildir.
 * Sağlık verisi erişimi (patient.health.*) ayrı yetkidir: RECEPTION hasta kaydını görür ama tıbbi notu göremez.
 */
export const PERMISSIONS = {
  "clinic.read": "Klinik bilgilerini görüntüleme",
  "clinic.manage": "Klinik ayarlarını yönetme",
  "branch.read": "Şubeleri görüntüleme",
  "branch.manage": "Şube oluşturma / düzenleme",
  "room.read": "Odaları görüntüleme",
  "room.manage": "Oda oluşturma / düzenleme",
  "user.read": "Kullanıcıları görüntüleme",
  "user.manage": "Kullanıcı oluşturma / rol atama",
  "patient.read": "Hasta kimlik/iletişim bilgilerini görüntüleme",
  "patient.create": "Hasta kaydı oluşturma",
  "patient.update": "Hasta kaydı güncelleme",
  "patient.delete": "Hasta kaydını pasifleştirme",
  "patient.health.read": "Hasta sağlık verisini (tıbbi not) görüntüleme",
  "patient.health.write": "Hasta sağlık verisini yazma",
  "patient.document.read": "Hasta belgelerini (imzalı PDF dahil) görüntüleme / indirme",
  "patient.document.create": "Hasta için belge (KVKK / rıza) oluşturma, rıza geri çekme kaydı",
  "patient.document.present": "Belgeyi hastaya sunma (tablet önizleme)",
  "patient.document.sign": "Belgeyi hastaya imzalatma",
  "patient.document.void": "İmzalı belgeyi geçersiz kılma (VOID)",
  "document.template.manage": "Belge şablonu / versiyon yönetimi",
  "audit.read": "Denetim kayıtlarını görüntüleme",
  // Sprint 1 — doktorlar ve çalışma planı
  "doctor.read": "Doktorları ve profillerini görüntüleme",
  "doctor.manage": "Doktor profili oluşturma / düzenleme / şube ataması",
  "doctor.schedule.read": "Doktor çalışma planlarını görüntüleme",
  "doctor.schedule.manage": "Doktor çalışma planı, oda ataması, izin yönetimi",
  "doctor.self.read": "Doktorun kendi planını görüntülemesi",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_KEYS = [
  "PLATFORM_SUPER_ADMIN",
  "CLINIC_OWNER",
  "CLINIC_ADMIN",
  "BRANCH_MANAGER",
  "DOCTOR",
  "ASSISTANT",
  "RECEPTION",
  "INVENTORY_MANAGER",
  "READ_ONLY",
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** MFA'nın ileride zorunlu kılınacağı roller (bkz. docs/ARCHITECTURE.md → MFA). */
export const MFA_REQUIRED_ROLES: readonly RoleKey[] = ["CLINIC_OWNER", "CLINIC_ADMIN", "DOCTOR"];

/** Hasta belgeleri (KVKK / rıza) — oluştur, sun, imzalat, görüntüle. VOID ayrı ve yalnızca yönetim rollerinde. */
const PATIENT_DOCUMENT_FLOW: Permission[] = [
  "patient.document.read",
  "patient.document.create",
  "patient.document.present",
  "patient.document.sign",
];

const ADMIN_BASE: Permission[] = [
  "clinic.read",
  "branch.read",
  "branch.manage",
  "room.read",
  "room.manage",
  "user.read",
  "user.manage",
  "patient.read",
  "patient.create",
  "patient.update",
  "patient.delete",
  ...PATIENT_DOCUMENT_FLOW,
  "patient.document.void",
  "document.template.manage",
  "audit.read",
  "doctor.read",
  "doctor.manage",
  "doctor.schedule.read",
  "doctor.schedule.manage",
  // Yalnızca kullanıcının KENDİ doktor profili varsa anlamlıdır (başkasının verisine erişim vermez).
  "doctor.self.read",
];

export const SYSTEM_ROLES: Record<RoleKey, { name: string; permissions: Permission[] }> = {
  // Platform yöneticisi kiracı verisine (hasta vb.) bu rolle ERİŞEMEZ. Platform operasyonları ayrı, denetimli
  // araçlarla yapılacaktır. Bu nedenle kiracı yetkisi verilmez.
  PLATFORM_SUPER_ADMIN: { name: "Platform Süper Yönetici", permissions: [] },
  CLINIC_OWNER: {
    name: "Klinik Sahibi",
    permissions: [...ADMIN_BASE, "clinic.manage", "patient.health.read", "patient.health.write"],
  },
  // Klinik yöneticisi idari işleri yürütür; tıbbi nota varsayılan olarak erişmez (minimum gerekli veri).
  CLINIC_ADMIN: { name: "Klinik Yöneticisi", permissions: [...ADMIN_BASE, "clinic.manage"] },
  BRANCH_MANAGER: {
    name: "Şube Müdürü",
    permissions: [
      "clinic.read",
      "branch.read",
      "room.read",
      "room.manage",
      "user.read",
      "patient.read",
      "patient.create",
      "patient.update",
      ...PATIENT_DOCUMENT_FLOW,
      "doctor.read",
      "doctor.schedule.read",
      "doctor.schedule.manage",
    ],
  },
  // Doktor: hasta kaydı açmaz / belge imzalatmaz (resepsiyon akışı). Tıbbi notu yazabilmesi için patient.update.
  DOCTOR: {
    name: "Doktor",
    permissions: [
      "clinic.read",
      "branch.read",
      "room.read",
      "patient.read",
      "patient.update",
      "patient.health.read",
      "patient.health.write",
      "patient.document.read",
      // Yalnızca KENDİ planını görür; plan değişikliği klinik politikasına bağlı (şimdilik yönetim rolleri).
      "doctor.self.read",
    ],
  },
  ASSISTANT: {
    name: "Asistan",
    permissions: [
      "clinic.read",
      "branch.read",
      "room.read",
      "patient.read",
      "patient.update",
      "patient.health.read",
      "patient.document.read",
      "doctor.read",
      "doctor.schedule.read",
    ],
  },
  RECEPTION: {
    name: "Resepsiyon",
    permissions: [
      "clinic.read",
      "branch.read",
      "room.read",
      "patient.read",
      "patient.create",
      "patient.update",
      ...PATIENT_DOCUMENT_FLOW,
      "doctor.read",
      "doctor.schedule.read",
    ],
  },
  INVENTORY_MANAGER: { name: "Stok Sorumlusu", permissions: ["clinic.read", "branch.read", "room.read"] },
  READ_ONLY: { name: "Salt Okunur", permissions: ["clinic.read", "branch.read", "room.read", "doctor.read"] },
};
