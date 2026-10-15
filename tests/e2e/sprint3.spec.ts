import { expect, test, type Page } from "@playwright/test";
import { E2E_SURNAME, EMAIL, PASSWORD, login, noOverflow, purgeE2EData, watch } from "./support/helpers";

/**
 * Sprint 3 E2E — randevu yaşam döngüsü (gerçek tarayıcı, üretim build'i):
 * giriş → hasta → Randevular → Yeni randevu → hasta ara/seç → şube → hizmet → doktor → tarih → sunucudan gelen
 * uygun saatler → saat seç → özet → oluştur → detay → Onayla → Check-in → Başlat → Tamamla → takvimde görünür →
 * hasta dosyası → Randevular → tamamlanan kayıt. 768x1024 ve 1440x900; konsol hatası / CSP ihlali / yatay taşma yok.
 * Seed demo kiracısı kullanılır (demo doktor her gün 08:00–20:00); oluşturulan veriler test sonunda temizlenir.
 */
test.describe.configure({ mode: "serial", timeout: 150_000 });
test.afterAll(purgeE2EData);

/** Klinik saat dilimine (Europe/Istanbul) göre yarın — her zaman uygun saat bulunur. */
function tomorrowIstanbul(): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 24 * 3600_000));
  return p;
}

async function createPatientQuick(page: Page, first: string, phone: string) {
  await page.goto("/patients/new");
  await page.locator("#pw-firstName").fill(first);
  await page.locator("#pw-lastName").fill(E2E_SURNAME);
  await page.locator("#pw-phone").fill(phone);
  await page.getByRole("button", { name: "Devam et" }).click();
  // Hasta 1. adımda oluşturulur; KVKK adımı görününce kayıt tamamdır.
  await expect(page.getByRole("region", { name: "Belge metni" })).toBeVisible({ timeout: 15_000 });
}

for (const viewport of [
  { width: 768, height: 1024, name: "tablet", first: "Randevu Tablet" },
  { width: 1440, height: 900, name: "masaüstü", first: "Randevu Masaustu" },
]) {
  test(`randevu yaşam döngüsü (${viewport.name} ${viewport.width}x${viewport.height})`, async ({ page }) => {
    test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const problems = watch(page);
    await login(page);
    const firstName = viewport.first.split(" ")[0]!;
    const fullFirst = viewport.first;
    await createPatientQuick(page, fullFirst, `0538${String(Date.now()).slice(-7)}`);

    // Randevular → Yeni randevu
    await page.goto("/appointments");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Randevular");
    await noOverflow(page, "randevu takvimi");
    await page.getByRole("link", { name: "+ Yeni randevu" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Yeni randevu");
    await noOverflow(page, "yeni randevu");

    // 1 Hasta ara / seç
    await page.getByLabel("Hasta ara").fill(fullFirst);
    await page.getByRole("button", { name: "Ara" }).click();
    await page.getByRole("button", { name: new RegExp(`${fullFirst} ${E2E_SURNAME}`) }).click();
    await expect(page.getByRole("button", { name: "Değiştir" })).toBeVisible();

    // 2 Şube + hizmet, 3 doktor + tarih
    const branch = page.getByLabel("Şube", { exact: true });
    if ((await branch.inputValue()) === "") await branch.selectOption({ index: 1 });
    await page.getByLabel("Hizmet", { exact: true }).selectOption({ label: "Muayene · 30 dk" });
    const doctor = page.getByLabel("Doktor", { exact: true });
    await expect(doctor.locator("option", { hasText: "Demo Doktor" })).toHaveCount(1);
    await doctor.selectOption({ label: "Dr. Demo Doktor" });
    await page.getByLabel("Tarih", { exact: true }).fill(tomorrowIstanbul());

    // 4 Uygun saat (sunucudan) → ilk saat; oda otomatik önerilir
    const slots = page.getByRole("radiogroup", { name: "Uygun saatler" }).getByRole("radio");
    await expect(slots.first()).toBeVisible({ timeout: 20_000 });
    const time = (await slots.first().textContent())!.trim();
    await slots.first().click();
    await expect(page.getByLabel("Oda", { exact: true })).toHaveValue(/.+/);
    await noOverflow(page, "slot seçimi");

    // Özet → oluştur
    const review = page.getByRole("complementary");
    await expect(review).toContainText(`${fullFirst} ${E2E_SURNAME}`);
    await expect(review).toContainText("Muayene (30 dk)");
    await page.getByRole("button", { name: "Randevuyu oluştur" }).click();
    await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const detailUrl = page.url();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(time);
    await expect(page.getByText("Planlandı").first()).toBeVisible();
    await noOverflow(page, "randevu detayı");

    // Yaşam döngüsü: Onayla → Check-in → Başlat → Tamamla
    for (const [button, status] of [
      ["Onayla", "Onaylandı"],
      ["Hasta geldi (check-in)", "Geldi"],
      ["Başlat", "İşlemde"],
      ["Tamamla", "Tamamlandı"],
    ] as const) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await expect(page.getByText(status, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    }
    await expect(page.getByRole("button", { name: "Tamamla", exact: true })).toHaveCount(0);
    await expect(page.getByText("Muayene / işlem başladı")).toBeVisible();

    // Takvimde (gün görünümü) görünür
    await page.goto(`/appointments?view=day&date=${tomorrowIstanbul()}`);
    const card = page.getByRole("grid", { name: "Günlük randevu takvimi" }).getByRole("link", {
      name: new RegExp(`${fullFirst} ${E2E_SURNAME}`),
    });
    await expect(card).toBeVisible();
    await noOverflow(page, "gün görünümü");
    await page.goto(`/appointments?view=week&date=${tomorrowIstanbul()}`);
    await expect(page.getByRole("grid", { name: "Haftalık randevu takvimi" })).toBeVisible();
    await noOverflow(page, "hafta görünümü");

    // Hasta dosyası → Randevular → tamamlanan kayıt
    await page.goto(detailUrl);
    await page
      .getByRole("link", { name: new RegExp(`${firstName}.*${E2E_SURNAME}`) })
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${fullFirst} ${E2E_SURNAME}`);
    await page.getByRole("link", { name: "Randevular", exact: true }).last().click();
    await expect(page).toHaveURL(/tab=appointments/);
    const past = page.getByRole("table").last();
    await expect(past.getByText("Tamamlandı")).toBeVisible();
    await expect(past.getByText("Muayene")).toBeVisible();
    await noOverflow(page, "hasta randevuları");

    // Panel kartları
    await page.goto("/dashboard");
    await expect(page.getByText("Bugünkü randevular")).toBeVisible();
    await noOverflow(page, "panel");

    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });
}

test("randevu ekranları oturumsuz /login'e yönlendirir", async ({ page }) => {
  for (const path of ["/appointments", "/appointments/new", "/settings/services"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});
