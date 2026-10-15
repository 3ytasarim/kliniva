import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  clearUnreadNotifications,
  E2E_SURNAME,
  EMAIL,
  PASSWORD,
  loginAs,
  noOverflow,
  purgeE2EData,
  watch,
} from "./support/helpers";

/**
 * Sprint 7 E2E — Kliniva AI sesli asistan (SAHTE taşıyıcı: VOICE_TRANSPORT=mock; OpenAI'ye ağ çağrısı yok, mikrofon
 * istenmez). Panel aynı sunucu araçlarını / onay akışını kullanır; komut metinle verilir.
 *  - Doktor: "Bugünkü randevularımı söyle" → araç kartı + yanıt
 *  - Resepsiyon: müsaitlik → randevu özeti (ölçülü gizlilik) → "Evet" ×2 → TEK randevu; takvimde görünür;
 *    doktora bildirim (SSE)
 *  - Çakışma: aynı saat başka hasta → "Bu saat artık müsait değil" + alternatif saatler
 *  - Konsol / CSP hatası yok, yatay taşma yok.
 */
test.describe.configure({ mode: "serial", timeout: 240_000 });
test.afterAll(purgeE2EData);

const BASE = "http://localhost:3107";

function istanbulDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 24 * 3600_000));
}
/** Yalnızca harf: sahte model hasta adını harflerden ayrıştırır. */
const letters = () =>
  String(Date.now())
    .slice(-6)
    .replace(/\d/g, (d) => "abcdefghij"[Number(d)]!);

async function newPage(browser: Browser, who: "owner" | "reception" | "doctor", landing: string) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const problems = watch(page);
  await loginAs(page, who, landing);
  return { page, problems, close: () => ctx.close() };
}

const panel = (page: Page) => page.getByRole("region", { name: "Kliniva AI sesli asistan" });
const transcript = (page: Page) => page.getByTestId("voice-transcript");

async function openVoice(page: Page) {
  await page.getByRole("button", { name: "Kliniva AI sesli asistanı aç" }).click();
  await panel(page).getByRole("button", { name: "Başlat" }).click();
  await expect(page.getByTestId("voice-status")).toContainText("Dinliyor", { timeout: 15_000 });
  await expect(transcript(page)).toContainText("Test modu");
}

async function ask(page: Page, text: string): Promise<string> {
  const before = await transcript(page).getByTestId("voice-line").count();
  await page.locator("#voice-text").fill(text);
  await panel(page).getByRole("button", { name: "Gönder" }).click();
  // Kullanıcı satırı + asistan yanıtı
  await expect(transcript(page).getByTestId("voice-line")).toHaveCount(before + 2, { timeout: 20_000 });
  return (await transcript(page).getByTestId("voice-line").last().innerText()).trim();
}

async function closeVoice(page: Page) {
  await panel(page).getByRole("button", { name: "Mikrofonu kapat" }).click();
  await expect(page.getByTestId("voice-status")).toContainText("Kapalı", { timeout: 10_000 });
}

async function createPatient(page: Page, first: string, phone: string) {
  await page.goto("/patients/new");
  await page.locator("#pw-firstName").fill(first);
  await page.locator("#pw-lastName").fill(E2E_SURNAME);
  await page.locator("#pw-phone").fill(phone);
  await page.getByRole("button", { name: "Devam et" }).click();
  await expect(page.getByRole("region", { name: "Belge metni" })).toBeVisible({ timeout: 15_000 });
}

test("doktor: 'Bugünkü randevularımı söyle' → araç kartı ve sistemden gelen yanıt", async ({ browser }) => {
  test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
  const doc = await newPage(browser, "doctor", "/doctor");
  try {
    await openVoice(doc.page);
    const reply = await ask(doc.page, "Bugünkü randevularımı söyle");
    expect(reply).toMatch(/^Bugün (\d+ randevu var|randevu bulunmuyor)/);
    await expect(doc.page.getByTestId("voice-tool-card").first()).toContainText("Bugünkü randevular");
    await noOverflow(doc.page, "sesli asistan paneli (doktor)");
    await doc.page.setViewportSize({ width: 375, height: 812 });
    await noOverflow(doc.page, "sesli asistan paneli (mobil)");
    await closeVoice(doc.page);
    expect(await transcript(doc.page).innerText()).not.toContain("Bugünkü randevularımı"); // kapatınca döküm silinir
    expect(doc.problems).toEqual([]);
  } finally {
    await doc.close();
  }
});

test("resepsiyon: müsaitlik → özet (ölçülü) → 'Evet' ×2 → TEK randevu; takvim + doktor bildirimi; çakışma", async ({
  browser,
}) => {
  test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
  const rec = await newPage(browser, "reception", "/dashboard");
  const doc = await newPage(browser, "doctor", "/doctor");
  try {
    // Doktor zili temiz başlasın
    const bell = doc.page.getByRole("button", { name: /^Bildirimler/ });
    await clearUnreadNotifications(doc.page);

    const first = `Sesli${letters()}`;
    const other = `Sesci${letters()}`;
    const phone = `0535${String(Date.now()).slice(-7)}`;
    await createPatient(rec.page, first, phone);
    await createPatient(rec.page, other, `0536${String(Date.now()).slice(-7)}`);
    const date = istanbulDate(3);

    await rec.page.goto("/dashboard");
    await openVoice(rec.page);
    const avail = await ask(rec.page, `Dr. Demo Doktor ${date} müsait mi?`);
    const time = /(\d{2}:\d{2})/.exec(avail)?.[1];
    expect(time, avail).toBeTruthy();

    const summary = await ask(
      rec.page,
      `Dr. Demo Doktor ${date} ${time} ${first} için Muayene randevusu oluştur`,
    );
    expect(summary).toMatch(/Onaylıyor musunuz\?$/);
    const card = rec.page.getByTestId("voice-confirm-card");
    await expect(card).toBeVisible();
    // Ölçülü gizlilik: soyadı kısaltılır; telefon / tam soyadı asistan çıktısında yok
    await expect(card).toContainText(`${first} E.`);
    await expect(card).not.toContainText(E2E_SURNAME);
    expect(await transcript(rec.page).innerText()).not.toContain(phone.slice(-7));

    expect(await ask(rec.page, "Evet")).toBe("Randevu oluşturuldu.");
    await expect(card).toHaveCount(0);
    expect(await ask(rec.page, "Evet")).toMatch(/zaten/);

    // Çakışma: aynı saat, başka hasta
    const conflict = await ask(
      rec.page,
      `Dr. Demo Doktor ${date} ${time} ${other} için Muayene randevusu oluştur`,
    );
    expect(conflict).toMatch(/^Bu saat artık müsait değil\. Müsait saatler: \d{2}:\d{2}/);
    await noOverflow(rec.page, "sesli asistan (resepsiyon)");
    await closeVoice(rec.page);

    // Takvimde TEK randevu
    await rec.page.goto(`/appointments?date=${date}`);
    await expect(rec.page.getByText(new RegExp(first)).first()).toBeVisible();
    // Takvim ızgarası + liste tablosu aynı randevuyu iki kez gösterir → tablo satırı sayılır
    await expect(rec.page.locator("tbody tr", { hasText: first })).toHaveCount(1);
    await expect(rec.page.getByText(new RegExp(other))).toHaveCount(0);

    // Doktor: normal outbox akışıyla bildirim (yenilemeden)
    await expect(bell).toHaveAccessibleName("Bildirimler (1 okunmamış)", { timeout: 30_000 });

    await rec.page.waitForLoadState("networkidle");
    expect(rec.problems).toEqual([]);
    expect(doc.problems).toEqual([]);
  } finally {
    await rec.close();
    await doc.close();
  }
});
