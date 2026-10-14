import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit yapılandırması.
 *
 * - Yalnızca MIGRATION_DATABASE_URL'e (mevcut Neon, doğrudan host, şema sahibi rol) bağlanır. Uygulamanın
 *   DATABASE_URL'i (en az yetkili kliniva_app rolü) migration için ASLA kullanılmaz.
 * - Veritabanı OLUŞTURMAZ, shadow database KULLANMAZ.
 * - Yalnızca `generate` (SQL dosyası üretir, DB'ye dokunmaz) ve `migrate` (dosyaları sırayla uygular) kullanılır.
 *   `drizzle-kit push` bu projede KULLANILMAZ (gözden geçirilmemiş şema değişikliği uygular).
 * - schemaFilter: yalnızca "kliniva" Postgres şeması — aynı veritabanındaki diğer şemalara dokunulmaz.
 */
loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

const url = process.env.MIGRATION_DATABASE_URL;
const needsDb = process.argv.some((a) => ["migrate", "pull", "studio", "check"].includes(a));
if (needsDb && !url) {
  throw new Error("MIGRATION_DATABASE_URL is required");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  schemaFilter: ["kliniva"],
  dbCredentials: { url: url ?? "" },
  migrations: { schema: "kliniva", table: "__drizzle_migrations" },
  strict: true,
  verbose: false,
});
