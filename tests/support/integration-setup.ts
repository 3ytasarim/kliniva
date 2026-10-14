import { randomBytes } from "node:crypto";
import { loadEnvLocal } from "./load-env-local";

// .env.local'dan bağlantılar okunur (değerler asla yazdırılmaz). Eksikse testler yalnızca değişken adıyla durur.
//   DATABASE_URL           → uygulama (kliniva_app, pooled) — test edilen tüm sorgular
//   MIGRATION_DATABASE_URL → yalnızca fikstür kurulumu/temizliği (şema sahibi, doğrudan host)
loadEnvLocal();
for (const name of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
// Testler gerçek şifreleme anahtarını kullanmaz: test verisi geçicidir ve sonunda silinir.
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.LOG_LEVEL = "error";
process.env.DB_POOL_MAX = "3";
