import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";

/** E2E ortak yardımcıları: seed giriş bilgileri (.env.local — çıktıya yazılmaz), hata izleme, taşma kontrolü. */
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
export const SLUG = process.env.SEED_TENANT_SLUG ?? "demo-klinik";
export const EMAIL = process.env.SEED_OWNER_EMAIL ?? "";
export const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "";
export const E2E_SURNAME = "E2E-Otomasyon";

/** E2E'nin oluşturduğu hastaları (ve randevularını / belgelerini) yasal imha yoluyla temizler. Sabit komut. */
export function purgeE2EData() {
  execSync("npx tsx --conditions=react-server tests/e2e/support/purge-e2e-patients.ts", { stdio: "inherit" });
}

export function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || /Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) {
      problems.push(`${m.type()}: ${m.text()} @ ${new URL(m.location().url || "http://x/").pathname}`);
    }
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`http ${r.status()}: ${new URL(r.url()).pathname}`);
  });
  return problems;
}

/** Global setup'ın oturum dosyası (gitignore; çalışma sonunda silinir). */
export const AUTH_FILE = path.join(".playwright-auth", "owner.json");

/** Tek seferlik global girişin çerezlerini kullanır — testler parola yazmaz, giriş sınırına takılmaz. */
export async function login(page: Page) {
  const state = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as {
    cookies: Parameters<BrowserContext["addCookies"]>[0];
  };
  await page.context().addCookies(state.cookies);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
}

export async function noOverflow(page: Page, where: string) {
  const offenders = await page.evaluate(() => {
    if (document.documentElement.scrollWidth <= window.innerWidth + 1) return [];
    // Tanılama: görünür alanın sağına taşan en dıştaki öğeler (kaydırılabilir kapsayıcı içindekiler hariç).
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.right <= window.innerWidth + 1 || r.width === 0) continue;
      let p = el.parentElement;
      let clipped = false;
      while (p && p !== document.body) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === "auto" || ov === "hidden" || ov === "scroll") {
          clipped = true;
          break;
        }
        p = p.parentElement;
      }
      if (!clipped)
        out.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)} right=${Math.round(r.right)}`,
        );
    }
    return out.slice(0, 8);
  });
  expect(offenders, `yatay taşma: ${where}`).toEqual([]);
}
