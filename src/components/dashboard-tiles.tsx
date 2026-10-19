import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Icon, type IconName } from "@/components/ui";
import { STAGGER } from "@/components/dashboard-widgets";
import { cn } from "@/lib/cn";

/**
 * Panel kartları ve grafikleri (sunucu bileşeni). İki temada da çalışır: açık temada beyaz cam kart + mor vurgu;
 * koyu temada buzlu cam (globals.css).
 * CSP: satır içi stil YOK — yükseklikler SVG öznitelikleriyle, genişlikler sabit sınıf basamaklarıyla.
 */

export type Delta = { pct: number | null; good?: "up" | "down" };

function DeltaBadge({ d }: { d: Delta }) {
  if (d.pct === null) return null;
  const up = d.pct >= 0;
  const good = (d.good ?? "up") === "up" ? up : !up;
  return (
    <span className={cn("kv-delta", good ? "kv-delta-up" : "kv-delta-down")}>
      <span aria-hidden="true">{up ? "↑" : "↓"}</span>
      <span>
        %{Math.abs(d.pct).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}
        <span className="sr-only">{up ? " artış" : " azalış"}</span>
      </span>
    </span>
  );
}

/** Metrik kartı: başlık (h2), büyük değer, değişim rozeti, alt metin ve ↗ bağlantı düğmesi. */
export function MetricTile({
  title,
  value,
  sub,
  delta,
  href,
  primary,
  index = 0,
  testId,
}: {
  title: string;
  value: string;
  sub?: string;
  delta?: Delta;
  href?: string;
  primary?: boolean;
  index?: number;
  testId?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <h2
          className={cn(
            "text-[13.5px] font-semibold",
            primary ? "text-white/95" : "text-slate-600 dark:text-slate-200",
          )}
        >
          {title}
        </h2>
        {href ? (
          <span className="kv-arrow" aria-hidden="true">
            <ArrowUpRight className="size-4" />
          </span>
        ) : null}
      </div>
      <div className="mt-auto pt-6">
        <div className="flex items-end justify-between gap-2">
          <p className="text-[26px] font-bold leading-none tracking-tight tabular-nums">{value}</p>
          {delta ? <DeltaBadge d={delta} /> : null}
        </div>
        {sub ? (
          <p
            className={cn("mt-1.5 text-xs", primary ? "text-white/75" : "text-slate-500 dark:text-slate-400")}
          >
            {sub}
          </p>
        ) : null}
      </div>
    </>
  );
  const cls = cn(
    "card group animate-enter flex min-h-[148px] flex-col p-4",
    primary && "kv-accent-tile",
    href && "card-link",
    STAGGER[index % STAGGER.length],
  );
  return href ? (
    <Link href={href} className={cls} data-testid={testId}>
      {body}
    </Link>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

/**
 * Parlak hap çubuk grafik (SVG). Her sütun odaklanabilir; değer etiketi üzerine gelince / odakta görünür, son sütun
 * varsayılan etkin. Erişilebilirlik: grafik role=img + ad; her sütun <title> taşır.
 */
export function PillBarChart({
  data,
  label,
  formatTick = (v) => String(v),
}: {
  data: { key: string; label: string; value: number; display: string }[];
  label: string;
  formatTick?: (v: number) => string;
}) {
  const W = 720;
  const H = 240;
  const P = { l: 46, r: 8, t: 30, b: 26 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = niceStep(max / 4);
  const top = step * 4;
  const slot = (W - P.l - P.r) / Math.max(data.length, 1);
  const bw = Math.min(26, slot * 0.46);
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - v / top);
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
      <defs>
        <linearGradient id="kv-bar-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#818cf8" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.8" />
        </linearGradient>
        <linearGradient id="kv-bar-gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={P.l}
            x2={W - P.r}
            y1={y(t)}
            y2={y(t)}
            className="stroke-slate-200 dark:stroke-white/12"
            strokeDasharray="2 5"
          />
          <text x={P.l - 8} y={y(t) + 4} textAnchor="end" className="fill-slate-400 text-[10px] tabular-nums">
            {formatTick(t)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = P.l + slot * i + slot / 2;
        const h = Math.max(6, y(0) - y(d.value));
        const last = i === data.length - 1;
        return (
          <g
            key={d.key}
            className={cn("kv-bar-col outline-none", last && "kv-bar-col-active")}
            tabIndex={0}
            aria-label={`${d.label}: ${d.display}`}
          >
            <title>{`${d.label}: ${d.display}`}</title>
            <rect x={cx - slot / 2} y={P.t} width={slot} height={H - P.t - P.b} fill="transparent" />
            <rect
              x={cx - bw / 2}
              y={y(0) - h}
              width={bw}
              height={h}
              rx={bw / 3.5}
              className={cn("kv-bar animate-rise", last && "kv-bar-active", STAGGER[i % STAGGER.length])}
            />
            <rect
              x={cx - bw / 2 + 1}
              y={y(0) - h + 1}
              width={bw - 2}
              height={Math.min(h * 0.4, 40)}
              rx={bw / 3.5}
              fill="url(#kv-bar-gloss)"
              pointerEvents="none"
            />
            <g className="kv-bar-tip" pointerEvents="none">
              <rect
                x={cx - 30}
                y={y(0) - h - 26}
                width={60}
                height={19}
                rx={6}
                className="fill-slate-900 dark:fill-white"
              />
              <text
                x={cx}
                y={y(0) - h - 12.5}
                textAnchor="middle"
                className="fill-white text-[10.5px] font-bold dark:fill-slate-900"
              >
                {d.display}
              </text>
            </g>
            <text
              x={cx}
              y={H - 7}
              textAnchor="middle"
              className="kv-bar-label fill-slate-400 text-[10px] font-semibold"
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function niceStep(raw: number): number {
  const v = Math.max(raw, 1);
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const DONUT_COLORS = ["#f97316", "#38bdf8", "#facc15", "#f87171", "#34d399", "#a78bfa", "#94a3b8"];
const DONUT_DOT = [
  "bg-orange-500",
  "bg-sky-400",
  "bg-yellow-400",
  "bg-red-400",
  "bg-emerald-400",
  "bg-violet-400",
  "bg-slate-400",
];

/** Halka grafik + açıklama (yüzde etiketli). */
export function DonutChart({ items, label }: { items: { name: string; count: number }[]; label: string }) {
  const total = items.reduce((s, i) => s + i.count, 0) || 1;
  const size = 140;
  const sw = 20;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const top = items.slice(0, 7);
  // Her dilimin başlangıç oranı (render sırasında değişken yeniden atanmaz).
  const starts = top.map((_, i) => top.slice(0, i).reduce((s2, x) => s2 + x.count / total, 0));
  return (
    <div className="flex min-w-0 flex-col items-center gap-4">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={label}
        className="size-36 shrink-0 -rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={sw}
          className="stroke-slate-100 dark:stroke-white/8"
        />
        {top.map((it, i) => {
          const frac = it.count / total;
          const dash = Math.max(0, frac * c - 2);
          const el = (
            <circle
              key={it.name}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
              strokeWidth={sw}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-starts[i]! * c}
              className="animate-enter"
            >
              <title>{`${it.name}: %${Math.round(frac * 100)}`}</title>
            </circle>
          );
          return el;
        })}
      </svg>
      <ul className="grid w-full min-w-0 gap-2 text-sm">
        {top.map((it, i) => (
          <li key={it.name} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn("size-2.5 shrink-0 rounded-full", DONUT_DOT[i % DONUT_DOT.length])}
            />
            <span className="min-w-0 flex-1 truncate font-medium">{it.name}</span>
            <span className="tabular-nums text-slate-500 dark:text-slate-400">
              %{Math.round((it.count / total) * 100)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Dalgalı çizgi süsü (dekoratif). */
export function WaveGraphic({ className }: { className?: string }) {
  const lines = [
    ["M0,35 C30,15 60,50 90,30 C120,10 150,45 180,25 C200,10 220,35 250,20", "#3b82f6", 0.85],
    ["M0,40 C32,20 62,55 92,35 C122,15 152,50 182,30 C202,15 222,40 250,25", "#60a5fa", 0.7],
    ["M0,45 C34,25 64,60 94,40 C124,20 154,55 184,35 C204,20 224,45 250,30", "#93c5fd", 0.6],
    ["M0,50 C36,30 66,65 96,45 C126,25 156,60 186,40 C206,25 226,50 250,35", "#6366f1", 0.5],
    ["M0,55 C38,35 68,70 98,50 C128,30 158,65 188,45 C208,30 228,55 250,40", "#818cf8", 0.4],
  ] as const;
  return (
    <svg viewBox="0 0 250 80" fill="none" preserveAspectRatio="none" aria-hidden="true" className={className}>
      {lines.map(([d, stroke, op]) => (
        <path key={d} d={d} stroke={stroke} strokeOpacity={op} strokeWidth={1.1} strokeLinecap="round" />
      ))}
    </svg>
  );
}

/** Özet kartı: büyük sayı + kelime, açıklama (vurgulu parça), simge rozeti, isteğe bağlı dalga ve bağlantı. */
export function SummaryTile({
  icon,
  count,
  word,
  children,
  href,
  wave,
  index = 0,
}: {
  icon: IconName;
  count: number;
  word: string;
  children: React.ReactNode;
  href?: string;
  wave?: boolean;
  index?: number;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="grid size-9 place-items-center rounded-full border border-line bg-slate-50 text-slate-600 dark:border-white/25 dark:bg-white/10 dark:text-white">
          <Icon name={icon} className="size-4" />
        </span>
        {wave ? <WaveGraphic className="h-12 w-40 opacity-90" /> : null}
        {href ? (
          <span className="kv-arrow" aria-hidden="true">
            <ArrowUpRight className="size-4" />
          </span>
        ) : null}
      </div>
      <div className="mt-auto pt-8">
        <p className="text-[28px] font-bold leading-none tracking-tight">
          <span className="tabular-nums">{count}</span> <span className="text-lg font-semibold">{word}</span>
        </p>
        <p className="mt-2 text-[13px] text-slate-600 dark:text-slate-300">{children}</p>
      </div>
    </>
  );
  const cls = cn(
    "card group animate-enter flex min-h-[170px] flex-col p-5",
    href && "card-link",
    STAGGER[index % STAGGER.length],
  );
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Açıklamadaki vurgulu parça (mercan rengi). */
export function Accent({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold text-rose-500 dark:text-rose-400">{children}</span>;
}
