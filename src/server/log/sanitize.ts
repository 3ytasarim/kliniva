/**
 * PII/PHI temizleme — log'a ve hata izleme sistemlerine giden HER şey buradan geçer.
 *
 * İki katman:
 *  1. Anahtar adı reddi: hassas alan adları (password, token, notes, tc, signature, pdf, databaseUrl…) tamamen
 *     "[REDACTED]" olur — değeri ne olursa olsun.
 *  2. Değer desenleri: anahtar adı masum görünse bile değer içindeki bağlantı dizeleri, e-postalar, telefonlar,
 *     TC kimlik numaraları, Bearer/JWT token'ları, uzun base64 blob'lar (imza/PDF) maskelenir.
 */
const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /pass(word)?|secret|token|cookie|authorization|session|api[-_]?key|encryption|database[-_]?url|connection|dsn|notes?|medical|health|diagnos|tc(kimlik|_?no)?|national[-_]?id|identity|signature|pdf|content|otp|totp|mfa[-_]?code|card|iban/i;

const VALUE_PATTERNS: [RegExp, string][] = [
  [/\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp):\/\/[^\s"']+/gi, "[REDACTED_URL]"],
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[REDACTED_DATA_URI]"],
  [/[A-Za-z0-9+/_-]{120,}={0,2}/g, "[REDACTED_BLOB]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]"],
  // TC kimlik: 11 hane, 0 ile başlamaz
  [/\b[1-9]\d{10}\b/g, "[REDACTED_TCKN]"],
  // telefon: TR cep (0 5xx xxx xx xx / +90…) ve + ile başlayan uluslararası numaralar — son 2 hane bırakılır
  [/(?<![\w-])(?:\+?90[\s-]?)?\(?0?5\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?(\d{2})(?![\w-])/g, "[PHONE]**$1"],
  [/(?<![\w-])\+\d{1,3}[\s-]?\d[\d\s-]{5,13}(\d{2})(?![\w-])/g, "[PHONE]**$1"],
];

const MAX_DEPTH = 6;
const MAX_STRING = 500;

export function sanitizeString(value: string): string {
  let out = value;
  for (const [re, replacement] of VALUE_PATTERNS) out = out.replace(re, replacement);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[BINARY ${value.byteLength}B]`;
  if (value instanceof Error && /^Failed query:/.test(value.message)) {
    // DrizzleQueryError mesajı SQL PARAMETRELERİNİ (hasta adı, telefon, şifreli not…) içerir → asla yazılmaz.
    // Yalnızca altta yatan PostgreSQL hata kodu ve (parametre içermeyen) sunucu mesajı tutulur.
    const cause = (value as { cause?: unknown }).cause as { code?: unknown; message?: unknown } | undefined;
    return {
      name: value.name,
      message: "Failed query [sql/params redacted]",
      code: cause?.code,
      cause: typeof cause?.message === "string" ? sanitizeString(cause.message) : undefined,
    };
  }
  if (value instanceof Error) {
    // Hata mesajı da temizlenir; stack yalnızca dosya/satır içerir ama yine de temizlenir.
    return {
      name: value.name,
      message: sanitizeString(value.message),
      code: (value as { code?: unknown }).code,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeForLog(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : sanitizeForLog(v, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}
