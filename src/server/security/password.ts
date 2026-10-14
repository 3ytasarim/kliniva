import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";

/**
 * Parola güvenliği — Argon2id (OWASP önerisi: m=19 MiB, t=2, p=1; burada m=19456 KiB, t=2).
 * @node-rs/argon2 varsayılan algoritması Argon2id'dir; yine de açıkça belirtilir.
 */
const ARGON2ID = 2; // @node-rs/argon2 Algorithm.Argon2id (const enum — isolatedModules nedeniyle sayı)
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** Asgari parola politikası: 12+ karakter, harf + rakam, en çok 128, çok yaygın parolalar yasak. */
const COMMON = new Set([
  "password1234",
  "123456789012",
  "qwerty123456",
  "kliniva12345",
  "parola123456",
  "sifre1234567",
  "admin1234567",
]);

export const passwordPolicy = z
  .string()
  .min(12, "Parola en az 12 karakter olmalı")
  .max(128, "Parola en fazla 128 karakter olabilir")
  .refine((p) => /[A-Za-zÇĞİÖŞÜçğıöşü]/.test(p) && /[0-9]/.test(p), "Parola harf ve rakam içermeli")
  .refine((p) => !COMMON.has(p.toLowerCase()), "Bu parola çok yaygın");

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Kullanıcı bulunamadığında da aynı maliyette doğrulama yapılır (zamanlama ile kullanıcı keşfini önler).
 * Bu özet rastgele bir parolanındır; hiçbir parola ile eşleşmez.
 */
let dummyHash: Promise<string> | undefined;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hash(`dummy-${Math.random()}-${Date.now()}`, OPTIONS);
  await verify(await dummyHash, password).catch(() => false);
  return false;
}
