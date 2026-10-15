import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvLocal } from "../support/load-env-local";
import { describe, expect, it } from "vitest";

/**
 * Build sonrası istemci paketi taraması (.next/static — tarayıcıya giden her şey).
 * DATABASE_URL / APP_ENCRYPTION_KEY değerleri, adları, bağlantı dizesi deseni ve sunucu modülleri bulunmamalı.
 * Gerçek değerler yalnızca karşılaştırma için okunur; asla yazdırılmaz (hata mesajında da yalnızca dosya adı).
 */
loadEnvLocal();

const STATIC_DIR = path.join(process.cwd(), ".next", "static");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("İstemci paketi (client bundle)", () => {
  it("build mevcut", () => {
    expect(existsSync(STATIC_DIR), "önce `npm run build` çalıştırın").toBe(true);
  });

  const files = existsSync(STATIC_DIR)
    ? walk(STATIC_DIR).filter((f) => /\.(js|css|json|html|map)$/.test(f))
    : [];

  it("taranacak dosya var", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("DATABASE_URL ve APP_ENCRYPTION_KEY hiçbir istemci dosyasına girmez (ad, değer, desen)", () => {
    const secretValues = [process.env.DATABASE_URL, process.env.APP_ENCRYPTION_KEY].filter(
      (v): v is string => typeof v === "string" && v.length >= 16,
    );
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      const rel = path.relative(process.cwd(), f);
      if (content.includes("DATABASE_URL")) offenders.push(`${rel}: DATABASE_URL adı`);
      if (content.includes("APP_ENCRYPTION_KEY")) offenders.push(`${rel}: APP_ENCRYPTION_KEY adı`);
      if (/postgres(ql)?:\/\/[^\s"'`]+@/.test(content)) offenders.push(`${rel}: bağlantı dizesi deseni`);
      if (secretValues.some((v) => content.includes(v))) offenders.push(`${rel}: sır DEĞERİ`);
    }
    expect(offenders).toEqual([]);
  });

  it("OpenAI API anahtarı (ad, değer, sk- deseni) ve istemci sırrı üretimi istemci paketinde yok", () => {
    const key = process.env.OPENAI_API_KEY;
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      const rel = path.relative(process.cwd(), f);
      if (content.includes("OPENAI_API_KEY")) offenders.push(`${rel}: OPENAI_API_KEY adı`);
      if (/\bsk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/.test(content))
        offenders.push(`${rel}: sk- anahtar deseni`);
      if (key && key.length >= 16 && content.includes(key)) offenders.push(`${rel}: anahtar DEĞERİ`);
      // Kısa ömürlü sır YALNIZCA sunucuda üretilir (tarayıcı yalnızca /api/v1/voice/session çağırır).
      if (content.includes("realtime/client_secrets")) offenders.push(`${rel}: client_secrets üretimi`);
      if (content.includes("OPENAI_REALTIME_MODEL")) offenders.push(`${rel}: sunucu model yapılandırması`);
    }
    expect(offenders).toEqual([]);
  });

  it("sunucu modülleri (argon2, pg, drizzle, şifreleme) istemci paketinde yok", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      for (const marker of [
        "@node-rs/argon2",
        "pg-connection-string",
        "drizzle-orm/node-postgres",
        "aes-256-gcm",
        "set_config('app.tenant_id'",
      ]) {
        if (content.includes(marker)) offenders.push(`${path.relative(process.cwd(), f)}: ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
