/**
 * Uygulama rolünü (kliniva_app) giriş yapabilir hale getirir — MIGRATION_DATABASE_URL ile çalışır.
 *
 *  - Rol ve yetkileri 0002_app_role migration'ı oluşturur; bu betik yalnızca LOGIN + parola ayarlar.
 *  - Parola .env.local'daki KLINIVA_APP_DB_PASSWORD'dür; yoksa kriptografik rastgele üretilip dosyaya eklenir.
 *  - Neon, rol parolasını yalnızca düz metin kabul eder ("Neon only supports being given plaintext passwords") ve
 *    control plane'de kendisi SCRAM-SHA-256 olarak saklar. Parola yalnızca TLS bağlantısı üzerinden gönderilir;
 *    ekrana, log'a veya hata mesajına yazılmaz (hata çıktısı safeError ile yalnızca SQLSTATE + sunucu mesajıdır).
 *  - DATABASE_URL YOKSA: migration bağlantısının host'unun POOLER karşılığı + kliniva_app ile oluşturulup eklenir.
 *    DATABASE_URL VARSA DEĞİŞTİRİLMEZ (mevcut sırlar korunur); yalnızca hangi rolü kullandığı raporlanır.
 *  - Hiçbir parola / bağlantı dizesi ekrana yazdırılmaz.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import { APP_ROLE, checkAppRole, isPoolerUrl, safeError, urlUser } from "./lib/db-introspect";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

const ENV_FILE = ".env.local";

function appendEnv(name: string, value: string) {
  const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(ENV_FILE, `${prefix}${name}=${value}\n`);
}

/** Neon: doğrudan host "ep-xxx.region.aws.neon.tech" → pooler "ep-xxx-pooler.region.aws.neon.tech". */
function pooledRuntimeUrl(migrationUrl: string, password: string): string {
  const u = new URL(migrationUrl);
  const [first, ...rest] = u.hostname.split(".");
  if (first && !first.endsWith("-pooler")) u.hostname = [`${first}-pooler`, ...rest].join(".");
  u.username = APP_ROLE;
  u.password = password;
  return u.toString();
}

async function main() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required");

  let password = process.env.KLINIVA_APP_DB_PASSWORD;
  if (!password) {
    password = randomBytes(32).toString("base64url");
    appendEnv("KLINIVA_APP_DB_PASSWORD", password);
    console.log("KLINIVA_APP_DB_PASSWORD üretildi ve .env.local'a eklendi (değer yazdırılmadı).");
  }

  const c = new Client({ connectionString: migrationUrl, connectionTimeoutMillis: 15_000 });
  await c.connect();
  try {
    const before = await checkAppRole(c);
    if (!before.exists) throw new Error("STOP: kliniva_app yok — önce `npm run db:migrate`");
    if (before.unsafeAttributes.length)
      throw new Error(`STOP: kliniva_app tehlikeli öznitelik: ${before.unsafeAttributes.join(", ")}`);
    // Parola yalnızca base64url karakterleri içerir; yine de literal kaçışı uygulanır.
    await c.query(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD ${c.escapeLiteral(password)}`);
    const after = await checkAppRole(c);
    console.log(
      `kliniva_app: LOGIN ${after.canLogin ? "açık" : "kapalı"} · tehlikeli öznitelik: ${after.unsafeAttributes.length ? after.unsafeAttributes.join(", ") : "yok"} · nesne sahibi: ${after.ownsKlinivaObjects}`,
    );
  } finally {
    await c.end();
  }

  const runtime = process.env.DATABASE_URL;
  if (!runtime) {
    appendEnv("DATABASE_URL", pooledRuntimeUrl(migrationUrl, password));
    console.log("DATABASE_URL eklendi: kliniva_app + pooled host (değer yazdırılmadı).");
  } else if (urlUser(runtime) !== APP_ROLE) {
    console.log(`UYARI: mevcut DATABASE_URL '${APP_ROLE}' rolünü kullanmıyor. Mevcut sır değiştirilmedi;`);
    console.log(
      "       runtime'ı kliniva_app'e geçirmek için DATABASE_URL'i siz güncelleyin (KLINIVA_APP_DB_PASSWORD ile).",
    );
    process.exitCode = 2;
  } else {
    console.log(
      `DATABASE_URL zaten kliniva_app kullanıyor · pooler: ${isPoolerUrl(runtime) ? "evet" : "hayır"}`,
    );
  }

  // Doğrulama: yeni runtime bağlantısıyla gerçekten kliniva_app olarak bağlanılabiliyor mu?
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} }, true);
  const finalUrl =
    process.env.DATABASE_URL ?? (runtime ? undefined : pooledRuntimeUrl(migrationUrl, password));
  if (finalUrl && urlUser(finalUrl) === APP_ROLE) {
    const r = new Client({ connectionString: finalUrl, connectionTimeoutMillis: 15_000 });
    await r.connect();
    try {
      const q = await r.query(
        `select current_user as u, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
      );
      console.log(
        `Runtime bağlantı testi: current_user=${q.rows[0].u} · super=${q.rows[0].rolsuper} · bypassrls=${q.rows[0].rolbypassrls}`,
      );
    } finally {
      await r.end();
    }
  }
}

main().catch((e: unknown) => {
  console.error(`db-app-role başarısız: ${safeError(e)}`);
  process.exit(1);
});
