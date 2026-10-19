import { expect, test, type Page } from "@playwright/test";
import { E2E_SURNAME, EMAIL, PASSWORD, login, noOverflow, purgeE2EData, watch } from "./support/helpers";

/**
 * Sprint 5 E2E — lot / SKT / FEFO / izlenebilirlik / geri çağırma (gerçek tarayıcı, üretim build'i):
 * lot + SKT takipli ürün → Lot1 (yakın SKT) ve Lot2 (uzak SKT) girişi → Lot1 ve Lot2'yi depodan odaya transfer →
 * randevu → kullanım taslağında FEFO önerisi Lot1 → kesinleştir (Lot1 kullanılır) → hasta "Malzemeler"de lot no →
 * SKT sayfasında Lot1 → Lot1 geri çağrılır → yeni kullanımda Lot1 önerilmez (Lot2 önerilir).
 * 768x1024 ve 1440x900; konsol hatası / CSP ihlali / yatay taşma yok. Veriler test sonunda temizlenir (E2E-* kodlu).
 */
test.describe.configure({ mode: "serial", timeout: 240_000 });
test.afterAll(purgeE2EData);

function istanbulDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 24 * 3600_000));
}

const submit = (page: Page, label: string) => page.locator("form button[type=submit]", { hasText: label });

async function createPatient(page: Page, first: string) {
  await page.goto("/patients/new");
  await page.locator("#pw-firstName").fill(first);
  await page.locator("#pw-lastName").fill(E2E_SURNAME);
  await page.locator("#pw-phone").fill(`0536${String(Date.now()).slice(-7)}`);
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
  await page.getByLabel("Tarih", { exact: true }).fill(istanbulDate(1));
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

/** Randevudan yeni kullanım taslağı açar ve ürünü (oda lokasyonu, 1 adet) ekler. */
async function draftUsage(page: Page, apptUrl: string, itemLabel: RegExp) {
  await page.goto(apptUrl);
  await submit(page, "Malzeme kullanımı ekle").click();
  await expect(page).toHaveURL(/\/inventory\/usages\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await page.locator("#ua-inventoryItemId").selectOption({ label: (await optionLabel(page, itemLabel))! });
  await page.locator("#ua-locationId").selectOption({ label: "Muayene 1" });
  await page.locator("#ua-quantity").fill("1");
  await submit(page, "Ekle").click();
  await expect(page.getByText("Malzeme eklendi.")).toBeVisible({ timeout: 15_000 });
}

async function optionLabel(page: Page, re: RegExp) {
  // Seçenekler render edilmeden okunursa etiket undefined olur ve form ilk seçenekle (başka ürün) gönderilir.
  await expect(page.locator("#ua-inventoryItemId option").filter({ hasText: re })).toHaveCount(1, {
    timeout: 15_000,
  });
  const labels = await page.locator("#ua-inventoryItemId option").allTextContents();
  return labels.find((l) => re.test(l));
}

for (const viewport of [
  { width: 768, height: 1024, name: "tablet", tag: "T" },
  { width: 1440, height: 900, name: "masaüstü", tag: "D" },
]) {
  test(`lot + FEFO + izlenebilirlik + geri çağırma (${viewport.name} ${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const problems = watch(page);
    await login(page);
    const stamp = `${viewport.tag}${String(Date.now()).slice(-6)}`;
    const itemName = `E2E Dolgu ${stamp}`;
    const lot1 = `L1-${stamp}`;
    const lot2 = `L2-${stamp}`;
    const patient = `Lot ${viewport.tag}`;

    // Lot + SKT takipli ürün
    await page.goto("/inventory/items");
    await page.locator("#ni-name").fill(itemName);
    await page.locator("#ni-code").fill(`E2E-${stamp}`);
    await page.locator("#ni-trackLots").check();
    await page.locator("#ni-trackExpiry").check();
    await submit(page, "Ürünü oluştur").click();
    await expect(page).toHaveURL(/\/inventory\/items\/[0-9a-f-]{36}$/, { timeout: 20_000 });
    const itemUrl = page.url();

    // Lot1 (yakın SKT) ve Lot2 (uzak SKT) — Ana Depo
    for (const [lot, expiry, kind] of [
      [lot1, istanbulDate(20), "INITIAL_STOCK"],
      [lot2, istanbulDate(200), "PURCHASE"],
    ] as const) {
      await page.goto(itemUrl);
      await page.locator("#as-locationId").selectOption({ label: "Merkez Şube · Ana Depo" });
      await page.locator("#as-kind").selectOption(kind);
      await page.locator("#as-quantity").fill("5");
      await page.locator("#as-lotNumber").fill(lot);
      await page.locator("#as-expiryDate").fill(expiry);
      await submit(page, "Stok ekle").click();
      await expect(page.getByText(/Stok eklendi/)).toBeVisible({ timeout: 15_000 });
    }

    // Transfer: Lot1 (3) ve Lot2 (2) depo → Muayene 1 (lot kimliği korunur)
    for (const [lot, qty] of [
      [lot1, "3"],
      [lot2, "2"],
    ] as const) {
      await page.goto(itemUrl);
      await page.locator("summary", { hasText: "Transfer" }).click();
      await expect(page.locator("#tr-lotRef option").filter({ hasText: `${lot} · Ana Depo` })).toHaveCount(
        1,
        { timeout: 15_000 },
      );
      const refs = await page.locator("#tr-lotRef option").allTextContents();
      await page
        .locator("#tr-lotRef")
        .selectOption({ label: refs.find((r) => r.startsWith(`${lot} · Ana Depo`))! });
      await page.locator("#tr-toLocationId").selectOption({ label: "Merkez Şube · Muayene 1" });
      await page.locator("#tr-quantity").fill(qty);
      await submit(page, "Transfer et").click();
      await expect(page.getByText("Transfer tamamlandı.")).toBeVisible({ timeout: 15_000 });
    }
    await page.goto(itemUrl);
    const lotsTable = page.locator("#lotlar table");
    await expect(lotsTable.getByRole("row", { name: new RegExp(`${lot1}.*Muayene 1`) })).toContainText("3");
    await expect(lotsTable.getByRole("row", { name: new RegExp(`${lot1}.*Ana Depo`) })).toContainText("2");
    await noOverflow(page, "lotlu ürün detayı");

    // Randevu + kullanım: taslakta FEFO önerisi Lot1; stok düşmez
    await createPatient(page, patient);
    const apptUrl = await bookAndStart(page, patient);
    const itemRe = new RegExp(`^${itemName}`);
    await draftUsage(page, apptUrl, itemRe);
    const usageUrl = page.url();
    await expect(page.getByTestId("usage-lots-suggested")).toContainText(lot1);
    await expect(page.getByTestId("usage-lots-suggested")).not.toContainText(lot2);
    await noOverflow(page, "lotlu kullanım taslağı");
    await page.getByRole("button", { name: "Kesinleştir" }).click();
    await expect(page.getByText("Kesinleşti", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("usage-lots")).toContainText(lot1);

    // Hasta dosyası "Malzemeler": lot numarası görünür
    await page.goto(apptUrl);
    await page
      .getByRole("link", { name: new RegExp(`${patient} ${E2E_SURNAME}`) })
      .first()
      .click();
    await page.getByRole("link", { name: "Malzemeler", exact: true }).click();
    await expect(page).toHaveURL(/tab=materials/);
    await expect(page.getByTestId("material-lots").first()).toContainText(lot1);
    await noOverflow(page, "hasta malzemeleri (lot)");

    // SKT sayfası: Lot1 yaklaşan listede
    await page.goto("/inventory/expiry");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("SKT takibi");
    await expect(page.getByRole("link", { name: lot1 }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: lot2 })).toHaveCount(0);
    await noOverflow(page, "SKT takibi");
    await page.getByRole("link", { name: "Süresi geçmiş" }).click();
    await expect(page).toHaveURL(/tab=expired/);
    await noOverflow(page, "SKT geçmiş sekmesi");

    // Geri çağırma: Lot1 → yeni kullanımda önerilmez
    await page.goto("/inventory/expiry");
    await page.getByRole("link", { name: lot1 }).first().click();
    await expect(page).toHaveURL(/\/inventory\/lots\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Lot ${lot1}`);
    await noOverflow(page, "lot detayı");
    await page.locator("summary", { hasText: "Geri çağır" }).click();
    await page.locator("#rc-reason").fill("Üretici geri çağırma bildirimi");
    await submit(page, "Lotu geri çağır").click();
    // Başarılı geri çağırmada sayfa yeniden çizilir: form kalkar, kalıcı uyarı görünür.
    await expect(
      page.getByRole("alert").filter({ hasText: /geri çağrıldı\. Yeni hasta kullanımı/ }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Geri çağrıldı", { exact: true }).first()).toBeVisible();
    await expect(page.locator("summary", { hasText: "Geri çağır" })).toHaveCount(0);
    // Hasta izleme (yalnızca kimlik + dosya no)
    await page.getByRole("link", { name: "Bu lotun kullanıldığı hastaları göster" }).click();
    await expect(page.locator("#izleme table")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#izleme table")).not.toContainText(patient);
    await noOverflow(page, "lot izleme");

    await draftUsage(page, apptUrl, itemRe);
    await expect(page.getByTestId("usage-lots-suggested")).toContainText(lot2);
    await expect(page.getByTestId("usage-lots-suggested")).not.toContainText(lot1);

    // önceki kullanım değişmedi
    await page.goto(usageUrl);
    await expect(page.getByTestId("usage-lots")).toContainText(lot1);
    await expect(page.getByText("Kesinleşti", { exact: true })).toBeVisible();

    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });
}

test("lot / SKT ekranları oturumsuz /login'e yönlendirir", async ({ page }) => {
  for (const path of ["/inventory/expiry", "/inventory/lots/00000000-0000-4000-8000-000000000000"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});
