import "server-only";
import { z } from "zod";

/**
 * Sunucu ortam değişkenleri. Bu modül YALNIZCA sunucuda yüklenir ("server-only"); istemci paketine girerse build kırılır.
 *
 * Kural: Değerler asla hata mesajına, log'a veya yanıta yazılmaz. Eksik/hatalı değişkende yalnızca ADI söylenir.
 */
const encryptionKey = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length === 32, { message: "must be 32 bytes, base64" });

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: encryptionKey,
  APP_ORIGIN: z.url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** DATABASE_URL'i doğrular; değerini asla mesaja koymaz. */
export function requireDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const url = source.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error("DATABASE_URL is required");
  }
  return url;
}

/**
 * Migration / yönetim bağlantısı (doğrudan, pooler olmayan host; şema sahibi rol). Uygulama çalışma anında
 * KULLANILMAZ — yalnızca drizzle-kit, seed, rol kurulumu ve test fikstürleri.
 */
export function requireMigrationDatabaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  const url = source.MIGRATION_DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error("MIGRATION_DATABASE_URL is required");
  }
  return url;
}

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  requireDatabaseUrl();
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Yalnızca değişken adları ve kural raporlanır — değerler değil.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
    throw new Error(`Invalid server environment: ${names}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProduction = () => process.env.NODE_ENV === "production";
