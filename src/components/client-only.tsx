"use client";

import { useEffect, useState } from "react";

/**
 * Çocukları YALNIZCA istemcide render eder (sunucu HTML'inde yer tutucu).
 *
 * Neden: React akışlı SSR'de geç tamamlanan SVG parçalarını `<svg style="display:none">` kabıyla gönderir (HTML'de
 * `hidden` kullanır, SVG'de kullanamaz). Bu satır içi stil nonce'lu CSP'yi ihlal eder. Büyük SVG grafikler istemcide
 * çizilince HTML'e stil özniteliği girmez (DOM API'leri CSP'ye takılmaz).
 * Bağlandıktan sonra bir sonraki görev döngüsünde gösterilir (effect gövdesinde eşzamanlı setState yok).
 */
export function ClientOnly({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(t);
  }, []);
  return mounted ? children : fallback;
}
