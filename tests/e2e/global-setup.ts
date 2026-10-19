import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type FullConfig } from "@playwright/test";
import { AUTH_FILE, AUTH_FILE_DOCTOR, AUTH_FILE_RECEPTION, EMAIL, PASSWORD, SLUG } from "./support/helpers";

/**
 * Tek seferlik giriş: hesap başına giriş sınırını (15 dk'da 5) gevşetmeden tüm E2E dosyaları aynı oturumları kullanır.
 * Parolalar yalnızca burada yazılır (test değil → hata anlık görüntüsü / artefakt üretmez). Hata mesajında sır yoktur.
 *  - Sahip: seed kimlik bilgileri (.env.local).
 *  - Resepsiyon + demo doktor (Sprint 6 gerçek zamanlı / onay akışları): prepare-e2e-users.ts her çalıştırmada yeni
 *    rastgele parola üretir ve YALNIZCA bu sürecin belleğine (stdout borusu) verir; diske / loga yazılmaz.
 * Oturum dosyaları globalTeardown'da silinir.
 */
async function loginAndSave(
  browser: Browser,
  baseURL: string,
  creds: { email: string; password: string },
  file: string,
  landing: RegExp,
) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Klinik kodu").fill(SLUG);
    await page.getByLabel("E-posta veya kullanıcı adı").fill(creds.email);
    await page.getByLabel("Parola").fill(creds.password);
    await page.getByRole("button", { name: "Giriş yap" }).click();
    try {
      await page.waitForURL(landing, { timeout: 30_000 });
    } catch {
      throw new Error(
        `E2E global setup: giriş başarısız (${path.basename(file, ".json")}) — oran sınırı veya kimlik bilgisi.`,
      );
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(await context.storageState()));
  } finally {
    await context.close();
  }
}

export default async function globalSetup(config: FullConfig) {
  if (!EMAIL || !PASSWORD) return;
  const baseURL = config.projects[0]!.use.baseURL!;
  const raw = execSync("npx tsx --conditions=react-server tests/e2e/support/prepare-e2e-users.ts", {
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
  const extra = JSON.parse(raw) as {
    reception: { email: string; password: string };
    doctor: { email: string; password: string };
  };
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    await loginAndSave(browser, baseURL, { email: EMAIL, password: PASSWORD }, AUTH_FILE, /\/dashboard$/);
    await loginAndSave(browser, baseURL, extra.reception, AUTH_FILE_RECEPTION, /\/(dashboard|appointments)/);
    await loginAndSave(browser, baseURL, extra.doctor, AUTH_FILE_DOCTOR, /\/(dashboard|doctor)/);
  } finally {
    await browser.close();
  }
}
