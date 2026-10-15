/** Stok miktarı yardımcıları (float yok: binde birim tamsayı) — istemci ve sunucuda kullanılabilir. */
export const toMilli = (q: string | number) => Math.round(Number(q) * 1000);
export const fromMilli = (m: number) => (m / 1000).toFixed(3);
/** "5.000" → "5", "2.500" → "2,5" (Türkçe gösterim). */
export const formatQuantity = (q: string | number | null | undefined) =>
  q === null || q === undefined ? "—" : String(Number(Number(q).toFixed(3))).replace(".", ",");
