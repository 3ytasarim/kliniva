/**
 * APP_ENCRYPTION_KEY güvenlik doğrulaması — anahtarın kendisi ASLA yazdırılmaz.
 *
 * Kontroller:
 *   1. Biçim: base64, tam 32 bayt (256 bit)
 *   2. Yer tutucu / tahmin edilebilir değil (bilinen örnekler, tekrar eden bayt, düşük çeşitlilik)
 *   3. Entropi tahmini (32 baytlık rastgele anahtarda ~ 4.8+ bit/bayt beklenir)
 *   4. Kaynak kodda yok (Git'in izlediği + izlenmeyen-ignore-edilmemiş dosyalar)
 *   5. Git geçmişinde yok (tüm commit'ler; desen stdin'den verilir, komut satırına/çıktıya girmez)
 *   6. Veritabanında yok (MIGRATION_DATABASE_URL tanımlıysa: tüm kliniva metin sütunları, her kiracı bağlamında)
 *
 *   npm run security:check-key            → yalnızca rapor
 *   npm run security:check-key -- --fix   → biçim/zayıflık sorununda .env.local'a yeni anahtar yazar (yazdırmaz)
 *     ⚠ Mevcut şifreli veri varken anahtar değiştirmek o veriyi okunamaz kılar; --fix yalnızca veri yokken kullanılır.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import { safeError } from "./lib/db-introspect";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

const PLACEHOLDERS = [
  "changeme",
  "change-me",
  "secret",
  "development",
  "dev-key",
  "test",
  "placeholder",
  "your-key-here",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
];

function shannonBitsPerByte(buf: Buffer): number {
  const freq = new Map<number, number>();
  for (const b of buf) freq.set(b, (freq.get(b) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

async function main() {
  const fix = process.argv.includes("--fix");
  const raw = process.env.APP_ENCRYPTION_KEY;
  const problems: string[] = [];
  const ok = (m: string) => console.log(`✓ ${m}`);

  if (!raw) {
    problems.push("APP_ENCRYPTION_KEY tanımlı değil");
  } else {
    const key = Buffer.from(raw, "base64");
    const canonical = key.toString("base64") === raw.replace(/\s/g, "");
    if (key.length !== 32 || !canonical) problems.push("biçim: base64 kodlu tam 32 bayt (256 bit) değil");
    else ok("biçim: base64, 32 bayt (256 bit)");

    if (PLACEHOLDERS.some((p) => raw.toLowerCase().includes(p.toLowerCase())))
      problems.push("yer tutucu / bilinen örnek değer");
    const distinct = new Set(key).size;
    const entropy = shannonBitsPerByte(key);
    // 32 rastgele baytta beklenen farklı bayt sayısı ~30, Shannon ~4.8 bit/bayt; eşikler güvenli tarafta.
    if (distinct < 24 || entropy < 4.3) problems.push("düşük çeşitlilik / tahmin edilebilir anahtar");
    else ok(`entropi tahmini yeterli (farklı bayt: ${distinct}/32)`);

    // Kaynak kod
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const inSource = files.filter((f) => {
      try {
        return readFileSync(f, "utf8").includes(raw);
      } catch {
        return false;
      }
    });
    if (inSource.length) problems.push(`kaynak kodda bulundu: ${inSource.join(", ")}`);
    else ok(`kaynak kodda yok (${files.length} dosya tarandı)`);

    // Git geçmişi (desen stdin → komut satırında / çıktıda görünmez)
    const revs = execFileSync("git", ["rev-list", "--all"], { encoding: "utf8" }).split("\n").filter(Boolean);
    if (!revs.length) ok("Git geçmişinde yok (henüz commit yok)");
    else {
      const g = spawnSync("git", ["grep", "-q", "-F", "-f", "-", ...revs], {
        input: `${raw}\n`,
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (g.status === 0)
        problems.push("Git geçmişinde bulundu — anahtar döndürülmeli ve geçmiş temizlenmeli");
      else ok(`Git geçmişinde yok (${revs.length} commit)`);
    }

    // Veritabanı
    const url = process.env.MIGRATION_DATABASE_URL;
    if (!url) console.log("ℹ veritabanı taraması atlandı: MIGRATION_DATABASE_URL eksik");
    else {
      const c = new Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
      await c.connect();
      try {
        await c.query("BEGIN READ ONLY");
        const exists = await c.query(`select to_regclass('kliniva.tenants') is not null as e`);
        if (!exists.rows[0]?.e) ok("veritabanında kliniva şeması yok — taranacak veri yok");
        else {
          const tables = await c.query(`
            select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'kliniva' and c.relkind = 'r'`);
          const tenantIds = (await c.query(`select id from kliniva.tenants`)).rows.map((r) => r.id as string);
          let hits = 0;
          for (const ctx of ["", ...tenantIds]) {
            await c.query(`select set_config('app.tenant_id', $1, true)`, [ctx]);
            for (const { t } of tables.rows) {
              const r = await c.query(
                `select count(*)::int as n from kliniva.${(t as string).replace(/[^a-z_]/g, "")} x where x::text like '%' || $1 || '%'`,
                [raw],
              );
              hits += r.rows[0]?.n ?? 0;
            }
          }
          if (hits) problems.push("veritabanında anahtar değeri bulundu");
          else ok(`veritabanında yok (${tables.rowCount} tablo, ${tenantIds.length} kiracı bağlamı)`);
        }
        await c.query("ROLLBACK");
      } finally {
        await c.end();
      }
    }
  }

  if (problems.length) {
    for (const p of problems) console.log(`✖ ${p}`);
    const formatProblem = problems.some((p) => /biçim|yer tutucu|düşük|tanımlı değil/.test(p));
    if (fix && formatProblem) {
      const env = readFileSync(".env.local", "utf8");
      const next = `APP_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`;
      writeFileSync(
        ".env.local",
        /^APP_ENCRYPTION_KEY=.*$/m.test(env)
          ? env.replace(/^APP_ENCRYPTION_KEY=.*$/m, next)
          : `${env}\n${next}\n`,
      );
      console.log("→ .env.local'a yeni 256-bit anahtar yazıldı (değer yazdırılmadı).");
    }
    process.exit(1);
  }
  console.log("APP_ENCRYPTION_KEY: GÜVENLİ");
}

main().catch((e: unknown) => {
  console.error(`check-encryption-key başarısız: ${safeError(e)}`);
  process.exit(1);
});
