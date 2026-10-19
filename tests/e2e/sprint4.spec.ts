import { expect, test, type Page } from "@playwright/test";
import { E2E_SURNAME, EMAIL, PASSWORD, login, noOverflow, purgeE2EData, watch } from "./support/helpers";

/**
 * Sprint 4 E2E — stok → transfer → randevu → hasta malzeme kullanımı → stok düşüşü (gerçek tarayıcı, üretim build'i):
 * kategori + ürün oluştur → ilk stok (Ana Depo) → depo → oda transferi → hizmet şablonu (öneri) → randevu oluştur ve
 * başlat → "Malzeme kullanımı ekle" (şablon önerisi) → miktarı düzenle → kesinleştir → oda stoğu düşer, kritik stokta
 * görünür → hareket geçmişinde "Hasta kullanımı" → hasta dosyası "Malzemeler".
 * 768x1024 ve 1440x900; konsol hatası / CSP ihlali / yatay taşma yok. Veriler test sonunda temizlenir (E2E-* kodlu).
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });
test.afterAll(purgeE2EData);

function tomorrowIstanbul(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 24 * 3600_000));
}

const submit = (page: Page, label: string) => page.locator("form button[type=submit]", { hasText: label });

async function createPatient(page: Page, first: string) {
  await page.goto("/patients/new");
  await page.locator("#pw-firstName").fill(first);
  await page.locator("#pw-lastName").fill(E2E_SURNAME);
  await page.locator("#pw-phone").fill(`0535${String(Date.now()).slice(-7)}`);
  await page.getByRole("button", { name: "Devam et" }).click();
  await expect(page.getByRole("region", { name: "Belge metni" })).toBeVisible({ timeout: 15_000 });
}

/** Muayene randevusu oluşturur ve IN_PROGRESS'e getirir; randevu URL'si döner. */
async function bookAndStart(page: Page, patient: string) {
  await page.goto("/appointments/new");
  await page.getByLabel("Hasta ara").fill(patient);
  await page.getByRole("button", { name: "Ara" }).click();
  await page.getByRole("button", { name: new RegExp(`${patient} ${E2E_SURNAME}`) }).click();
  const branch = page.getByLabel("Şube", { exact: true });
  if ((await branch.inputValue()) === "") await branch.selectOption({ index: 1 });
  await page.getByLabel("Hizmet", { exact: true }).selectOption({ label: "Muayene · 30 dk" });
  const doctor = page.getByLabel("Doktor", { exact: true });
  await expect(doctor.locator("option", { hasText: "Demo Doktor" })).toHaveCount(1);
  await doctor.selectOption({ label: "Dr. Demo Doktor" });
  await page.getByLabel("Tarih", { exact: true }).fill(tomorrowIstanbul());
  const slots = page.getByRole("radiogroup", { name: "Uygun saatler" }).getByRole("radio");
  await expect(slots.first()).toBeVisible({ timeout: 20_000 });
  await slots.first().click();
  await page.getByRole("button", { name: "Randevuyu oluştur" }).click();
  await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  for (const [button, status] of [
    ["Onayla", "Onaylandı"],
    ["Hasta geldi (check-in)", "Geldi"],
    ["Başlat", "Muayenede"],
  ] as const) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByText(status, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  }
  return page.url();
}

for (const viewport of [
  { width: 768, height: 1024, name: "tablet", tag: "T" },
  { width: 1440, height: 900, name: "masaüstü", tag: "D" },
]) {
  test(`stok → transfer → hasta kullanımı (${viewport.name} ${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const problems = watch(page);
    await login(page);
    const stamp = `${viewport.tag}${String(Date.now()).slice(-6)}`;
    const itemName = `E2E Punch ${stamp}`;
    const patient = `Malzeme ${viewport.tag}`;

    // Stok paneli
    await page.goto("/inventory");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stok");
    await noOverflow(page, "stok paneli");

    // Kategori + ürün (asgari stok 5)
    await page.goto("/inventory/items");
    await page.getByLabel("Kategori adı").fill(`E2E Kategori ${stamp}`);
    await submit(page, "Kategori ekle").click();
    await expect(page.getByText("Kategori eklendi.")).toBeVisible();
    await page.locator("#ni-name").fill(itemName);
    await page.locator("#ni-code").fill(`E2E-${stamp}`);
    await page.locator("#ni-categoryId").selectOption({ label: `E2E Kategori ${stamp}` });
    await page.locator("#ni-minimumStockLevel").fill("5");
    await noOverflow(page, "ürün listesi");
    await submit(page, "Ürünü oluştur").click();
    await expect(page).toHaveURL(/\/inventory\/items\/[0-9a-f-]{36}$/, { timeout: 20_000 });
    const itemUrl = page.url();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(itemName);

    // İlk stok: Ana Depo 10
    await page.locator("#as-locationId").selectOption({ label: "Merkez Şube · Ana Depo" });
    await page.locator("#as-quantity").fill("10");
    await submit(page, "Stok ekle").click();
    await expect(page.getByText(/Stok eklendi/)).toBeVisible({ timeout: 15_000 });

    // Transfer: Ana Depo → Muayene 1 (6)
    await page.reload();
    await page.locator("summary", { hasText: "Transfer" }).click();
    await page.locator("#tr-fromLocationId").selectOption({ index: 0 });
    await page.locator("#tr-toLocationId").selectOption({ label: "Merkez Şube · Muayene 1" });
    await page.locator("#tr-quantity").fill("6");
    await submit(page, "Transfer et").click();
    await expect(page.getByText("Transfer tamamlandı.")).toBeVisible({ timeout: 15_000 });
    await noOverflow(page, "ürün detayı");

    // Hizmet şablonu (Muayene): ürün × 1 — yalnızca öneri
    await page.goto("/inventory/templates");
    await page.getByLabel("Hizmet", { exact: true }).selectOption({ label: "Muayene" });
    await page.getByRole("button", { name: "Seç" }).click();
    await page.getByRole("checkbox", { name: new RegExp(itemName) }).check();
    await page.getByLabel(`${itemName} varsayılan miktar`).fill("1");
    await submit(page, "Şablonu kaydet").click();
    await expect(page.getByText(/Malzeme şablonu kaydedildi/)).toBeVisible({ timeout: 15_000 });
    await noOverflow(page, "şablonlar");

    // Hasta + randevu (IN_PROGRESS)
    await createPatient(page, patient);
    const apptUrl = await bookAndStart(page, patient);
    await noOverflow(page, "randevu detayı");

    // Malzeme kullanımı: şablon önerisi taslağa gelir; stok henüz düşmez
    await submit(page, "Malzeme kullanımı ekle").click();
    await expect(page).toHaveURL(/\/inventory\/usages\/[0-9a-f-]{36}$/, { timeout: 20_000 });
    await expect(page.getByText("Taslak", { exact: true })).toBeVisible();
    const qty = page.getByLabel(`${itemName} miktarı`);
    await expect(qty).toHaveValue("1");
    await noOverflow(page, "kullanım taslağı");
    await qty.fill("2");
    await page
      .getByRole("row", { name: new RegExp(itemName) })
      .locator("form button[type=submit]", { hasText: "Güncelle" })
      .click();
    await expect(page.getByText("Malzeme eklendi.")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Kesinleştir" }).click();
    await expect(page.getByText("Kesinleşti", { exact: true })).toBeVisible({ timeout: 20_000 });

    // Ürün: oda stoğu 6 − 2 = 4 (asgari 5 → düşük); hareket geçmişinde hasta kullanımı
    await page.goto(itemUrl);
    const room = page
      .getByRole("table")
      .first()
      .getByRole("row", { name: /Muayene 1/ });
    await expect(room).toContainText("4");
    await expect(room).toContainText("Düşük");
    await expect(
      page.locator("#hareketler table").getByText("Hasta kullanımı", { exact: true }).first(),
    ).toBeVisible();

    // Kritik stok paneli
    await page.goto("/inventory");
    // Depo (10 − 6 = 4) ve oda (6 − 2 = 4) ikisi de asgari 5 seviyesinin altında → iki kritik satır.
    await expect(page.getByRole("link", { name: itemName })).toHaveCount(2);

    // Randevu "Kullanılan malzemeler" + hasta dosyası "Malzemeler"
    await page.goto(apptUrl);
    await expect(page.locator("#malzemeler")).toContainText(itemName);
    await page
      .getByRole("link", { name: new RegExp(`${patient} ${E2E_SURNAME}`) })
      .first()
      .click();
    await page.getByRole("link", { name: "Malzemeler", exact: true }).click();
    await expect(page).toHaveURL(/tab=materials/);
    await expect(page.getByText(`${itemName} ×2`)).toBeVisible();
    await expect(page.getByText("Kesinleşti", { exact: true })).toBeVisible();
    await noOverflow(page, "hasta malzemeleri");

    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });
}

test("stok ekranları oturumsuz /login'e yönlendirir", async ({ page }) => {
  for (const path of ["/inventory", "/inventory/items", "/inventory/locations", "/inventory/templates"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});
