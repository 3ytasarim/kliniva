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
  // Sprint 3 — hizmetler ve randevular
  "service.read": "Klinik hizmetlerini (işlem tiplerini) görüntüleme",
  "service.manage": "Klinik hizmetleri ve doktor-hizmet eşleşmelerini yönetme",
  "appointment.read": "Randevuları görüntüleme (şube kapsamında)",
  "appointment.read.own": "Doktorun YALNIZCA kendi randevularını görüntülemesi",
  "appointment.create": "Randevu oluşturma",
  "appointment.update": "Randevuyu onaylama / muayene notu",
  "appointment.reschedule": "Randevu taşıma",
  "appointment.cancel": "Randevu iptali",
  "appointment.checkin": "Hasta girişi (check-in)",
  "appointment.start": "Muayeneyi başlatma",
  "appointment.complete": "Randevuyu tamamlama",
  "appointment.no_show": "Gelmedi olarak işaretleme",
  "appointment.availability.read": "Doktor uygunluğunu / boş saatleri görüntüleme",
  // Sprint 4 — stok
  "inventory.read": "Stok ürünlerini, lokasyonları ve bakiyeleri görüntüleme (şube kapsamında)",
  "inventory.item.create": "Stok ürünü / kategori / lokasyon oluşturma",
  "inventory.item.update": "Stok ürünü / kategori / lokasyon güncelleme, pasifleştirme",
  "inventory.stock.add": "Stok girişi (ilk stok / alım)",
  "inventory.stock.adjust": "Stok düzeltme (sayım farkı, fire)",
  "inventory.transfer": "Şube içi stok transferi",
  "inventory.transfer.cross_branch": "Şubeler arası stok transferi",
  "inventory.usage.read": "Hasta malzeme kullanımlarını görüntüleme",
  "inventory.usage.create": "Hasta malzeme kullanımı (taslak) oluşturma / düzenleme",
  "inventory.usage.finalize": "Hasta malzeme kullanımını kesinleştirme (stok düşer)",
  "inventory.usage.void": "Kesinleşmiş malzeme kullanımını geçersiz kılma (ters hareket)",
  "inventory.low_stock.read": "Kritik stok raporunu görüntüleme",
  "inventory.reconcile": "Stok bakiyesi doğrulama / uzlaştırma",
  // Sprint 5 — lot / SKT
  "inventory.lot.read": "Lotları ve son kullanma tarihlerini görüntüleme",
  "inventory.lot.manage": "Lotlu stok girişi / transfer / düzeltme",
  "inventory.lot.correct_metadata": "Lot SKT düzeltmesi (yüksek yetki)",
  "inventory.lot.recall": "Lotu geri çağırma (geri alınamaz)",
  "inventory.lot.trace": "Lotun kullanıldığı hastaları izleme (geri çağırma için)",
  "inventory.expiry.read": "SKT yaklaşan / geçmiş stok raporu",
  "inventory.write_off": "Fire / imha (SKT geçmiş stok dahil)",
  "inventory.physical_count": "Fiziksel sayım ve sayım farkı düzeltmesi",
  // Sprint 6 — bildirimler / onay
  "notification.read_own": "Kendi bildirimlerini görüntüleme / okundu işaretleme",
  "notification.preference.manage_own": "Kendi bildirim tercihlerini yönetme",
  "notification.admin.read_failed_events": "Başarısız sistem olaylarını (outbox) görüntüleme",
  "appointment.approve_own": "Kendi onay bekleyen randevusunu onaylama",
  "appointment.decline_own": "Kendi onay bekleyen randevusunu reddetme",
  // Sprint 7 — sesli asistan (araçlar ayrıca alttaki iş izinlerini uygular; ek yetki VERMEZ)
  "voice.use": "Kliniva AI sesli asistanı kullanma",
  // Sprint 8 — hasta hesabı ve kasa (şube kapsamı servis katmanında)
  "billing.read": "Hasta hesaplarını (hizmet bedeli, tahsilat, bakiye) görüntüleme",
  "billing.charge": "Hastaya hizmet bedeli ekleme",
  "billing.payment": "Hastadan tahsilat alma",
  "billing.void": "Hizmet bedeli / tahsilat iptali (gerekçeli, geri alınamaz)",
  "cash.read": "Kasayı ve gelir-gider raporlarını görüntüleme",
  "cash.manage": "Kasa gelir / gider kaydı ve kasa kategorileri",
  // Sprint 8.3 — hasta görevleri (arama / e-posta / görüşme hatırlatmaları)
  "task.read": "Hasta görevlerini görüntüleme (yalnızca kendine atanan / oluşturduğu; task.manage ile tümü)",
  "task.create": "Hasta görevi oluşturma",
  "task.manage": "Şubedeki tüm hasta görevlerini görme, atama ve düzenleme",
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

/** Randevu yönetiminin tamamı (şube kapsamı ayrıca uygulanır). */
const APPOINTMENT_FULL: Permission[] = [
  "appointment.read",
  "appointment.create",
  "appointment.update",
  "appointment.reschedule",
  "appointment.cancel",
  "appointment.checkin",
  "appointment.start",
  "appointment.complete",
  "appointment.no_show",
  "appointment.availability.read",
];

/** Stok yönetimi (katalog + giriş + düzeltme + şube içi transfer). */
const INVENTORY_MANAGE: Permission[] = [
  "inventory.read",
  "inventory.item.create",
  "inventory.item.update",
  "inventory.stock.add",
  "inventory.stock.adjust",
  "inventory.transfer",
  "inventory.low_stock.read",
  "inventory.usage.read",
];
/** Lot / SKT operasyonları (geri çağırma, SKT düzeltme ve hasta izleme HARİÇ). */
const LOT_OPERATE: Permission[] = [
  "inventory.lot.read",
  "inventory.lot.manage",
  "inventory.expiry.read",
  "inventory.write_off",
  "inventory.physical_count",
];
/** Finans: hasta hesabı + kasa (tamamı). Resepsiyon yalnızca görüntüler / bedel ekler / tahsilat alır. */
const FINANCE_FULL: Permission[] = [
  "billing.read",
  "billing.charge",
  "billing.payment",
  "billing.void",
  "cash.read",
  "cash.manage",
];
const BILLING_DESK: Permission[] = ["billing.read", "billing.charge", "billing.payment"];
/** Görevler: tamamı (resepsiyon / yönetim) ve kendi görevleri (doktor / asistan). */
const TASKS_FULL: Permission[] = ["task.read", "task.create", "task.manage"];
const TASKS_OWN: Permission[] = ["task.read", "task.create"];

/** Hasta malzeme kullanımı (VOID hariç). */
const INVENTORY_USAGE: Permission[] = [
  "inventory.read",
  "inventory.usage.read",
  "inventory.usage.create",
  "inventory.usage.finalize",
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
  "service.read",
  "service.manage",
  ...APPOINTMENT_FULL,
  "appointment.read.own",
  ...INVENTORY_MANAGE,
  ...INVENTORY_USAGE,
  "inventory.transfer.cross_branch",
  "inventory.usage.void",
  "inventory.reconcile",
  ...LOT_OPERATE,
  "inventory.lot.correct_metadata",
  "inventory.lot.recall",
  "inventory.lot.trace",
  "notification.admin.read_failed_events",
  // Yalnızca kullanıcının KENDİ doktor kaydının randevusunda anlamlı (servis doktor eşleşmesini zorunlu tutar) —
  // yöneticiye başka doktor adına onay yetkisi VERMEZ; DOCTOR ⊆ CLINIC_OWNER kuralı için burada da bulunur.
  "appointment.approve_own",
  "appointment.decline_own",
  ...FINANCE_FULL,
  ...TASKS_FULL,
];

/** Her kullanıcı yalnızca KENDİ bildirimlerini görür / tercihlerini yönetir (alıcı kapsamı servis katmanında). */
const NOTIFY_OWN: Permission[] = ["notification.read_own", "notification.preference.manage_own"];

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
      "service.read",
      ...APPOINTMENT_FULL,
      // Şube müdürü: kendi şubesinde stok + kullanım + lot; şubeler arası transfer, VOID, geri çağırma, izleme YOK.
      ...INVENTORY_MANAGE,
      ...INVENTORY_USAGE,
      ...LOT_OPERATE,
      // Şube müdürü: kendi şubesinin hasta hesapları ve kasası.
      ...FINANCE_FULL,
      ...TASKS_FULL,
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
      // Randevu: yalnızca KENDİ randevuları (servis görünürlüğü doktoru kendi kaydıyla sınırlar). Resepsiyonsuz akışta
      // da sayılar doğru olsun diye hastanın geldiğini / gelmediğini kendisi işaretler, muayeneyi başlatır / tamamlar.
      // İptal / taşıma resepsiyon ve yönetimdedir.
      "service.read",
      "appointment.read.own",
      "appointment.checkin",
      "appointment.start",
      "appointment.complete",
      "appointment.no_show",
      "appointment.availability.read",
      // Malzeme: yalnızca KENDİ randevusuna bağlı kullanım (servis, doktorun kendi kaydıyla sınırlar).
      // Lotları kullanım sırasında görür; geri çağırma / hasta izleme YOK.
      ...INVENTORY_USAGE,
      "inventory.lot.read",
      // Onay modu: yalnızca KENDİ randevusunu onaylar / reddeder.
      "appointment.approve_own",
      "appointment.decline_own",
      // Takip görevi oluşturur (ör. "sonucu hastaya bildir"); yalnızca kendi atanan / oluşturduğu görevleri görür.
      ...TASKS_OWN,
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
      "service.read",
      "appointment.read",
      "appointment.availability.read",
      ...INVENTORY_USAGE,
      "inventory.low_stock.read",
      "inventory.lot.read",
      ...TASKS_OWN,
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
      "service.read",
      "appointment.read",
      "appointment.create",
      "appointment.update",
      "appointment.reschedule",
      "appointment.cancel",
      "appointment.checkin",
      // Randevu saati geçen ve gelmeyen hastayı işaretler (sunucu saat gelmeden izin vermez).
      "appointment.no_show",
      "appointment.availability.read",
      // Hizmet bedeli ekler, tahsilat alır; iptal ve kasa (gider) yönetimdedir.
      ...BILLING_DESK,
      // Hasta arama / hatırlatma görevlerinin tamamını yönetir.
      ...TASKS_FULL,
      "inventory.read",
      "inventory.low_stock.read",
      "inventory.lot.read",
    ],
  },
  INVENTORY_MANAGER: {
    name: "Stok Sorumlusu",
    permissions: [
      "clinic.read",
      "branch.read",
      "room.read",
      "service.read",
      ...INVENTORY_MANAGE,
      "inventory.transfer.cross_branch",
      ...LOT_OPERATE,
    ],
  },
  READ_ONLY: {
    name: "Salt Okunur",
    permissions: [
      "clinic.read",
      "branch.read",
      "room.read",
      "doctor.read",
      "service.read",
      "appointment.read",
      "inventory.read",
    ],
  },
};

// Bildirim merkezi tüm kiracı rollerinde (platform yöneticisi hariç — kiracı verisi görmez).
for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
  if (key !== "PLATFORM_SUPER_ADMIN") role.permissions.push(...NOTIFY_OWN);
  // Sesli asistan: yalnızca operasyon rolleri (salt okunur rol hariç). Araçlar kendi iş izinlerini ayrıca ister.
  if (key !== "PLATFORM_SUPER_ADMIN" && key !== "READ_ONLY") role.permissions.push("voice.use");
}
