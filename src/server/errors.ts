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
  | "DOCUMENT_INTEGRITY_FAILED";

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
