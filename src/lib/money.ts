import { CURRENCIES, type Currency, type MoneyByCurrency } from "@/types/finance";

/** Tutarlar kuruş / cent cinsinden tamsayıdır. Biçimleme ve ayrıştırma yalnızca burada. */
const formatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(minor: number, currency: Currency = "TRY", opts: { decimals?: boolean } = {}) {
  const decimals = opts.decimals ?? minor % 100 !== 0;
  const key = `${currency}:${decimals}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("tr-TR", {
      style: "currency",
      currency,
      minimumFractionDigits: decimals ? 2 : 0,
      maximumFractionDigits: decimals ? 2 : 0,
    });
    formatters.set(key, f);
  }
  return f.format(minor / 100);
}

/** "₺1.250 · €80" — sıfır olmayan para birimleri; hiçbiri yoksa "₺0". */
export function formatMoneyMap(m: MoneyByCurrency): string {
  const parts = CURRENCIES.filter((c) => (m[c] ?? 0) !== 0).map((c) => formatMoney(m[c]!, c));
  return parts.length ? parts.join(" · ") : formatMoney(0, "TRY");
}

/**
 * Kullanıcı girdisini kuruşa çevirir: "1250", "1.250", "1.250,50", "1250.5", "1 250,00".
 * Türkçe biçim önceliklidir (nokta binlik, virgül ondalık). Geçersizse null.
 */
export function parseMoneyInput(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/[\s₺€$£]/g, "");
  if (!s) return null;
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Kuruşu düzenleme kutusu için "1250,50" / "1250" metnine çevirir. */
export function minorToInput(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "";
  const whole = Math.trunc(minor / 100);
  const frac = Math.abs(minor % 100);
  return frac ? `${whole},${String(frac).padStart(2, "0")}` : String(whole);
}

export function addMoney(into: MoneyByCurrency, currency: Currency, minor: number) {
  const v = (into[currency] ?? 0) + minor;
  if (v === 0) delete into[currency];
  else into[currency] = v;
}

export function isCurrency(v: unknown): v is Currency {
  return typeof v === "string" && (CURRENCIES as readonly string[]).includes(v);
}
