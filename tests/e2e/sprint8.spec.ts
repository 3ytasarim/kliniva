import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_SURNAME, loginAs, noOverflow, purgeE2EData, watch } from "./support/helpers";

/**
 * Sprint 8 E2E — hasta hesabı + kasa (gerçek tarayıcı, üretim build'i):
 *  - Resepsiyon: hasta oluşturur → Hesap sekmesi → hizmet bedeli (₺1.250) → bakiye ₺1.250 → tahsilat → bakiye ₺0.
 *    İptal düğmesi YOK (billing.void yok); menüde Kasa YOK, Açık bakiyeler VAR.
 *  - Sahip: aynı hastanın tahsilatını gerekçeyle iptal eder → bakiye tekrar ₺1.250; hasta Açık bakiyeler'de;
 *    Kasa'da hareket "İptal" rozetiyle görünür (silinmez).
 *  - 768x1024 ve 1440x900; konsol / CSP hatası ve yatay taşma yok. E2E hastası ve finans kayıtları sonunda imha edilir.
 */
test.describe.configure({ mode: "serial", timeout: 240_000 });
test.afterAll(purgeE2EData);

const BASE = "http://localhost:3107";
const first = `Finans${String(Date.now())
  .slice(-5)
  .replace(/\d/g, (d) => "abcdefghij"[Number(d)]!)}`;
let patientUrl = "";

async function newPage(browser: Browser, who: "owner" | "reception" | "doctor", width = 1440) {
  const ctx = await browser.newContext({
    baseURL: BASE,
    viewport: { width, height: width < 1000 ? 1024 : 900 },
  });
  const page = await ctx.newPage();
  const problems = watch(page);
  await loginAs(page, who);
  return { page, problems, close: () => ctx.close() };
}

const section = (page: Page, summary: string) => page.locator("details", { hasText: summary }).first();
const balance = (page: Page) => page.getByTestId("account-balance");

test("resepsiyon: hizmet bedeli + tahsilat → bakiye; iptal ve kasa yetkisi yok", async ({ browser }) => {
  const { page, problems, close } = await newPage(browser, "reception");
  await page.goto("/patients/new");
  await page.locator("#pw-firstName").fill(first);
  await page.locator("#pw-lastName").fill(E2E_SURNAME);
  await page.locator("#pw-phone").fill(`0537${String(Date.now()).slice(-7)}`);
  await page.getByRole("button", { name: "Devam et" }).click();
  await expect(page.getByRole("region", { name: "Belge metni" })).toBeVisible({ timeout: 15_000 });

  await page.goto(`/patients?q=${first}`);
  await page
    .getByRole("link", { name: new RegExp(`${first}.*${E2E_SURNAME}`) })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(first) })).toBeVisible();
  patientUrl = new URL(page.url()).pathname;

  // Menü: Açık bakiyeler var, Kasa yok
  await expect(page.getByRole("link", { name: "Açık bakiyeler" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Kasa", exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Hesap", exact: true }).click();
  await expect(page).toHaveURL(/tab=account/);
  await expect(balance(page)).toContainText("₺0");

  const charge = section(page, "Hizmet bedeli ekle");
  await charge.locator("summary").click();
  await charge.getByLabel("Açıklama").fill("E2E kontrol muayenesi");
  await charge.getByLabel("Birim fiyat").fill("1.250");
  await charge.getByRole("button", { name: "Bedeli ekle" }).click();
  await expect(charge.getByRole("status")).toHaveText("Hizmet bedeli eklendi.");
  await expect(balance(page)).toContainText("₺1.250");
  await expect(page.getByRole("cell", { name: /E2E kontrol muayenesi/ })).toBeVisible();

  const pay = section(page, "Tahsilat al");
  await pay.locator("summary").click();
  await pay.getByLabel("Tutar").fill("1.250");
  await pay.getByLabel("Ödeme yöntemi").selectOption("CARD");
  await pay.getByRole("button", { name: "Tahsilatı kaydet" }).click();
  await expect(pay.getByRole("status")).toHaveText("Tahsilat kaydedildi.");
  await expect(balance(page)).toContainText("₺0");
  await expect(page.getByRole("cell", { name: /Kredi kartı/ })).toBeVisible();
  // Resepsiyonda iptal yok
  await expect(page.getByText("İptal et")).toHaveCount(0);

  await noOverflow(page, "hasta hesabı 1440");
  await page.setViewportSize({ width: 768, height: 1024 });
  await noOverflow(page, "hasta hesabı 768");
  expect(problems).toEqual([]);
  await close();
});

test("sahip: tahsilatı gerekçeyle iptal eder → bakiye geri gelir; açık bakiyeler ve kasa", async ({
  browser,
}) => {
  const { page, problems, close } = await newPage(browser, "owner");
  await page.goto(`${patientUrl}?tab=account`);
  const payments = page.locator("table").nth(1);
  await payments.getByText("İptal et").click();
  await payments.getByLabel("İptal gerekçesi").fill("E2E iade");
  await payments.getByRole("button", { name: "İptali onayla" }).click();
  await expect(page.getByText("İptal: E2E iade")).toBeVisible();
  await page.reload();
  await expect(balance(page)).toContainText("₺1.250");
  await expect(page.getByText("İptal: E2E iade")).toBeVisible();

  await page.goto("/finance/balances");
  await expect(page.getByTestId("balance-row").filter({ hasText: first })).toContainText("₺1.250");

  await page.goto("/finance/cash");
  const row = page.getByTestId("cash-row").filter({ hasText: first }).first();
  await expect(row).toContainText("İptal");
  await expect(row).toContainText("₺1.250");
  await noOverflow(page, "kasa 1440");
  await page.setViewportSize({ width: 768, height: 1024 });
  await noOverflow(page, "kasa 768");

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Bu ay tahsilat" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Son 6 ayın gelir ve gideri" })).toBeVisible();
  expect(problems).toEqual([]);
  await close();
});

test("hasta kartı: sağlık profili (alerji uyarısı), kaynak / SMS düzenleme, liste segmentleri", async ({
  browser,
}) => {
  const { page, problems, close } = await newPage(browser, "owner");
  await page.goto(patientUrl);
  const health = page.locator("details", { hasText: "Sağlık bilgilerini düzenle" });
  await health.locator("summary").click();
  await health.getByLabel("Kan grubu").selectOption("A Rh+");
  await health.getByLabel("Alerjiler").fill("E2E lateks");
  await health.getByRole("button", { name: "Kaydet" }).click();
  await expect(health.getByRole("status")).toHaveText("Sağlık bilgileri kaydedildi.");
  await expect(page.getByTestId("allergy-alert").first()).toContainText("E2E lateks");

  await page.goto(`${patientUrl}/edit`);
  await page.getByLabel("Hasta kaynağı").selectOption({ label: "Instagram" });
  await page.getByLabel("Bilgilendirme SMS’i gönderilebilir (hasta beyanı)").check();
  await page.getByRole("button", { name: "Kaydet" }).click();
  await expect(page.getByRole("status")).toHaveText("Hasta bilgileri güncellendi.");
  await page.goto(patientUrl);
  await expect(page.getByText("Gönderilebilir")).toBeVisible();

  await page.goto(`/patients?segment=no_visit&q=${first}`);
  await expect(page.getByRole("link", { name: "Hiç ziyareti yok" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: new RegExp(`${first} ${E2E_SURNAME}`) })).toBeVisible();
  await expect(page.getByTestId("patient-summary")).toHaveCount(4);
  await page.goto(`/patients?segment=upcoming&q=${first}`);
  await expect(page.getByText("Aramayla eşleşen hasta yok")).toBeVisible();
  await noOverflow(page, "hasta listesi 1440");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`/patients?segment=no_visit`);
  await noOverflow(page, "hasta listesi 768");
  await page.goto(patientUrl);
  await noOverflow(page, "hasta dosyası 768");
  expect(problems).toEqual([]);
  await close();
});

function istanbulDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 24 * 3600_000));
}

test("muayene kaydı: öykü / tavsiye alanları ve şifreli dosya ekleme (doktor)", async ({ browser }) => {
  const owner = await newPage(browser, "owner");
  const p = owner.page;
  await p.goto("/appointments/new");
  await p.getByLabel("Hasta ara").fill(first);
  await p.getByRole("button", { name: "Ara" }).click();
  await p.getByRole("button", { name: new RegExp(`${first} ${E2E_SURNAME}`) }).click();
  const branch = p.getByLabel("Şube", { exact: true });
  if ((await branch.inputValue()) === "") await branch.selectOption({ index: 1 });
  await p.getByLabel("Hizmet", { exact: true }).selectOption({ label: "Muayene · 30 dk" });
  const doctor = p.getByLabel("Doktor", { exact: true });
  await expect(doctor.locator("option", { hasText: "Demo Doktor" })).toHaveCount(1);
  await doctor.selectOption({ label: "Dr. Demo Doktor" });
  await p.getByLabel("Tarih", { exact: true }).fill(istanbulDate(1));
  const slots = p.getByRole("radiogroup", { name: "Uygun saatler" }).getByRole("radio");
  await expect(slots.first()).toBeVisible({ timeout: 20_000 });
  await slots.first().click();
  await p.getByRole("button", { name: "Randevuyu oluştur" }).click();
  await expect(p).toHaveURL(/\/appointments\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const url = new URL(p.url()).pathname;
  await p.getByRole("button", { name: "Hasta geldi (check-in)", exact: true }).click();
  await expect(p.getByText("Geldi", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(owner.problems).toEqual([]);
  await owner.close();

  const doc = await newPage(browser, "doctor");
  const d = doc.page;
  await d.goto(url);
  await d.locator("#cn-complaint").fill("E2E sentetik şikâyet");
  await d.locator("#cn-history").fill("E2E öykü");
  await d.locator("#cn-advice").fill("E2E tavsiye");
  await d.getByRole("button", { name: "Muayene kaydını kaydet" }).click();
  // Sunucu yanıtı (başarı ya da hata) gelene kadar bekle; hata olursa metni test çıktısında görünür.
  const noteForm = d.locator("form", { has: d.locator("#cn-complaint") });
  await expect(noteForm.getByRole("status").or(noteForm.getByRole("alert"))).toBeVisible({ timeout: 15_000 });
  await expect(noteForm.getByRole("status").or(noteForm.getByRole("alert"))).toHaveText(
    "Muayene kaydı kaydedildi (sürüm 1).",
  );

  const files = d.getByTestId("clinical-attachments");
  await files.locator("#ca-file").setInputFiles({
    name: "e2e-sonuc.png",
    mimeType: "image/png",
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("e2e"),
    ]),
  });
  await files.getByRole("button", { name: "Dosyayı ekle" }).click();
  await expect(files.getByRole("status").or(files.getByRole("alert"))).toBeVisible({ timeout: 15_000 });
  await expect(files.getByRole("status").or(files.getByRole("alert"))).toHaveText("Dosya eklendi.");
  const link = files.getByRole("link", { name: "e2e-sonuc.png" });
  await expect(link).toBeVisible();
  const res = await d.request.get((await link.getAttribute("href"))!);
  expect([res.status(), res.headers()["content-type"], res.headers()["cache-control"]]).toEqual([
    200,
    "image/png",
    expect.stringContaining("no-store"),
  ]);
  // Sahte içerik (uzantısı pdf ama PDF değil) reddedilir
  await files.locator("#ca-file").setInputFiles({
    name: "sahte.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("<html>not a pdf</html>"),
  });
  await files.getByRole("button", { name: "Dosyayı ekle" }).click();
  await expect(files.getByRole("alert")).toContainText("Yalnızca PDF, PNG, JPEG veya WEBP");
  await noOverflow(d, "muayene kaydı 1440");
  await d.setViewportSize({ width: 768, height: 1024 });
  await noOverflow(d, "muayene kaydı 768");
  expect(doc.problems).toEqual([]);
  await doc.close();
});

test("görevler: resepsiyon hastaya görev açıp doktora atar; doktor kendi listesinde görür ve sonuçlandırır", async ({
  browser,
}) => {
  const rec = await newPage(browser, "reception");
  const r = rec.page;
  await r.goto(`${patientUrl}?tab=tasks`);
  await r.getByLabel("Başlık").fill("E2E kontrol araması");
  const assignee = r.getByLabel("Atanan");
  const docValue = await assignee.locator("option", { hasText: "Doktor" }).first().getAttribute("value");
  await assignee.selectOption(docValue!);
  await r.getByRole("button", { name: "Görevi oluştur" }).click();
  await expect(r.getByRole("status")).toHaveText("Görev oluşturuldu.");
  await expect(r.getByTestId("task-row").filter({ hasText: "E2E kontrol araması" })).toBeVisible();
  await noOverflow(r, "hasta görevleri 1440");
  expect(rec.problems).toEqual([]);
  await rec.close();

  const doc = await newPage(browser, "doctor");
  const d = doc.page;
  await d.goto("/tasks");
  const row = d.getByTestId("task-row").filter({ hasText: "E2E kontrol araması" });
  await expect(row).toBeVisible();
  await expect(row).toContainText(first);
  await row.locator("summary", { hasText: "Sonuçlandır" }).click();
  await row.getByLabel("Sonuç").selectOption("UNREACHABLE");
  await row.getByLabel("Not (isteğe bağlı)").fill("E2E telefon kapalı");
  await row.getByRole("button", { name: "Kaydet" }).click();
  // Kapanan görev açık listeden kalkar (sunucu yeniden çizer)
  await expect(row).toHaveCount(0);
  await d.goto("/tasks?view=done");
  await expect(d.getByTestId("task-row").filter({ hasText: "E2E kontrol araması" })).toContainText(
    "Ulaşılamadı",
  );
  await d.goto("/dashboard");
  await expect(d.getByRole("heading", { name: "Bana atanmış işler" })).toBeVisible();
  await d.setViewportSize({ width: 768, height: 1024 });
  await d.goto("/tasks?view=done");
  await noOverflow(d, "görevler 768");
  expect(doc.problems).toEqual([]);
  await doc.close();
});

test("tahliller: sonuç girişi, referans dışı işaret ve değişim tablosu", async ({ browser }) => {
  const { page, problems, close } = await newPage(browser, "owner");
  await page.goto(`${patientUrl}?tab=labs`);
  await page.getByLabel("Tahlil tipi", { exact: true }).selectOption({ label: "Hemogram" });
  await page.getByRole("button", { name: "Seç", exact: true }).click();
  await expect(page).toHaveURL(/panel=/);
  await page.getByLabel("Hemoglobin (g/dL)").fill("17,2");
  await page.getByLabel("Trombosit (10³/µL)").fill("250");
  await page.getByRole("button", { name: "Sonucu kaydet" }).click();
  await expect(page.getByRole("status")).toHaveText("Tahlil sonucu kaydedildi.");
  const result = page.getByTestId("lab-result").first();
  await expect(result).toContainText("1 referans dışı");
  await expect(result).toContainText("17,2");
  await expect(page.getByTestId("lab-trend")).toContainText("Hemoglobin");
  await noOverflow(page, "tahliller 1440");
  await page.setViewportSize({ width: 768, height: 1024 });
  await noOverflow(page, "tahliller 768");
  await page.goto("/settings/lab-panels");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tahlil tipleri");
  await noOverflow(page, "tahlil tipleri 768");
  expect(problems).toEqual([]);
  await close();
});
