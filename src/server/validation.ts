import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export const uuidSchema = z.string().regex(UUID_RE, "invalid id");

export const emailSchema = z.string().trim().max(254).pipe(z.email());

/** E-postayı karşılaştırma için normalize eder (küçük harf, boşluksuz). */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** TR telefon / uluslararası: rakam, boşluk, +, -, () — 7..20 karakter. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+0-9()\-\s]{7,20}$/, "invalid phone");

export const nameSchema = z.string().trim().min(1).max(100);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, "invalid slug");
