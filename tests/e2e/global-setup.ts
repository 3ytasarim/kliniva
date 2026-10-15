import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import { AUTH_FILE, EMAIL, PASSWORD, SLUG } from "./support/helpers";

/**
 * Tek seferlik giriş: hesap başına giriş sınırını (15 dk'da 5) gevşetmeden tüm E2E dosyaları aynı oturumu kullanır.
 * Parola yalnızca burada yazılır (test değil → hata anlık görüntüsü / artefakt üretmez). Hata mesajında sır yoktur.
 * Oturum dosyası globalTeardown'da silinir.
 */
export default async function globalSetup(config: FullConfig) {
  if (!EMAIL || !PASSWORD) return;
  const baseURL = config.projects[0]!.use.baseURL!;
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Klinik kodu").fill(SLUG);
    await page.getByLabel("E-posta").fill(EMAIL);
    await page.getByLabel("Parola").fill(PASSWORD);
    await page.getByRole("button", { name: "Giriş yap" }).click();
    try {
      await page.waitForURL(/\/dashboard$/, { timeout: 30_000 });
    } catch {
      throw new Error("E2E global setup: seed hesabıyla giriş başarısız (oran sınırı veya kimlik bilgisi).");
    }
    mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    writeFileSync(AUTH_FILE, JSON.stringify(await context.storageState()));
  } finally {
    await browser.close();
  }
}
