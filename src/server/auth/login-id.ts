import { z } from "zod";

/**
 * Giriş kimliği: e-posta ya da kullanıcı adı. Kullanıcı adı klinik içinde benzersizdir; küçük harfe çevrilir.
 * Biçim: harf / rakamla başlar, 3–40 karakter, yalnızca a-z 0-9 . _ - (DB CHECK ile aynı).
 */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

export const normalizeUsername = (v: string) => v.trim().toLocaleLowerCase("tr-TR").replace(/ı/g, "i");

export const usernameSchema = z
  .string()
  .trim()
  .transform(normalizeUsername)
  .refine((v) => USERNAME_RE.test(v), "Kullanıcı adı 3–40 karakter; harf, rakam, nokta, alt çizgi ve tire.");

/** Girişte yazılan değer e-posta mı (içinde @ var) yoksa kullanıcı adı mı? */
export const isEmailLike = (v: string) => v.includes("@");
