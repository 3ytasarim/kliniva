import { expect, test } from "@playwright/test";

test("oturumsuz kullanıcı korumalı sayfadan /login'e yönlendirilir", async ({ page }) => {
  for (const path of ["/dashboard", "/patients", "/admin/users", "/settings/security"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test("login sayfası: başlık, erişilebilir form, CSP ve güvenlik başlıkları", async ({ page }) => {
  const res = await page.goto("/login");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/Kliniva AI/);
  await expect(page.getByLabel("Klinik kodu")).toBeVisible();
  await expect(page.getByLabel("E-posta veya kullanıcı adı")).toBeVisible();
  await expect(page.getByLabel("Parola")).toHaveAttribute("type", "password");

  const h = res!.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["permissions-policy"]).toContain("camera=()");
  expect(h["x-powered-by"]).toBeUndefined();
});

test("CSP altında React hydrate olur (konsolda CSP ihlali yok)", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(m.text())) violations.push(m.text());
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "Giriş yap" }).waitFor();
  await page.waitForLoadState("networkidle");
  expect(violations).toEqual([]);
});

test("oturumsuz API isteği 401, bilgi sızdırmaz", async ({ request }) => {
  const res = await request.get("/api/v1/patients");
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: "Oturum gerekli." } });
});

test("mobil genişlikte (360px) yatay kaydırma yok", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/login");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
