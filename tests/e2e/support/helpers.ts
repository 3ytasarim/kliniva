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

/**
 * Saati gelen randevu kartını bu test bağlamında sessize alır (kullanıcıdaki "Bugün sessize al" ile aynı tercih).
 * Kart engelleyici değildir ama günün saatine göre düğmelerin üstüne gelebilir → testler zamana bağlı olmasın.
 * Kartın kendisi entegrasyon testinde (reminders) doğrulanır.
 */
export async function muteReminders(context: BrowserContext) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("kliniva:reminders-muted-until", "9999-12-31");
    } catch {
      /* depolama kapalı */
    }
  });
}

/** Global setup'ın oturum dosyası (gitignore; çalışma sonunda silinir). */
export const AUTH_FILE = path.join(".playwright-auth", "owner.json");
export const AUTH_FILE_RECEPTION = path.join(".playwright-auth", "reception.json");
export const AUTH_FILE_DOCTOR = path.join(".playwright-auth", "doctor.json");

/** Belirli rolün tek seferlik global giriş çerezleriyle oturum açar (Sprint 6: resepsiyon / doktor bağlamları). */
export async function loginAs(page: Page, who: "owner" | "reception" | "doctor", landing = "/dashboard") {
  const file = who === "owner" ? AUTH_FILE : who === "reception" ? AUTH_FILE_RECEPTION : AUTH_FILE_DOCTOR;
  const state = JSON.parse(readFileSync(file, "utf8")) as {
    cookies: Parameters<BrowserContext["addCookies"]>[0];
  };
  await page.context().addCookies(state.cookies);
  await muteReminders(page.context());
  await page.goto(landing);
}

/** Tek seferlik global girişin çerezlerini kullanır — testler parola yazmaz, giriş sınırına takılmaz. */
export async function login(page: Page) {
  const state = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as {
    cookies: Parameters<BrowserContext["addCookies"]>[0];
  };
  await page.context().addCookies(state.cookies);
  await muteReminders(page.context());
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

/**
 * Okunmamış bildirimleri temizler (rozet yok) — sonraki artış TAM sayıyla ölçülebilsin.
 * Zil ilk listesi gelene kadar 0 gösterir; karar ondan önce verilirse önceki testten kalan okunmamış bildirim
 * "temizlenmiş" sanılır (yarış). Bu yüzden önce gerçek sayı API'den okunur ve zilin onu göstermesi beklenir.
 */
export async function clearUnreadNotifications(page: Page) {
  const bell = page.getByRole("button", { name: /^Bildirimler/ });
  const res = await page.request.get("/api/v1/notifications?limit=1");
  expect(res.ok()).toBe(true);
  const { unread } = (await res.json()) as { unread: number };
  if (unread > 0) {
    await expect(bell).toHaveAccessibleName(`Bildirimler (${unread} okunmamış)`, { timeout: 15_000 });
    await bell.click();
    await page.getByRole("button", { name: "Tümünü okundu işaretle" }).click();
  } else {
    await bell.click();
  }
  await expect(bell).toHaveAccessibleName("Bildirimler", { timeout: 10_000 });
  await page.keyboard.press("Escape");
}
