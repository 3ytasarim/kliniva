/**
 * Lot seçimi ve SKT anlamı — SAF hesaplama (DB yok → birim test edilebilir). Miktarlar binde birim tamsayı.
 *
 * SKT ANLAMI: expiryDate bir DATE'tir (saat dilimi yok). Lot, lotun bulunduğu şubenin YEREL takviminde SKT gününün
 * SONUNA kadar geçerlidir: usageDate <= expiryDate → kullanılabilir; usageDate > expiryDate → süresi geçmiş.
 * usageDate her zaman sunucuda, şubenin IANA saat dilimiyle hesaplanır (istemci durumuna güvenilmez).
 *
 * FEFO (First Expired, First Out) sıralaması:
 *   1. süresi geçmemiş, geri çağrılmamış, aktif, miktarı > 0 olanlar (diğerleri hiç seçilmez)
 *   2. en yakın SKT önce
 *   3. SKT'siz lotlar en sona
 *   4. teslim alma zamanı (eski önce)
 *   5. deterministik kimlik (id) sıralaması
 */
export type LotCandidate = {
  id: string;
  lotNumber: string;
  /** "YYYY-MM-DD" veya null. */
  expiryDate: string | null;
  quantityMilli: number;
  receivedAt: Date | null;
  recalled: boolean;
  active: boolean;
};

export type LotAllocation = {
  lotId: string;
  lotNumber: string;
  expiryDate: string | null;
  quantityMilli: number;
};

/** usageDate ("YYYY-MM-DD", şube yerel) itibarıyla süresi geçmiş mi? SKT günü boyunca geçerli. */
export const isExpired = (expiryDate: string | null, usageDate: string) =>
  expiryDate !== null && usageDate > expiryDate;

export const isUsable = (l: LotCandidate, usageDate: string) =>
  l.active && !l.recalled && l.quantityMilli > 0 && !isExpired(l.expiryDate, usageDate);

export function fefoOrder(lots: LotCandidate[], usageDate: string): LotCandidate[] {
  return lots
    .filter((l) => isUsable(l, usageDate))
    .sort((a, b) => {
      if (a.expiryDate !== b.expiryDate) {
        if (a.expiryDate === null) return 1;
        if (b.expiryDate === null) return -1;
        return a.expiryDate < b.expiryDate ? -1 : 1;
      }
      const ra = a.receivedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rb = b.receivedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** FEFO tahsisi. Kullanılabilir toplam yetersizse `shortfallMilli` > 0 ve tahsis boş döner (kısmi tahsis yok). */
export function fefoAllocate(
  lots: LotCandidate[],
  needMilli: number,
  usageDate: string,
): { allocations: LotAllocation[]; shortfallMilli: number } {
  const out: LotAllocation[] = [];
  let left = needMilli;
  for (const l of fefoOrder(lots, usageDate)) {
    if (left <= 0) break;
    const take = Math.min(left, l.quantityMilli);
    out.push({ lotId: l.id, lotNumber: l.lotNumber, expiryDate: l.expiryDate, quantityMilli: take });
    left -= take;
  }
  return left > 0 ? { allocations: [], shortfallMilli: left } : { allocations: out, shortfallMilli: 0 };
}

export type LotStatus =
  "AVAILABLE" | "LOW_STOCK" | "EXPIRING_SOON" | "EXPIRED" | "DEPLETED" | "INACTIVE" | "RECALLED";

/** Türetilmiş lot durumu (DB'de saklanmaz). */
export function lotStatus(
  l: Pick<LotCandidate, "active" | "recalled" | "quantityMilli" | "expiryDate">,
  today: string,
  warningUntil: string,
  lowMilli: number | null = null,
): LotStatus {
  if (!l.active) return "INACTIVE";
  if (l.recalled) return "RECALLED";
  if (l.quantityMilli <= 0) return "DEPLETED";
  if (isExpired(l.expiryDate, today)) return "EXPIRED";
  if (l.expiryDate !== null && l.expiryDate <= warningUntil) return "EXPIRING_SOON";
  if (lowMilli !== null && l.quantityMilli <= lowMilli) return "LOW_STOCK";
  return "AVAILABLE";
}

/** "YYYY-MM-DD" farkı (gün). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
