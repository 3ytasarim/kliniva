"use client";

import { useEffect, useRef } from "react";

/**
 * Sayı sayacı — sunucu son değeri yazar (JS'siz / test ortamında doğru değer), istemci bağlanınca 0'dan son değere
 * sayar. Metin DOM'da doğrudan güncellenir (kare başına React render'ı yok). Hareket azaltma tercihinde animasyon yok.
 */
export function CountUp({ value, duration = 900 }: { value: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || value <= 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fmt = new Intl.NumberFormat("tr-TR");
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt.format(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = fmt.format(value);
    };
  }, [value, duration]);
  return <span ref={ref}>{new Intl.NumberFormat("tr-TR").format(value)}</span>;
}
