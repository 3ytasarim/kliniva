import { expect, test } from "@playwright/test";
import { EMAIL, PASSWORD, login } from "./support/helpers";

/**
 * Sprint 1 E2E — gerçek giriş (seed klinik sahibi; kimlik bilgileri .env.local'dan, çıktıya yazılmaz) ve yeni
 * ekranların üretim build'inde CSP ihlali olmadan render edilmesi.
 */
test("yeni korumalı ekranlar oturumsuz /login'e yönlendirir", async ({ page }) => {
  for (const path of ["/settings/clinic", "/admin/doctors", "/doctor", "/admin/branches"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test("klinik sahibi: sidebar, klinik ayarları, şubeler, odalar, doktorlar — CSP ihlali yok", async ({
  page,
}) => {
  test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) violations.push(m.text());
  });
  await login(page);

  const nav = page.getByRole("navigation", { name: "Ana menü" });
  await expect(nav.getByRole("link", { name: "Doktorlar" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Şubeler" })).toBeVisible();
  // Geliştirilmemiş özellikler bağlantı DEĞİL (tıklanamaz, "Yakında"). Randevular (Sprint 3) ve Stok (Sprint 4) aktif.
  await expect(nav.getByRole("link", { name: /Raporlar/ })).toHaveCount(0);
  await expect(nav.getByText("Raporlar")).toBeVisible();
  await expect(nav.getByRole("link", { name: "Stok" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Randevular" })).toBeVisible();

  const pages: [string, RegExp][] = [
    ["/settings/clinic", /Klinik profili/],
    ["/admin/branches", /Şubeler/],
    ["/admin/rooms", /Odalar/],
    ["/admin/doctors", /Doktorlar/],
  ];
  for (const [path, heading] of pages) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  }

  // Şube detayı → çalışma saatleri formu
  await page.goto("/admin/branches");
  await page.getByRole("link", { name: "Düzenle" }).first().click();
  await expect(page.getByRole("heading", { name: "Çalışma saatleri" })).toBeVisible();

  await page.waitForLoadState("networkidle");
  expect(violations).toEqual([]);
});

test("tablet genişliğinde (768px) doktor ve oda ekranlarında yatay taşma yok", async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
  await page.setViewportSize({ width: 768, height: 1024 });
  await login(page);
  for (const path of ["/admin/doctors", "/admin/rooms", "/settings/clinic"]) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow, path).toBe(false);
  }
});
