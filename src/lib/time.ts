/**
 * Saat / tarih / saat dilimi yardımcıları — istemci ve sunucuda güvenle kullanılabilir (sır/DB yok).
 *
 * Kurallar:
 *  - Haftalık planlar şubenin YEREL saatiyle ("HH:MM") ve ISO gün numarasıyla (1 = Pazartesi … 7 = Pazar) tutulur.
 *  - Gerçek anlar (ileride randevular) UTC'dir; yerel ↔ UTC dönüşümü IANA saat dilimi kuralıyla yapılır
 *    (Intl API). "+03:00" gibi sabit ofset ASLA kullanılmaz — yaz saati uygulayan bölgelerde de doğru çalışır.
 */
export const DEFAULT_TIMEZONE = "Europe/Istanbul";

export const DAYS = [
  { iso: 1, key: "MONDAY", short: "Pzt", long: "Pazartesi" },
  { iso: 2, key: "TUESDAY", short: "Sal", long: "Salı" },
  { iso: 3, key: "WEDNESDAY", short: "Çar", long: "Çarşamba" },
  { iso: 4, key: "THURSDAY", short: "Per", long: "Perşembe" },
  { iso: 5, key: "FRIDAY", short: "Cum", long: "Cuma" },
  { iso: 6, key: "SATURDAY", short: "Cmt", long: "Cumartesi" },
  { iso: 7, key: "SUNDAY", short: "Paz", long: "Pazar" },
] as const;

export type DayKey = (typeof DAYS)[number]["key"];
export const dayName = (iso: number) => DAYS[iso - 1]?.long ?? "?";
export const dayIsoFromKey = (key: DayKey) => DAYS.find((d) => d.key === key)!.iso;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/;

/** "09:30" veya "09:30:00" → 570 (gece yarısından itibaren dakika). Geçersizse null. */
export function parseTime(value: string): number | null {
  const m = HHMM.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 570 → "09:30" (1440 → "24:00" yalnızca gösterim için). */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Postgres `time` değerini ("09:30:00") "09:30" biçimine getirir. */
export const toHHMM = (pgTime: string) => pgTime.slice(0, 5);

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Takvim tarihinin ISO gün numarası (saat diliminden bağımsız; tarih zaten yerel takvim günüdür). */
export function isoDayOfWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Pazar
  return d === 0 ? 7 : d;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Verilen anın, saat dilimindeki takvim tarihi ("YYYY-MM-DD"). */
export function dateInZone(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Anın saat dilimindeki UTC ofseti (dakika; ör. İstanbul +180, Berlin kışın +60 yazın +120). */
export function zoneOffsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/**
 * Yerel takvim tarihi + gün içi dakika (saat diliminde) → UTC an.
 * Ofset hedef anın kendisine göre hesaplanır (iki geçiş) → yaz saati geçiş günlerinde de doğru.
 */
export function zonedDateTimeToUtc(date: string, minutes: number, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = naive - zoneOffsetMinutes(new Date(naive), tz) * 60000;
  guess = naive - zoneOffsetMinutes(new Date(guess), tz) * 60000;
  return new Date(guess);
}

/** Anın saat dilimindeki yerel takvim tarihi + gece yarısından itibaren dakika (duvar saati). */
export function localDateTimeOf(instant: Date, tz: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Yerel saatin yaz saati geçişindeki durumu:
 *  - NONEXISTENT: ileri alınan saatte hiç yaşanmayan yerel saat (ör. Berlin 31 Mart 02:30).
 *  - AMBIGUOUS: geri alınan saatte iki kez yaşanan yerel saat (ör. Berlin 27 Ekim 02:30).
 * Randevu motoru bu saatlerde slot ÜRETMEZ (güvenli varsayılan).
 */
export function localTimeStatus(
  date: string,
  minutes: number,
  tz: string,
): "OK" | "NONEXISTENT" | "AMBIGUOUS" {
  const utc = zonedDateTimeToUtc(date, minutes, tz);
  const back = localDateTimeOf(utc, tz);
  if (back.date !== date || back.minutes !== minutes) return "NONEXISTENT";
  const before = zoneOffsetMinutes(new Date(utc.getTime() - 36 * 3600_000), tz);
  const after = zoneOffsetMinutes(new Date(utc.getTime() + 36 * 3600_000), tz);
  if (before !== after) {
    const shift = Math.abs(after - before) * 60_000;
    for (const alt of [utc.getTime() - shift, utc.getTime() + shift]) {
      const l = localDateTimeOf(new Date(alt), tz);
      if (l.date === date && l.minutes === minutes) return "AMBIGUOUS";
    }
  }
  return "OK";
}
