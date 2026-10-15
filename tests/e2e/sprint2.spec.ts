import { expect, test, type Page } from "@playwright/test";
import { E2E_SURNAME, EMAIL, PASSWORD, login, noOverflow, purgeE2EData, watch } from "./support/helpers";

/**
 * Sprint 2 E2E — gerçek tarayıcıda tam akış: yeni hasta → KVKK aydınlatma → açık rıza → statik imza → tamamlandı →
 * hasta dosyası → PDF → tablet odak ekranında yeni belge imzalama → şablon ayarları.
 * 768x1024 (tablet) ve 1440x900 (masaüstü). CSP ihlali, konsol hatası ve yatay taşma OLMAMALI.
 * Oluşturulan hastalar ayırt edici soyadla açılır ve test sonunda yasal imha yoluyla temizlenir.
 */
test.describe.configure({ mode: "serial", timeout: 120_000 });

test.afterAll(purgeE2EData);

async function drawSignature(page: Page) {
  const canvas = page.getByTestId("signature-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + box.width * (0.15 + i * 0.05), box.y + box.height * (0.6 - (i % 2) * 0.25));
  }
  await page.mouse.up();
}

for (const viewport of [
  { width: 768, height: 1024, name: "tablet", first: "Ayşe" },
  { width: 1440, height: 900, name: "masaüstü", first: "Elif" },
]) {
  test(`tam KVKK akışı (${viewport.name} ${viewport.width}x${viewport.height})`, async ({ page }) => {
    test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const problems = watch(page);
    await login(page);

    // 1 — Hasta bilgileri
    await page.goto("/patients/new");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Yeni hasta");
    await noOverflow(page, "adım 1");
    const phone = `0539${String(Date.now()).slice(-7)}`;
    await page.locator("#pw-firstName").fill(viewport.first);
    await page.locator("#pw-lastName").fill(E2E_SURNAME);
    await page.locator("#pw-phone").fill(phone);
    await page.getByRole("button", { name: "Devam et" }).click();

    // 2 — KVKK aydınlatma (bilgilendirme; rıza değil)
    await expect(page.getByRole("region", { name: "Belge metni" })).toContainText("6698", {
      timeout: 15_000,
    });
    await noOverflow(page, "adım 2");
    const cont = page.getByRole("button", { name: "Devam et" });
    await expect(cont).toBeDisabled();
    await page.getByLabel("Aydınlatma metnini okudum ve bilgilendirildim.").check();
    await cont.click();

    // 3 — Açık rıza: her kanal ayrı, önceden seçili değil
    const groups = page.getByRole("group");
    await expect(groups).toHaveCount(4);
    await noOverflow(page, "adım 3");
    await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);
    for (let i = 0; i < 4; i++) {
      await groups
        .nth(i)
        .getByLabel(i === 0 ? "Onaylıyorum" : "Onaylamıyorum")
        .check();
    }
    await page.getByRole("button", { name: "Devam et" }).click();

    // 4 — İmza
    await expect(page.getByText("Bu imza, yukarıda görüntülenen belgenin bu sürümüne aittir.")).toBeVisible();
    await noOverflow(page, "adım 4");
    const sign = page.getByRole("button", { name: "İmzala" });
    await expect(sign).toBeDisabled();
    await drawSignature(page);
    await expect(sign).toBeEnabled();
    await sign.click();

    // 5 — Tamamlandı
    await expect(page.getByRole("heading", { name: "Kayıt tamamlandı" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/KLI-\d{6}/)).toBeVisible();
    await page.getByRole("link", { name: "Hasta dosyasını aç" }).click();

    // Hasta dosyası
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${viewport.first} ${E2E_SURNAME}`);
    await expect(page.getByText("KVKK: Tamamlandı")).toBeVisible();
    await expect(page.getByText("Onaylı")).toHaveCount(1);
    await expect(page.getByText("Reddedildi")).toHaveCount(3);
    await expect(page.getByRole("tab", { name: /Tıbbi/ })).toHaveCount(0);
    await noOverflow(page, "hasta genel bakış");
    const patientUrl = page.url();

    await page.getByRole("link", { name: "Belgeler" }).click();
    await expect(page.getByText("İmzalı")).toHaveCount(2);
    await noOverflow(page, "hasta belgeler");
    const pdfHref = await page.getByRole("link", { name: "PDF görüntüle" }).first().getAttribute("href");
    const pdf = await page.request.get(pdfHref!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect(pdf.headers()["cache-control"]).toBe("private, no-store");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.headers()["content-disposition"]).not.toContain(E2E_SURNAME);

    // Tablet odak ekranı: yeni KVKK belgesi → imza (kenar menü yok)
    await page.getByLabel("Yeni belge").selectOption("KVKK_DISCLOSURE");
    await page.getByRole("button", { name: "İmzaya hazırla" }).click();
    await expect(page).toHaveURL(/\/documents\/sign\?doc=/);
    await expect(page.getByRole("navigation", { name: "Ana menü" })).toHaveCount(0);
    await noOverflow(page, "imza odak ekranı");
    await page.getByLabel("Aydınlatma metnini okudum ve bilgilendirildim.").check();
    await drawSignature(page);
    await page.getByRole("button", { name: "İmzala" }).click();
    await expect(page).toHaveURL(/tab=documents/, { timeout: 30_000 });
    await expect(page.getByText("İmzalı")).toHaveCount(3);

    // Aktivite
    await page.goto(`${patientUrl}?tab=activity`);
    await expect(page.getByText("Belge imzalandı").first()).toBeVisible();
    await noOverflow(page, "aktivite");

    // Liste + şablon ayarları
    await page.goto(`/patients?q=${E2E_SURNAME}`);
    await expect(page.getByRole("link", { name: `${viewport.first} ${E2E_SURNAME}` })).toBeVisible();
    await noOverflow(page, "hasta listesi");
    await page.goto("/settings/documents");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Belge şablonları");
    await expect(page.getByText("Yayında").first()).toBeVisible();
    await noOverflow(page, "şablon ayarları");

    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });
}

test("Sprint 2 ekranları oturumsuz /login'e yönlendirir", async ({ page }) => {
  for (const path of [
    "/patients/new",
    "/settings/documents",
    "/patients/00000000-0000-4000-8000-000000000000/documents/sign",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});
