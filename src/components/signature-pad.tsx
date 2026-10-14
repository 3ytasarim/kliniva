"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Statik imza alanı (tablet / telefon / fare).
 *
 * KVKK — biyometrik veri toplanmaz:
 *  - Yalnızca anlık x/y koordinatı ile canvas'a çizgi çizilir; koordinatlar BİRİKTİRİLMEZ, saklanmaz, gönderilmez.
 *  - PointerEvent'in pressure, tiltX/tiltY, twist, width/height, timeStamp alanları OKUNMAZ.
 *  - Çizgi kalınlığı sabittir (basınca göre değişmez). Hız/ivme/vuruş zamanlaması hesaplanmaz.
 *  - Çıktı yalnızca canvas.toDataURL("image/png") — statik görüntü. Sunucu PNG'yi ayrıca temizler.
 */
export function SignaturePad({
  onChange,
  width = 600,
  height = 220,
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

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  }, []);

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
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const { x, y } = point(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
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
        className="w-full touch-none rounded-lg border border-dashed border-slate-400 bg-white"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={finish}
      />
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span>{empty ? "Lütfen kutunun içine imzanızı atın." : "İmza alındı."}</span>
        <button type="button" className="btn-ghost" onClick={clear}>
          Temizle
        </button>
      </div>
    </div>
  );
}
