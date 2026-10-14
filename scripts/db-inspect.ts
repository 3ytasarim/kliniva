/**
 * Migration öncesi / sonrası SALT OKUNUR inceleme. Hiçbir şema veya veri değiştirmez (READ ONLY transaction).
 * Bağlantı dizesi, host, parola YAZDIRILMAZ.
 *
 *   npm run db:inspect                      → rapor
 *   npm run db:inspect -- --save pre        → kliniva dışı şemaların parmak izini .db-snapshots/pre.json'a yazar
 *   npm run db:inspect -- --compare pre     → mevcut parmak izini kayıtla karşılaştırır
 *
 * Çıkış kodu: sorun varsa 1 (migration'a geçmeden DUR).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
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

const args = process.argv.slice(2);
const saveName = args.includes("--save") ? args[args.indexOf("--save") + 1] : undefined;
const compareName = args.includes("--compare") ? args[args.indexOf("--compare") + 1] : undefined;
const problems: string[] = [];
const notes: string[] = [];
const yn = (b: boolean | null | undefined) => (b == null ? "bilinmiyor" : b ? "EVET" : "hayır");

async function withReadOnly<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
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
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_URL;
  if (!migrationUrl) problems.push("MIGRATION_DATABASE_URL eksik");
  if (!runtimeUrl)
    notes.push("DATABASE_URL eksik (uygulama rolü kurulumu `npm run db:app-role` ile tamamlanır)");

  console.log("── Bağlantılar ─────────────────────────────────────────");
  console.log(
    `MIGRATION_DATABASE_URL: ${migrationUrl ? "tanımlı" : "YOK"} · pooler: ${yn(isPoolerUrl(migrationUrl))}`,
  );
  console.log(
    `DATABASE_URL          : ${runtimeUrl ? "tanımlı" : "YOK"} · pooler: ${yn(isPoolerUrl(runtimeUrl))}`,
  );
  if (migrationUrl && isPoolerUrl(migrationUrl))
    problems.push("MIGRATION_DATABASE_URL pooler host kullanıyor — doğrudan (unpooled) host gerekli");
  if (runtimeUrl && isPoolerUrl(runtimeUrl) === false)
    notes.push("DATABASE_URL pooler değil (üretimde pooled bağlantı önerilir)");

  let migrationDb: string | undefined;
  // Uygulama rolü kurulumu (migration + db:app-role) tamamlanmadan runtime rolü sorunları bilgi olarak raporlanır.
  let appRoleReady = false;
  if (migrationUrl) {
    await withReadOnly(migrationUrl, async (c) => {
      const info = await roleInfo(c);
      migrationDb = info.database;
      const k = await klinivaState(c);
      const fp = await foreignSchemasFingerprint(c);
      const app = await checkAppRole(c);
      appRoleReady = app.exists && app.canLogin;

      console.log("\n── Migration bağlantısı ────────────────────────────────");
      console.log(`Veritabanı adı        : ${info.database}`);
      console.log(`current_user          : ${info.currentUser}`);
      console.log(`PostgreSQL            : ${info.serverVersion}`);
      console.log(`rolsuper / bypassrls  : ${yn(info.rolsuper)} / ${yn(info.rolbypassrls)}`);
      console.log(`createrole / createdb : ${yn(info.rolcreaterole)} / ${yn(info.rolcreatedb)}`);

      console.log("\n── kliniva şeması ──────────────────────────────────────");
      console.log(
        `Şema var mı           : ${yn(k.schemaExists)}${k.schemaOwner ? ` (sahibi: ${k.schemaOwner})` : ""}`,
      );
      console.log(
        `Migration geçmişi     : ${k.migrationsApplied === null ? "yok" : `${k.migrationsApplied} kayıt`}`,
      );
      console.log(`Tablolar              : ${k.tables.length}`);
      if (k.schemaExists && k.migrationsApplied === null) {
        problems.push(
          "kliniva şeması migration geçmişi OLMADAN mevcut — isim çakışması, migration yapılmamalı",
        );
      }
      if (k.tables.length) {
        const missing = EXPECTED_TABLES.filter((t) => !k.tables.includes(t));
        const extra = k.tables.filter((t) => !(EXPECTED_TABLES as readonly string[]).includes(t));
        if (missing.length) notes.push(`Eksik kliniva tabloları: ${missing.join(", ")}`);
        if (extra.length) problems.push(`Beklenmeyen kliniva tabloları: ${extra.join(", ")}`);
        const rlsOn = k.rls.filter((t) => t.enabled).length;
        const forced = k.rls.filter((t) => t.forced).length;
        console.log(
          `RLS ENABLE / FORCE    : ${rlsOn} / ${forced} (beklenen ${RLS_TABLES.length} / ${RLS_TABLES.length})`,
        );
        for (const t of RLS_TABLES) {
          const r = k.rls.find((x) => x.table === t);
          if (r && (!r.enabled || !r.forced))
            problems.push(`RLS eksik: ${t} (enable=${r.enabled}, force=${r.forced})`);
        }
        const owners = [...new Set(k.rls.map((t) => t.owner))];
        console.log(`Tablo sahibi(leri)    : ${owners.join(", ")}`);
      }

      console.log("\n── Uygulama rolü (kliniva_app) ─────────────────────────");
      console.log(
        `Rol var mı            : ${yn(app.exists)}${app.exists ? ` · LOGIN: ${yn(app.canLogin)}` : ""}`,
      );
      if (app.exists) {
        console.log(
          `Tehlikeli öznitelik   : ${app.unsafeAttributes.length ? app.unsafeAttributes.join(", ") : "yok"}`,
        );
        console.log(`kliniva nesne sahibi  : ${app.ownsKlinivaObjects}`);
        console.log(`CREATE public/kliniva : ${yn(app.createOnPublic)} / ${yn(app.createOnKliniva)}`);
        console.log(
          `Yetki matrisi         : ${app.privilegeMismatches.length ? "UYUMSUZ" : "beklenenle aynı"}`,
        );
        for (const m of app.privilegeMismatches) console.log(`   - ${m}`);
        if (app.unsafeAttributes.length)
          problems.push(`kliniva_app tehlikeli özniteliklere sahip: ${app.unsafeAttributes.join(", ")}`);
        if (app.ownsKlinivaObjects) problems.push("kliniva_app kliniva nesnelerinin sahibi");
        if (app.createOnKliniva) problems.push("kliniva_app kliniva şemasında CREATE yetkisine sahip");
        if (app.createOnPublic)
          notes.push(
            "kliniva_app public şemasında CREATE yapabiliyor (muhtemelen PUBLIC'e verilmiş; public şemasına dokunulmadı)",
          );
        if (app.privilegeMismatches.length && k.migrationsApplied)
          problems.push("kliniva_app yetki matrisi beklenenden farklı");
      } else if (!k.schemaExists) {
        notes.push("kliniva_app henüz yok — 0002_app_role migration'ı oluşturacak (isim çakışması yok)");
      }

      console.log("\n── Diğer şemalar (dokunulmayacak) ──────────────────────");
      for (const [name, s] of Object.entries(fp.schemas))
        console.log(`  - ${name}: ${s.tables} tablo · parmak izi ${s.hash}`);
      console.log(`Toplam parmak izi     : ${fp.hash}`);

      if (saveName) {
        mkdirSync(".db-snapshots", { recursive: true });
        writeFileSync(`.db-snapshots/${saveName}.json`, JSON.stringify(fp, null, 2));
        console.log(`Parmak izi kaydedildi : .db-snapshots/${saveName}.json`);
      }
      if (compareName) {
        const before = JSON.parse(readFileSync(`.db-snapshots/${compareName}.json`, "utf8")) as typeof fp;
        if (before.hash === fp.hash)
          console.log(`Karşılaştırma (${compareName}) : AYNI — kliniva dışında değişiklik yok`);
        else {
          problems.push(`kliniva dışındaki şemalar '${compareName}' kaydından bu yana DEĞİŞMİŞ`);
          for (const n of new Set([...Object.keys(before.schemas), ...Object.keys(fp.schemas)])) {
            if (before.schemas[n]?.hash !== fp.schemas[n]?.hash) console.log(`   ! değişen şema: ${n}`);
          }
        }
      }
    });
  }

  if (runtimeUrl) {
    await withReadOnly(runtimeUrl, async (c) => {
      const info = await roleInfo(c);
      const owns = await c.query(
        `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'kliniva' and c.relowner = (select oid from pg_roles where rolname = current_user)`,
      );
      console.log("\n── Runtime bağlantısı (DATABASE_URL) ───────────────────");
      console.log(
        `Veritabanı adı        : ${info.database}${migrationDb && info.database !== migrationDb ? "  ≠ migration veritabanı!" : ""}`,
      );
      console.log(`current_user          : ${info.currentUser}`);
      console.log(`rolsuper / bypassrls  : ${yn(info.rolsuper)} / ${yn(info.rolbypassrls)}`);
      console.log(`kliniva nesne sahibi  : ${owns.rows[0]?.n ?? 0}`);
      if (migrationDb && info.database !== migrationDb)
        problems.push("DATABASE_URL ve MIGRATION_DATABASE_URL farklı veritabanlarına bağlanıyor");
      const runtimeIssue = (m: string) =>
        (appRoleReady ? problems : notes).push(
          appRoleReady ? m : `${m} (kurulum sonrası düzelecek: npm run db:app-role)`,
        );
      if (info.rolsuper || info.rolbypassrls)
        runtimeIssue("Runtime rolü SUPERUSER/BYPASSRLS — RLS etkisiz olur");
      if ((owns.rows[0]?.n ?? 0) > 0) runtimeIssue("Runtime rolü kliniva tablolarının sahibi");
      if (info.currentUser !== APP_ROLE)
        runtimeIssue(`Runtime rolü '${APP_ROLE}' değil (${info.currentUser})`);
      if (urlUser(migrationUrl) && urlUser(migrationUrl) === info.currentUser)
        runtimeIssue("Runtime ve migration aynı rolü kullanıyor");
    });
  }

  console.log("\n── Sonuç ───────────────────────────────────────────────");
  for (const n of notes) console.log(`ℹ ${n}`);
  for (const p of problems) console.log(`✖ ${p}`);
  if (problems.length) {
    console.log("DURUM: SORUN VAR — devam etmeyin.");
    process.exit(1);
  }
  console.log("DURUM: TEMİZ");
}

main().catch((e: unknown) => {
  console.error(`db-inspect başarısız: ${safeError(e)}`);
  process.exit(1);
});
