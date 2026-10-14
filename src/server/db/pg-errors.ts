/**
 * PostgreSQL hata bilgisini (SQLSTATE + constraint adı) güvenle çıkarır. Drizzle hataları pg hatasını `cause`
 * içinde taşır. Mesaj/parametre DÖNDÜRÜLMEZ (PHI içerebilir) — yalnızca kod ve kısıt adı.
 */
export type PgErrorInfo = { code: string | null; constraint: string | null };

export function pgErrorInfo(e: unknown): PgErrorInfo {
  const inner = ((e as { cause?: unknown })?.cause ?? e) as { code?: unknown; constraint?: unknown };
  return {
    code: typeof inner?.code === "string" ? inner.code : null,
    constraint: typeof inner?.constraint === "string" ? inner.constraint : null,
  };
}

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_CHECK_VIOLATION = "23514";
export const PG_EXCLUSION_VIOLATION = "23P01";
