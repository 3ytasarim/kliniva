/**
 * Telefon / e-posta normalizasyonu — ülke farkındalıklı, bağımlılıksız.
 *
 * Kanonik biçim: E.164 ("+905321234567"). Arama ve olası kopya tespiti normalize değerle yapılır; kullanıcının
 * girdiği biçim ayrıca saklanır (gösterim için). Bilinmeyen ülke biçimleri için yalnızca "+" ile başlayan
 * uluslararası numaralar kabul edilir (tahmin yapılmaz).
 */
export type CountryCode = "TR" | "DE" | "GB" | "NL" | "FR" | "AZ" | "OTHER";

/** national: trunk ("0") HARİÇ ulusal numara uzunluk aralığı (Almanya gibi ülkelerde değişken uzunluk). */
const RULES: Partial<Record<CountryCode, { cc: string; national: [number, number]; trunk: string }>> = {
  TR: { cc: "90", national: [10, 10], trunk: "0" },
  DE: { cc: "49", national: [6, 13], trunk: "0" },
  GB: { cc: "44", national: [10, 10], trunk: "0" },
  NL: { cc: "31", national: [9, 9], trunk: "0" },
  FR: { cc: "33", national: [9, 9], trunk: "0" },
  AZ: { cc: "994", national: [9, 9], trunk: "0" },
};

/** E.164'e çevirir; çevrilemiyorsa VEYA birden çok yorum mümkünse null (tahmin yapılmaz). */
export function normalizePhone(raw: string | null | undefined, country: CountryCode = "TR"): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  // Açık uluslararası biçim: +<ülke kodu><numara> veya 00<ülke kodu><numara>
  if (trimmed.startsWith("+") || digits.startsWith("00")) {
    const intl = trimmed.startsWith("+") ? digits : digits.slice(2);
    return intl.length >= 8 && intl.length <= 15 ? `+${intl}` : null;
  }

  const rule = RULES[country];
  if (!rule) return null;
  const [min, max] = rule.national;
  const fits = (n: string) => n.length >= min && n.length <= max && !n.startsWith(rule.trunk);
  const candidates = new Set<string>();
  // Ulusal biçim (trunk önekli): 0532… → +90532…
  if (digits.startsWith(rule.trunk) && fits(digits.slice(rule.trunk.length))) {
    candidates.add(`+${rule.cc}${digits.slice(rule.trunk.length)}`);
  }
  // Önek olmadan ulusal numara: 532… → +90532…
  if (fits(digits)) candidates.add(`+${rule.cc}${digits}`);
  // Ülke kodu dahil ama "+" yok: 90532… → +90532…
  if (digits.startsWith(rule.cc) && fits(digits.slice(rule.cc.length))) candidates.add(`+${digits}`);
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function normalizeEmailAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v || null;
}

/** Listelerde minimum veri: son 4 hane görünür. */
export function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
}

/** Gösterim: +90 532 123 45 67 (TR) — diğer ülkeler E.164 olarak. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const m = /^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(e164);
  return m ? `+90 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164;
}
