import { execSync } from "node:child_process";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  E2E_SURNAME,
  clearUnreadNotifications,
  EMAIL,
  PASSWORD,
  login,
  loginAs,
  noOverflow,
  purgeE2EData,
  watch,
} from "./support/helpers";

/**
 * Sprint 6 E2E — bildirim merkezi, SSE gerçek zamanlı akış, doktor onayı, stok uyarısı, Bugünkü operasyon.
 * İki (veya üç) ayrı tarayıcı bağlamı: resepsiyon + doktor (+ sahip). Doktor sayfası YENİLENMEDEN bildirim alır
 * (SSE). Konsol hatası / CSP ihlali / yatay taşma yok. Veriler test sonunda temizlenir (E2E-* / E2E hastaları).
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

const submit = (page: Page, label: string) => page.locator("form button[type=submit]", { hasText: label });
const bell = (page: Page) => page.getByRole("button", { name: /^Bildirimler/ });

async function newPage(browser: Browser, who: "owner" | "reception" | "doctor", landing: string) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const problems = watch(page);
  await loginAs(page, who, landing);
  return { page, problems, close: () => ctx.close() };
}

async function createPatient(page: Page, first: string) {
  await page.goto("/patients/new");
  await page.locator("#pw-firstName").fill(first);
  await page.locator("#pw-lastName").fill(E2E_SURNAME);
  await page.locator("#pw-phone").fill(`0534${String(Date.now()).slice(-7)}`);
  await page.getByRole("button", { name: "Devam et" }).click();
  await expect(page.getByRole("region", { name: "Belge metni" })).toBeVisible({ timeout: 15_000 });
}

/** Resepsiyon: yarın için Demo Doktor + Muayene randevusu. Seçilen saat etiketini döner. */
async function book(page: Page, patient: string): Promise<{ url: string; slot: string }> {
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
  const slot = (await slots.first().getAttribute("aria-label")) ?? (await slots.first().innerText());
  await slots.first().click();
  await page.getByRole("button", { name: "Randevuyu oluştur" }).click();
  await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  return { url: page.url(), slot: slot.trim() };
}

/** Okunmamışları temizle — ortak yardımcı (ilk yükleme yarışı giderilmiş). */
const clearUnread = clearUnreadNotifications;

async function setApprovalMode(page: Page, mode: "AUTO_ACCEPT" | "DOCTOR_APPROVAL") {
  await page.goto("/settings/clinic");
  await page.getByLabel("Randevu onay modu").selectOption(mode);
  await submit(page, "Kaydet").click();
  await expect(page.getByText("Klinik profili kaydedildi.")).toBeVisible({ timeout: 15_000 });
}

test("gerçek zamanlı: resepsiyon randevu + check-in → doktor sayfası YENİLENMEDEN bildirim alır (SSE)", async ({
  browser,
}) => {
  test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
  const rec = await newPage(browser, "reception", "/dashboard");
  const doc = await newPage(browser, "doctor", "/doctor");
  try {
    const streams: string[] = [];
    doc.page.on("request", (r) => {
      if (r.url().includes("/api/v1/notifications/stream")) streams.push(new URL(r.url()).search);
    });
    await expect(doc.page.getByRole("heading", { level: 1 })).toContainText("Merhaba");
    await clearUnread(doc.page);
    let navigations = 0;
    doc.page.on("framenavigated", (f) => {
      if (f === doc.page.mainFrame()) navigations++;
    });

    const patient = `Canli ${String(Date.now()).slice(-5)}`;
    await createPatient(rec.page, patient);
    const { url } = await book(rec.page, patient);

    // Doktor: yenilemeden rozet 1
    await expect(bell(doc.page)).toHaveAccessibleName("Bildirimler (1 okunmamış)", { timeout: 30_000 });
    await expect(doc.page.getByTestId("notification-badge")).toHaveText("1");

    // Resepsiyon: check-in → doktor: rozet 2
    await rec.page.goto(url);
    await rec.page.getByRole("button", { name: "Hasta geldi (check-in)", exact: true }).click();
    await expect(rec.page.getByText("Geldi", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(bell(doc.page)).toHaveAccessibleName("Bildirimler (2 okunmamış)", { timeout: 30_000 });

    // İçerik: başlık + yetki kontrollü bağlam (saat — hasta adı) ; SSE kullanıldı, sayfa yenilenmedi
    await bell(doc.page).click();
    const dialog = doc.page.getByRole("dialog", { name: "Son bildirimler" });
    await expect(dialog.getByText("Hasta giriş yaptı")).toBeVisible();
    await expect(dialog.getByText("Yeni randevu")).toBeVisible();
    await expect(dialog.getByText(new RegExp(`— ${patient} ${E2E_SURNAME}`)).first()).toBeVisible();
    expect(navigations).toBe(0);
    expect(streams.length).toBeGreaterThanOrEqual(1);
    expect(streams.every((q) => q === "")).toBe(true); // alıcı parametresi gönderilmez
    // Okundu → rozet azalır
    await dialog.getByRole("button", { name: "Okundu", exact: true }).first().click();
    await expect(bell(doc.page)).toHaveAccessibleName("Bildirimler (1 okunmamış)", { timeout: 10_000 });
    await doc.page.keyboard.press("Escape");

    // Bildirimler sayfası: filtre + Görüntüle bağlantısı
    await doc.page.goto("/notifications?filter=appointments");
    await expect(doc.page.getByRole("heading", { level: 1 })).toHaveText("Bildirimler");
    await expect(doc.page.getByTestId("notification-item").first()).toBeVisible();
    await expect(doc.page.getByRole("link", { name: "Görüntüle" }).first()).toHaveAttribute(
      "href",
      /\/appointments\//,
    );
    await doc.page.setViewportSize({ width: 768, height: 1024 });
    await noOverflow(doc.page, "bildirimler (tablet)");

    await rec.page.waitForLoadState("networkidle");
    expect(rec.problems).toEqual([]);
    expect(doc.problems).toEqual([]);
  } finally {
    await rec.close();
    await doc.close();
  }
});

test("doktor onayı: onay bekleyen randevu → doktor bildirimi → Onayla (BOOKED); Reddet (CANCELLED, slot geri gelir)", async ({
  page,
  browser,
}) => {
  test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
  await page.setViewportSize({ width: 1440, height: 900 });
  const ownerProblems = watch(page);
  await login(page);
  await setApprovalMode(page, "DOCTOR_APPROVAL");
  const rec = await newPage(browser, "reception", "/dashboard");
  const doc = await newPage(browser, "doctor", "/doctor");
  try {
    await clearUnread(doc.page);
    // 1) Onay
    const p1 = `Onay ${String(Date.now()).slice(-5)}`;
    await createPatient(rec.page, p1);
    const b1 = await book(rec.page, p1);
    await expect(rec.page.getByText("Onay bekliyor", { exact: true }).first()).toBeVisible();
    await expect(bell(doc.page)).toHaveAccessibleName("Bildirimler (1 okunmamış)", { timeout: 30_000 });
    await doc.page.reload();
    const row1 = doc.page.getByTestId("pending-approval").filter({ hasText: p1 });
    await expect(row1).toBeVisible();
    await noOverflow(doc.page, "doktor portalı (onay bekleyen)");
    await row1.getByRole("button", { name: "Onayla" }).click();
    await expect(row1).toHaveCount(0, { timeout: 15_000 });
    await rec.page.goto(b1.url);
    await expect(rec.page.getByText("Planlandı", { exact: true }).first()).toBeVisible();
    // Takvimde görünür
    await rec.page.goto(`/appointments?date=${istanbulDate(1)}`);
    await expect(rec.page.getByText(new RegExp(p1)).first()).toBeVisible();

    // 2) Ret → slot yeniden müsait
    const p2 = `Ret ${String(Date.now()).slice(-5)}`;
    await createPatient(rec.page, p2);
    const b2 = await book(rec.page, p2);
    await doc.page.reload();
    const row2 = doc.page.getByTestId("pending-approval").filter({ hasText: p2 });
    await expect(row2).toBeVisible({ timeout: 15_000 });
    doc.page.once("dialog", (d) => void d.accept());
    await row2.getByRole("button", { name: "Reddet" }).click();
    await expect(row2).toHaveCount(0, { timeout: 15_000 });
    await rec.page.goto(b2.url);
    await expect(rec.page.getByText("İptal", { exact: true }).first()).toBeVisible();
    // Aynı slot rezervasyon listesinde yeniden
    await rec.page.goto("/appointments/new");
    await rec.page.getByLabel("Hasta ara").fill(p2);
    await rec.page.getByRole("button", { name: "Ara" }).click();
    await rec.page.getByRole("button", { name: new RegExp(`${p2} ${E2E_SURNAME}`) }).click();
    const branch = rec.page.getByLabel("Şube", { exact: true });
    if ((await branch.inputValue()) === "") await branch.selectOption({ index: 1 });
    await rec.page.getByLabel("Hizmet", { exact: true }).selectOption({ label: "Muayene · 30 dk" });
    await rec.page.getByLabel("Doktor", { exact: true }).selectOption({ label: "Dr. Demo Doktor" });
    await rec.page.getByLabel("Tarih", { exact: true }).fill(istanbulDate(1));
    const radios = rec.page.getByRole("radiogroup", { name: "Uygun saatler" }).getByRole("radio");
    await expect(radios.first()).toBeVisible({ timeout: 20_000 });
    const labels = await radios.evaluateAll((els) =>
      els.map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim()),
    );
    expect(labels).toContain(b2.slot);

    expect(rec.problems).toEqual([]);
    expect(doc.problems).toEqual([]);
  } finally {
    await setApprovalMode(page, "AUTO_ACCEPT");
    await rec.close();
    await doc.close();
  }
  expect(ownerProblems).toEqual([]);
});

test("stok uyarısı: asgari 5, stok 6, kullanım 2 → 4 → sahip zilinde 'Düşük stok' (yenilemeden)", async ({
  page,
}) => {
  test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
  await page.setViewportSize({ width: 1440, height: 900 });
  const problems = watch(page);
  await login(page);
  const stamp = String(Date.now()).slice(-6);
  const itemName = `E2E Uyarı ${stamp}`;
  await page.goto("/inventory/items");
  await page.locator("#ni-name").fill(itemName);
  await page.locator("#ni-code").fill(`E2E-N${stamp}`);
  await page.locator("#ni-minimumStockLevel").fill("5");
  await submit(page, "Ürünü oluştur").click();
  await expect(page).toHaveURL(/\/inventory\/items\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await page.locator("#as-locationId").selectOption({ label: "Merkez Şube · Muayene 1" });
  await page.locator("#as-quantity").fill("6");
  await submit(page, "Stok ekle").click();
  await expect(page.getByText(/Stok eklendi/)).toBeVisible({ timeout: 15_000 });

  // Hasta + randevu (sahip) → işlemde → kullanım 2
  const patient = `Stok ${stamp}`;
  await createPatient(page, patient);
  const { url } = await book(page, patient);
  for (const [button, status] of [
    ["Onayla", "Onaylandı"],
    ["Hasta geldi (check-in)", "Geldi"],
    ["Başlat", "İşlemde"],
  ] as const) {
    await page.goto(url);
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByText(status, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  }
  await submit(page, "Malzeme kullanımı ekle").click();
  await expect(page).toHaveURL(/\/inventory\/usages\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  const opt = (await page.locator("#ua-inventoryItemId option").allTextContents()).find((l) =>
    l.startsWith(itemName),
  )!;
  await page.locator("#ua-inventoryItemId").selectOption({ label: opt });
  await page.locator("#ua-locationId").selectOption({ label: "Muayene 1" });
  await page.locator("#ua-quantity").fill("2");
  await submit(page, "Ekle").click();
  await expect(page.getByText("Malzeme eklendi.")).toBeVisible({ timeout: 15_000 });
  await clearUnread(page);
  await page.getByRole("button", { name: "Kesinleştir" }).click();
  await expect(page.getByText("Kesinleşti", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("notification-badge")).toBeVisible({ timeout: 30_000 });
  await bell(page).click();
  const dialog = page.getByRole("dialog", { name: "Son bildirimler" });
  await expect(dialog.getByText("Düşük stok").first()).toBeVisible();
  await expect(
    dialog.getByText(new RegExp(`${itemName} · Muayene 1: kullanılabilir 4 \\(asgari 5\\)`)),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
});

test("Bugünkü operasyon: check-in → doktor gerçek zamanlı bildirim → Başlat → Tamamla; panolar güncellenir", async ({
  browser,
}) => {
  test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
  const rec = await newPage(browser, "reception", "/dashboard");
  const doc = await newPage(browser, "doctor", "/doctor");
  try {
    const patient = `Ops ${String(Date.now()).slice(-5)}`;
    await createPatient(rec.page, patient);
    execSync(`npx tsx --conditions=react-server tests/e2e/support/seed-today-appointment.ts "${patient}"`, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await clearUnread(doc.page);

    await rec.page.goto("/operations/today");
    await expect(rec.page.getByRole("heading", { level: 1 })).toHaveText("Bugünkü operasyon");
    const expected = rec.page
      .getByTestId("ops-group-expected")
      .getByTestId("ops-row")
      .filter({ hasText: patient });
    await expect(expected).toBeVisible();
    await noOverflow(rec.page, "bugünkü operasyon");
    await expected.getByRole("button", { name: "Giriş yaptı" }).click();
    const arrived = rec.page
      .getByTestId("ops-group-arrived")
      .getByTestId("ops-row")
      .filter({ hasText: patient });
    await expect(arrived).toBeVisible({ timeout: 20_000 });

    // Doktor: yenilemeden bildirim
    await expect(bell(doc.page)).toHaveAccessibleName("Bildirimler (1 okunmamış)", { timeout: 30_000 });
    await doc.page.goto("/operations/today");
    const docRow = () => doc.page.getByTestId("ops-row").filter({ hasText: patient });
    await docRow().getByRole("button", { name: "Başlat" }).click();
    await expect(
      doc.page.getByTestId("ops-group-in-progress").getByTestId("ops-row").filter({ hasText: patient }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await docRow().getByRole("button", { name: "Tamamla" }).click();
    await expect(
      doc.page.getByTestId("ops-group-completed").getByTestId("ops-row").filter({ hasText: patient }),
    ).toBeVisible({
      timeout: 20_000,
    });
    // Resepsiyon panosu (canlı yenileme) güncellenir
    await expect(
      rec.page.getByTestId("ops-group-completed").getByTestId("ops-row").filter({ hasText: patient }),
    ).toBeVisible({
      timeout: 40_000,
    });
    await rec.page.setViewportSize({ width: 768, height: 1024 });
    await noOverflow(rec.page, "bugünkü operasyon (tablet)");
    expect(rec.problems).toEqual([]);
    expect(doc.problems).toEqual([]);
  } finally {
    await rec.close();
    await doc.close();
  }
});

test("sistem olayları sayfası yalnızca sahip / yönetici; bildirim ekranları oturumsuz /login'e yönlendirir", async ({
  page,
  browser,
}) => {
  test.skip(!EMAIL || !PASSWORD, "seed kimlik bilgileri yok");
  await login(page);
  await page.goto("/settings/system-events");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sistem olayları");
  await noOverflow(page, "sistem olayları");
  const rec = await newPage(browser, "reception", "/settings/system-events");
  try {
    await expect(rec.page.getByText(/yetkiniz yok|erişim/i).first()).toBeVisible();
  } finally {
    await rec.close();
  }
  const anon = await browser.newContext({ baseURL: BASE });
  const p = await anon.newPage();
  for (const path of ["/notifications", "/operations/today", "/settings/system-events"]) {
    await p.goto(path);
    await expect(p).toHaveURL(/\/login$/);
  }
  const res = await p.request.get("/api/v1/notifications/stream?userId=00000000-0000-4000-8000-000000000000");
  expect(res.status()).toBe(401);
  await anon.close();
});
