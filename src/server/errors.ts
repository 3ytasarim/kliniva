/**
 * Uygulama hataları. İstemciye yalnızca `code` ve genel `message` döner — iç ayrıntı, SQL, stack, veri dönmez.
 * Başka kiracının kaydı ile hiç var olmayan kayıt AYNI NotFound hatasını üretir (IDOR'da varlık sızdırmaz).
 */
export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "BAD_ORIGIN"
  | "ROOM_SCHEDULE_CONFLICT"
  | "DOCTOR_SCHEDULE_CONFLICT"
  | "DOCUMENT_ALREADY_SIGNED"
  | "DOCUMENT_INTEGRITY_FAILED"
  | "APPOINTMENT_CONFLICT"
  | "ROOM_APPOINTMENT_CONFLICT"
  | "PATIENT_APPOINTMENT_CONFLICT"
  | "SLOT_NOT_AVAILABLE"
  | "APPOINTMENT_IN_PAST"
  | "BOOKING_OUT_OF_RANGE"
  | "INVALID_STATUS_TRANSITION"
  | "INSUFFICIENT_STOCK"
  | "LOT_EXPIRED"
  | "LOT_RECALLED"
  | "TRACKING_MODE_CHANGE_REQUIRES_MIGRATION"
  | "LOT_TRACKING_ALREADY_IN_USE"
  | "VOICE_SESSION_LIMIT"
  | "VOICE_UNAVAILABLE"
  | "VOICE_DISABLED";

const STATUS: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  BAD_ORIGIN: 403,
  ROOM_SCHEDULE_CONFLICT: 409,
  DOCTOR_SCHEDULE_CONFLICT: 409,
  DOCUMENT_ALREADY_SIGNED: 409,
  DOCUMENT_INTEGRITY_FAILED: 422,
  APPOINTMENT_CONFLICT: 409,
  ROOM_APPOINTMENT_CONFLICT: 409,
  PATIENT_APPOINTMENT_CONFLICT: 409,
  SLOT_NOT_AVAILABLE: 409,
  APPOINTMENT_IN_PAST: 422,
  BOOKING_OUT_OF_RANGE: 422,
  INVALID_STATUS_TRANSITION: 409,
  INSUFFICIENT_STOCK: 409,
  LOT_EXPIRED: 409,
  LOT_RECALLED: 409,
  TRACKING_MODE_CHANGE_REQUIRES_MIGRATION: 409,
  LOT_TRACKING_ALREADY_IN_USE: 409,
  VOICE_SESSION_LIMIT: 429,
  VOICE_UNAVAILABLE: 503,
  VOICE_DISABLED: 403,
};

const MESSAGES: Record<AppErrorCode, string> = {
  UNAUTHENTICATED: "Oturum gerekli.",
  FORBIDDEN: "Bu işlem için yetkiniz yok.",
  NOT_FOUND: "Kayıt bulunamadı.",
  VALIDATION: "Geçersiz istek.",
  RATE_LIMITED: "Çok fazla deneme. Lütfen daha sonra tekrar deneyin.",
  CONFLICT: "İşlem mevcut durumla çakışıyor.",
  BAD_ORIGIN: "İstek kaynağı doğrulanamadı.",
  ROOM_SCHEDULE_CONFLICT: "Bu oda seçilen zaman aralığında başka bir doktora atanmış.",
  DOCTOR_SCHEDULE_CONFLICT: "Doktorun bu zaman aralığında başka bir planı var.",
  DOCUMENT_ALREADY_SIGNED: "Bu belge zaten imzalanmış.",
  DOCUMENT_INTEGRITY_FAILED: "Belge bütünlük doğrulamasından geçemedi; belge sunulamıyor.",
  APPOINTMENT_CONFLICT: "Doktorun bu saatte başka bir randevusu var.",
  ROOM_APPOINTMENT_CONFLICT: "Bu saatte uygun oda kalmadı.",
  PATIENT_APPOINTMENT_CONFLICT: "Hastanın bu saatle çakışan başka bir randevusu var.",
  SLOT_NOT_AVAILABLE: "Seçilen saat artık uygun değil. Lütfen uygun saatleri yenileyin.",
  APPOINTMENT_IN_PAST: "Geçmiş bir zamana randevu oluşturulamaz.",
  BOOKING_OUT_OF_RANGE: "Seçilen tarih randevu alınabilecek aralığın dışında.",
  INVALID_STATUS_TRANSITION: "Kayıt bu duruma geçirilemez.",
  INSUFFICIENT_STOCK: "Seçilen lokasyonda yeterli stok yok.",
  LOT_EXPIRED: "Bu lotun son kullanma tarihi geçmiş; hasta kullanımında seçilemez.",
  LOT_RECALLED: "Bu lot geri çağrılmış; kullanılamaz.",
  TRACKING_MODE_CHANGE_REQUIRES_MIGRATION:
    "Stoğu olan üründe lot takibi açılamaz. Önce fiziksel sayım ile stoğu sıfırlayıp lotlu giriş yapın.",
  LOT_TRACKING_ALREADY_IN_USE: "Lot geçmişi olan üründe lot / SKT takibi kapatılamaz.",
  VOICE_SESSION_LIMIT: "Çok fazla açık sesli asistan oturumu var. Diğer oturumları kapatıp tekrar deneyin.",
  VOICE_UNAVAILABLE: "Sesli asistan şu anda kullanılamıyor.",
  VOICE_DISABLED: "Sesli asistan bu klinikte kapalı.",
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  /** Yalnızca alan adları (değer değil) — form hatalarını göstermek için. */
  readonly fields?: string[];

  constructor(code: AppErrorCode, opts?: { fields?: string[]; message?: string }) {
    super(opts?.message ?? MESSAGES[code]);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.fields = opts?.fields;
  }

  toJSON() {
    return {
      error: { code: this.code, message: this.message, ...(this.fields ? { fields: this.fields } : {}) },
    };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
