/**
 * Yerel .env.local hazırlığı — eksik sırları ÜRETİR ama hiçbir değeri ekrana YAZDIRMAZ.
 *   - APP_ENCRYPTION_KEY yoksa: 32 baytlık rastgele anahtar (base64) eklenir.
 *   - SEED_OWNER_PASSWORD yoksa: geliştirme seed'i için rastgele parola eklenir.
 * DATABASE_URL'e DOKUNULMAZ: mevcut Neon bağlantısı kullanıcı tarafından eklenir.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";

const FILE = ".env.local";
if (!existsSync(FILE)) writeFileSync(FILE, "", { mode: 0o600 });
const current = readFileSync(FILE, "utf8");
const has = (name: string) => new RegExp(`^${name}=.+`, "m").test(current);

const additions: string[] = [];
const added: string[] = [];
const add = (name: string, value: string) => {
  if (has(name)) return;
  additions.push(`${name}=${value}`);
  added.push(name);
};

add("APP_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
add("APP_ORIGIN", "http://localhost:3000");
add("SEED_TENANT_SLUG", "demo-klinik");
add("SEED_OWNER_EMAIL", "owner@demo-klinik.test");
add("SEED_OWNER_PASSWORD", `Kv-${randomBytes(12).toString("base64url")}9`);

if (additions.length) {
  const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
  appendFileSync(FILE, `${prefix}${additions.join("\n")}\n`);
}

console.log(
  added.length ? `.env.local: eklenen değişkenler → ${added.join(", ")}` : ".env.local: eksik değişken yok",
);
console.log(
  `DATABASE_URL: ${has("DATABASE_URL") ? "tanımlı" : "TANIMLI DEĞİL — mevcut Neon bağlantısını .env.local'a ekleyin"}`,
);
