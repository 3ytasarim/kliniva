/**
 * Güvenli migration çalıştırıcı — MIGRATION_DATABASE_URL (doğrudan host, şema sahibi rol).
 *
 * 1. Ön kontrol (salt okunur): pooler değil · migration rolü kliniva_app değil · kliniva şeması geçmişsiz çakışmıyor
 *    · kliniva dışı şemaların parmak izi alınır.
 * 2. drizzle migrator: drizzle/ altındaki bekleyen dosyalar TEK transaction içinde uygulanır
 *    (geçmiş tablosu: kliniva.__drizzle_migrations). Veritabanı oluşturmaz; shadow DB yok.
 * 3. Son kontrol: kliniva dışı şemalar değişmedi mi · 15 tablo · RLS ENABLE+FORCE · kliniva_app güvenli mi.
 * Bağlantı dizesi hiçbir yerde yazdırılmaz.
 */
import { loadEnvConfig } from "@next/env";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import {
  APP_ROLE,
  EXPECTED_TABLES,
  RLS_TABLES,
  checkAppRole,
  foreignSchemasFingerprint,
  isPoolerUrl,
  klinivaState,
  roleInfo,
  safeError,
  urlUser,
} from "./lib/db-introspect";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

async function readOnly<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await c.connect();
  try {
    await c.query("BEGIN READ ONLY");
    const out = await fn(c);
    await c.query("ROLLBACK");
    return out;
  } finally {
    await c.end();
  }
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
  if (isPoolerUrl(url))
    throw new Error("STOP: MIGRATION_DATABASE_URL pooler host kullanıyor; doğrudan host gerekli");
  if (urlUser(url) === APP_ROLE)
    throw new Error("STOP: migration uygulama rolü (kliniva_app) ile çalıştırılamaz");

  const pre = await readOnly(url, async (c) => ({
    info: await roleInfo(c),
    kliniva: await klinivaState(c),
    fp: await foreignSchemasFingerprint(c),
  }));
  console.log(
    `Ön kontrol: veritabanı=${pre.info.database} · rol=${pre.info.currentUser} · kliniva şeması=${pre.kliniva.schemaExists ? "var" : "yok"} · geçmiş=${pre.kliniva.migrationsApplied ?? "yok"}`,
  );
  if (pre.kliniva.schemaExists && pre.kliniva.migrationsApplied === null) {
    throw new Error("STOP: kliniva şeması migration geçmişi olmadan mevcut (isim çakışması)");
  }

  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: "./drizzle",
      migrationsSchema: "kliniva",
      migrationsTable: "__drizzle_migrations",
    });
  } finally {
    await pool.end();
  }

  const post = await readOnly(url, async (c) => ({
    kliniva: await klinivaState(c),
    fp: await foreignSchemasFingerprint(c),
    app: await checkAppRole(c),
  }));
  const problems: string[] = [];
  if (post.fp.hash !== pre.fp.hash) problems.push("kliniva DIŞINDAKİ şemalarda değişiklik algılandı");
  const missing = EXPECTED_TABLES.filter((t) => !post.kliniva.tables.includes(t));
  const extra = post.kliniva.tables.filter((t) => !(EXPECTED_TABLES as readonly string[]).includes(t));
  if (missing.length) problems.push(`eksik tablo: ${missing.join(", ")}`);
  if (extra.length) problems.push(`beklenmeyen tablo: ${extra.join(", ")}`);
  const rls = post.kliniva.rls.filter((t) => (RLS_TABLES as readonly string[]).includes(t.table));
  const enabled = rls.filter((t) => t.enabled).length;
  const forced = rls.filter((t) => t.forced).length;
  if (enabled !== RLS_TABLES.length || forced !== RLS_TABLES.length)
    problems.push(`RLS eksik (enable=${enabled}, force=${forced})`);
  if (!post.app.exists) problems.push("kliniva_app oluşturulmadı");
  if (post.app.unsafeAttributes.length)
    problems.push(`kliniva_app tehlikeli öznitelik: ${post.app.unsafeAttributes.join(", ")}`);
  if (post.app.ownsKlinivaObjects) problems.push("kliniva_app nesne sahibi");
  if (post.app.createOnKliniva) problems.push("kliniva_app kliniva şemasında CREATE yapabiliyor");
  if (post.app.privilegeMismatches.length)
    problems.push(...post.app.privilegeMismatches.map((m) => `yetki: ${m}`));

  console.log(`Migration geçmişi: ${pre.kliniva.migrationsApplied ?? 0} → ${post.kliniva.migrationsApplied}`);
  console.log(
    `Tablolar: ${post.kliniva.tables.length}/${EXPECTED_TABLES.length} · RLS ENABLE ${enabled}/${RLS_TABLES.length} · FORCE ${forced}/${RLS_TABLES.length}`,
  );
  console.log(`kliniva dışı şemalar: ${post.fp.hash === pre.fp.hash ? "DEĞİŞMEDİ" : "DEĞİŞTİ!"}`);
  console.log(
    `kliniva_app: ${post.app.exists ? "var" : "yok"} · LOGIN ${post.app.canLogin ? "açık" : "kapalı (npm run db:app-role)"}`,
  );
  if (problems.length) {
    for (const p of problems) console.log(`✖ ${p}`);
    process.exit(1);
  }
  console.log("✓ Migration tamam, son kontroller temiz.");
}

main().catch((e: unknown) => {
  console.error(`migrate başarısız: ${safeError(e)}`);
  process.exit(1);
});
