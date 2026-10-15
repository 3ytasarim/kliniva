"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Statik imza alanı (tablet / telefon / fare).
 *
 * KVKK — biyometrik veri toplanmaz:
 *  - Yalnızca O ANKİ x/y koordinatı ile canvas'a çizgi çizilir; koordinatlar BİRİKTİRİLMEZ (dizi/yörünge yok),
 *    saklanmaz, sunucuya gönderilmez.
 *  - PointerEvent'in pressure, tiltX/tiltY, twist, width/height, timeStamp alanları OKUNMAZ; hız / ivme /
 *    zamanlama hesaplanmaz. Çizgi kalınlığı sabittir.
 *  - Çıktı yalnızca canvas.toDataURL("image/png") — statik raster görüntü. Sunucu PNG'yi decode edip yeniden kodlar.
 */
export function SignaturePad({
  onChange,
  width = 900,
  height = 300,
  label = "İmza alanı",
}: {
  onChange: (pngDataUrl: string | null) => void;
  width?: number;
  height?: number;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  const setupContext = useCallback(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, []);

  useEffect(setupContext, [setupContext]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * e.currentTarget.width,
      y: ((e.clientY - rect.top) / rect.height) * e.currentTarget.height,
    };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const { x, y } = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y + 0.1); // tek dokunuşta nokta
    ctx.stroke();
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const { x, y } = point(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const finish = useCallback(() => {
    if (!drawing.current) return;
    drawing.current = false;
    setEmpty(false);
    onChange(canvasRef.current?.toDataURL("image/png") ?? null);
  }, [onChange]);

  const clear = () => {
    const c = canvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setupContext();
    setEmpty(true);
    onChange(null);
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        role="img"
        aria-label={label}
        data-testid="signature-canvas"
        className="aspect-[3/1] w-full cursor-crosshair touch-none rounded-2xl border-2 border-dashed border-slate-300 bg-white dark:border-slate-600"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={finish}
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-slate-500" aria-live="polite">
          {empty
            ? "Lütfen kutunun içine imzanızı atın."
            : "İmza alındı. Gerekirse temizleyip yeniden çizebilirsiniz."}
        </span>
        <button type="button" className="btn-ghost min-h-12 px-6" onClick={clear} disabled={empty}>
          İmzayı temizle
        </button>
      </div>
    </div>
  );
}
