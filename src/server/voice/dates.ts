import { addDays, dateInZone, isoDayOfWeek, isValidDate } from "@/lib/time";

/**
 * Sesli asistan tarih / saat çözümü — SAF (DB yok). Model tarih / saat dilimi HESAPLAMAZ: doğal ifade ("yarın",
 * "cuma", "gelecek pazartesi", "16 Ekim", "2026-10-16") sunucuda klinik / şube saat dilimine göre MUTLAK tarihe
 * çevrilir. Belirsiz gün adı ("cuma") → bugünden itibaren EN YAKIN (bugün dahil) o gün. "gelecek/haftaya cuma" → bir
 * sonraki takvim haftasındaki cuma.
 */
const DAYS_TR = ["pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi", "pazar"];
const DAYS_EN = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAYS_ASCII = ["pazartesi", "sali", "carsamba", "persembe", "cuma", "cumartesi", "pazar"];
const MONTHS_TR = [
  "ocak",
  "şubat",
  "mart",
  "nisan",
  "mayıs",
  "haziran",
  "temmuz",
  "ağustos",
  "eylül",
  "ekim",
  "kasım",
  "aralık",
];
const MONTHS_ASCII = [
  "ocak",
  "subat",
  "mart",
  "nisan",
  "mayis",
  "haziran",
  "temmuz",
  "agustos",
  "eylul",
  "ekim",
  "kasim",
  "aralik",
];
const MONTHS_EN = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const DAY_LABEL_TR = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const DAY_LABEL_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTH_LABEL_TR = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];
const MONTH_LABEL_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export type VoiceLanguage = "tr" | "en";
export type PartOfDay = { from: string; to: string; label: string };

const norm = (s: string) => s.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim();
const pad = (n: number) => String(n).padStart(2, "0");

/** "16 Ekim 2026 Cuma" / "Friday, 16 October 2026". */
export function formatDateLabel(date: string, lang: VoiceLanguage = "tr"): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = isoDayOfWeek(date) - 1;
  return lang === "en"
    ? `${DAY_LABEL_EN[dow]}, ${d} ${MONTH_LABEL_EN[m - 1]} ${y}`
    : `${d} ${MONTH_LABEL_TR[m - 1]} ${y} ${DAY_LABEL_TR[dow]}`;
}

function weekdayIndex(text: string): number | null {
  for (const list of [DAYS_TR, DAYS_ASCII, DAYS_EN]) {
    // En uzun ad önce (cumartesi ⊃ cuma).
    const order = list.map((n, i) => [n, i] as const).sort((a, b) => b[0].length - a[0].length);
    for (const [name, i] of order) if (new RegExp(`(^|[^a-zçğıöşü])${name}`).test(text)) return i;
  }
  return null;
}

function monthIndex(word: string): number | null {
  for (const list of [MONTHS_TR, MONTHS_ASCII, MONTHS_EN]) {
    const i = list.findIndex((m) => word.startsWith(m.slice(0, 3)) && m.startsWith(word.slice(0, 3)));
    if (i >= 0) return i;
  }
  return null;
}

export type ResolvedDate = { date: string; label: string };

/** Doğal tarih ifadesi → mutlak tarih (verilen saat diliminde "bugün"e göre). Çözülemezse null. */
export function resolveDateExpression(
  expression: string,
  timezone: string,
  now = new Date(),
  lang: VoiceLanguage = "tr",
): ResolvedDate | null {
  const text = norm(expression);
  const today = dateInZone(now, timezone);
  const ok = (date: string): ResolvedDate | null =>
    isValidDate(date) ? { date, label: formatDateLabel(date, lang) } : null;
  if (!text) return null;
  // ISO
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const r = ok(`${iso[1]}-${iso[2]}-${iso[3]}`);
    if (r) return r;
  }
  // 16.10.2026 / 16/10/2026 / 16.10
  const dmy = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?\b/.exec(text);
  if (dmy) {
    const year = dmy[3] ? Number(dmy[3]) : Number(today.slice(0, 4));
    let date = `${year}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`;
    if (!dmy[3] && date < today) date = `${year + 1}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`;
    // "14.30" gibi saat ifadesi geçersiz tarih üretir → diğer kurallara düşülür.
    const r = ok(date);
    if (r) return r;
  }
  // 16 Ekim (2026)
  const dm = /\b(\d{1,2})\s+([a-zçğıöşü]+)(?:\s+(\d{4}))?/.exec(text);
  if (dm) {
    const mi = monthIndex(dm[2]!);
    if (mi !== null) {
      const year = dm[3] ? Number(dm[3]) : Number(today.slice(0, 4));
      let date = `${year}-${pad(mi + 1)}-${pad(Number(dm[1]))}`;
      if (!dm[3] && date < today) date = `${year + 1}-${pad(mi + 1)}-${pad(Number(dm[1]))}`;
      const r = ok(date);
      if (r) return r;
    }
  }
  if (/\b(bugün|bugun|today)\b/.test(text)) return ok(today);
  if (/(yarından sonra|yarindan sonra|öbür gün|obur gun|day after tomorrow)/.test(text))
    return ok(addDays(today, 2));
  if (/\b(yarın|yarin|tomorrow)\b/.test(text)) return ok(addDays(today, 1));
  const wd = weekdayIndex(text);
  if (wd !== null) {
    const cur = isoDayOfWeek(today) - 1;
    const nextWeek = /(gelecek|haftaya|önümüzdeki|onumuzdeki|next)/.test(text);
    if (nextWeek) {
      // Bir sonraki takvim haftası (Pazartesi başlangıçlı).
      const nextMonday = addDays(today, 7 - cur);
      return ok(addDays(nextMonday, wd));
    }
    return ok(addDays(today, (wd - cur + 7) % 7));
  }
  return null;
}

/** "14:30", "14.30", "saat 14", "2:30 pm" → "HH:MM". */
export function resolveTime(expression: string): string | null {
  const text = norm(expression);
  const m = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|öö|ös)?\b/.exec(text.replace(/^saat\s+/, ""));
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3] === "pm" || m[3] === "ös") h = h < 12 ? h + 12 : h;
  if (m[3] === "am" || m[3] === "öö") h = h === 12 ? 0 : h;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

/** "sabah" / "öğleden sonra" / "akşam" → saat penceresi (yerel). */
export function resolvePartOfDay(expression: string | undefined | null): PartOfDay | null {
  if (!expression) return null;
  const text = norm(expression);
  if (/(öğleden sonra|ogleden sonra|afternoon)/.test(text))
    return { from: "12:00", to: "18:00", label: "öğleden sonra" };
  if (/(öğle|ogle|noon)/.test(text)) return { from: "11:30", to: "14:00", label: "öğle" };
  if (/(sabah|morning)/.test(text)) return { from: "06:00", to: "12:00", label: "sabah" };
  if (/(akşam|aksam|evening)/.test(text)) return { from: "17:00", to: "23:00", label: "akşam" };
  return null;
}
