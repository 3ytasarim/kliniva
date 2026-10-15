/**
 * Bildirim kataloğu — tipler, kategori, önem derecesi ve GÜVENLİ metin. SAF (DB yok → birim test edilebilir).
 *
 * GİZLİLİK: başlık / gövde ASLA hasta adı, telefon, TC kimlik, not, belge içeriği veya geri çağırma gerekçesi
 * içermez. Yalnızca saat, hizmet adı, lot numarası gibi klinik dışı operasyonel bilgi + varlık referansı. Hasta adı
 * UI'da yetki kontrollü servisle (resolveNotificationLinks) çözülür.
 */
export const NOTIFICATION_TYPES = [
  "APPOINTMENT_CREATED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_CONFIRMED",
  "PATIENT_CHECKED_IN",
  "APPOINTMENT_READY_FOR_DOCTOR",
  "APPOINTMENT_APPROVAL_REQUIRED",
  "APPOINTMENT_APPROVED",
  "APPOINTMENT_DECLINED",
  "LOW_STOCK",
  "OUT_OF_STOCK",
  "LOT_EXPIRING_SOON",
  "LOT_EXPIRED",
  "LOT_RECALLED",
  "DOCUMENT_INTEGRITY_FAILED",
  "SYSTEM_SECURITY_ALERT",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type NotificationSeverity = "INFO" | "SUCCESS" | "WARNING" | "CRITICAL";
export type NotificationCategory = "appointments" | "inventory" | "security";

export const CATEGORY_OF: Record<NotificationType, NotificationCategory> = {
  APPOINTMENT_CREATED: "appointments",
  APPOINTMENT_RESCHEDULED: "appointments",
  APPOINTMENT_CANCELLED: "appointments",
  APPOINTMENT_CONFIRMED: "appointments",
  PATIENT_CHECKED_IN: "appointments",
  APPOINTMENT_READY_FOR_DOCTOR: "appointments",
  APPOINTMENT_APPROVAL_REQUIRED: "appointments",
  APPOINTMENT_APPROVED: "appointments",
  APPOINTMENT_DECLINED: "appointments",
  LOW_STOCK: "inventory",
  OUT_OF_STOCK: "inventory",
  LOT_EXPIRING_SOON: "inventory",
  LOT_EXPIRED: "inventory",
  LOT_RECALLED: "inventory",
  DOCUMENT_INTEGRITY_FAILED: "security",
  SYSTEM_SECURITY_ALERT: "security",
};

export const typesOfCategory = (c: NotificationCategory) =>
  NOTIFICATION_TYPES.filter((t) => CATEGORY_OF[t] === c);

/** Güvenlik açısından kritik: kullanıcı tercihiyle KAPATILAMAZ. */
export const MANDATORY_TYPES: ReadonlySet<NotificationType> = new Set([
  "LOT_RECALLED",
  "DOCUMENT_INTEGRITY_FAILED",
  "SYSTEM_SECURITY_ALERT",
]);

export const SEVERITY_OF: Record<NotificationType, NotificationSeverity> = {
  APPOINTMENT_CREATED: "INFO",
  APPOINTMENT_RESCHEDULED: "INFO",
  APPOINTMENT_CANCELLED: "WARNING",
  APPOINTMENT_CONFIRMED: "SUCCESS",
  PATIENT_CHECKED_IN: "INFO",
  APPOINTMENT_READY_FOR_DOCTOR: "INFO",
  APPOINTMENT_APPROVAL_REQUIRED: "WARNING",
  APPOINTMENT_APPROVED: "SUCCESS",
  APPOINTMENT_DECLINED: "WARNING",
  LOW_STOCK: "WARNING",
  OUT_OF_STOCK: "CRITICAL",
  LOT_EXPIRING_SOON: "WARNING",
  LOT_EXPIRED: "CRITICAL",
  LOT_RECALLED: "CRITICAL",
  DOCUMENT_INTEGRITY_FAILED: "CRITICAL",
  SYSTEM_SECURITY_ALERT: "CRITICAL",
};

export const TYPE_LABELS: Record<NotificationType, string> = {
  APPOINTMENT_CREATED: "Yeni randevu",
  APPOINTMENT_RESCHEDULED: "Randevu güncellendi",
  APPOINTMENT_CANCELLED: "Randevu iptal edildi",
  APPOINTMENT_CONFIRMED: "Randevu onaylandı",
  PATIENT_CHECKED_IN: "Hasta giriş yaptı",
  APPOINTMENT_READY_FOR_DOCTOR: "Hasta hazır",
  APPOINTMENT_APPROVAL_REQUIRED: "Onay bekleyen randevu",
  APPOINTMENT_APPROVED: "Randevu doktor tarafından onaylandı",
  APPOINTMENT_DECLINED: "Randevu doktor tarafından reddedildi",
  LOW_STOCK: "Düşük stok",
  OUT_OF_STOCK: "Stok tükendi",
  LOT_EXPIRING_SOON: "SKT yaklaşıyor",
  LOT_EXPIRED: "SKT geçti",
  LOT_RECALLED: "Lot geri çağrıldı",
  DOCUMENT_INTEGRITY_FAILED: "Belge bütünlük uyarısı",
  SYSTEM_SECURITY_ALERT: "Güvenlik uyarısı",
};

/** Şube saat diliminde "Bugün 14:30" / "16.10 14:30". */
export function whenLabel(startIso: string, timezone: string, now = new Date()): string {
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(x);
  const time = new Intl.DateTimeFormat("tr-TR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  const today = day(now);
  const target = day(d);
  if (target === today) return `Bugün ${time}`;
  const tomorrow = day(new Date(now.getTime() + 86_400_000));
  if (target === tomorrow) return `Yarın ${time}`;
  const [, m, dd] = target.split("-");
  return `${dd}.${m} ${time}`;
}

export const timeOnly = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat("tr-TR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );

/** Gövde metni için son savunma: telefon / TC kimlik / e-posta benzeri desen varsa metin düşürülür. */
export function assertSafeText(text: string): string {
  if (/\d{10,}|@|\b\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/.test(text)) {
    throw new Error("NOTIFICATION_UNSAFE_TEXT");
  }
  return text;
}
