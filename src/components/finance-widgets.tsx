import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/money";
import { STAGGER } from "@/components/dashboard-widgets";

/**
 * Panel finans bileşenleri (sunucu bileşeni; CSP uyumlu — satır içi stil yok, SVG öznitelikleri). Tutarlar kuruş.
 */
const compact = new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 });

/** Son 6 ay gelir / gider — gruplu çubuk grafik (TRY). Her çubuk <title> ile erişilebilir değer taşır. */
export function IncomeExpenseChart({
  data,
}: {
  data: { key: string; label: string; incomeMinor: number; expenseMinor: number }[];
}) {
  const W = 720;
  const H = 220;
  const P = { l: 48, r: 12, t: 14, b: 28 };
  const maxV = Math.max(100_00, ...data.flatMap((d) => [d.incomeMinor, d.expenseMinor]));
  const step = niceStep(maxV / 4);
  const top = step * 4;
  const slot = (W - P.l - P.r) / Math.max(data.length, 1);
  const bw = Math.min(26, slot / 3.2);
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - v / top);
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Son 6 ayın gelir ve gideri"
      className="h-auto w-full"
    >
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={P.l}
            x2={W - P.r}
            y1={y(t)}
            y2={y(t)}
            className="stroke-slate-200 dark:stroke-white/10"
            strokeDasharray={t ? "3 4" : undefined}
          />
          <text x={P.l - 8} y={y(t) + 4} textAnchor="end" className="fill-slate-400 text-[10px] tabular-nums">
            {compact.format(t / 100)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const cx = P.l + slot * i + slot / 2;
        const last = i === data.length - 1;
        return (
          <g key={d.key}>
            <rect
              x={cx - bw - 2}
              y={y(d.incomeMinor)}
              width={bw}
              height={Math.max(0, y(0) - y(d.incomeMinor))}
              rx={4}
              className={cn("animate-rise fill-brand-600", STAGGER[i % STAGGER.length])}
            >
              <title>{`${d.label}: gelir ${formatMoney(d.incomeMinor)}`}</title>
            </rect>
            <rect
              x={cx + 2}
              y={y(d.expenseMinor)}
              width={bw}
              height={Math.max(0, y(0) - y(d.expenseMinor))}
              rx={4}
              className={cn("animate-rise fill-rose-300 dark:fill-rose-400/70", STAGGER[i % STAGGER.length])}
            >
              <title>{`${d.label}: gider ${formatMoney(d.expenseMinor)}`}</title>
            </rect>
            <text
              x={cx}
              y={H - 8}
              textAnchor="middle"
              className={cn(
                "text-[10px]",
                last ? "fill-brand-700 font-semibold dark:fill-brand-300" : "fill-slate-400",
              )}
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

export function IncomeExpenseLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-3 rounded-full bg-brand-600" />
        Gelir
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-3 rounded-full bg-rose-300" />
        Gider
      </li>
    </ul>
  );
}

/** En çok ciro yapan hizmetler — oransal yatay çubuklar. */
export function TopServices({ items }: { items: { name: string; totalMinor: number; count: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.totalMinor));
  return (
    <ol className="grid gap-3">
      {items.map((s, i) => (
        <li key={s.name} className={cn("animate-enter", STAGGER[i % STAGGER.length])}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium">{s.name}</span>
            <span className="shrink-0 font-semibold tabular-nums">{formatMoney(s.totalMinor)}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-white/5">
              <div
                className={cn(
                  "animate-grow-x h-full origin-left rounded-full bg-gradient-to-r from-brand-500 to-brand-700",
                  WIDTH[Math.round((s.totalMinor / max) * 20)],
                )}
              />
            </div>
            <span className="w-16 shrink-0 text-right text-[11px] text-slate-500">{s.count} kez</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

const SOURCE_COLORS = [
  "from-brand-500 to-brand-700",
  "from-violet-500 to-violet-700",
  "from-sky-500 to-sky-700",
  "from-amber-400 to-amber-600",
  "from-rose-400 to-rose-600",
  "from-emerald-500 to-emerald-700",
  "from-slate-400 to-slate-600",
];

/** Hasta kaynakları — yüzde payı + ziyaret sayısı (yatay çubuklar, CSP uyumlu). */
export function SourceBreakdown({
  items,
  total,
}: {
  items: { name: string; count: number }[];
  total: number;
}) {
  return (
    <ol className="grid gap-3">
      {items.slice(0, 7).map((s, i) => {
        const pct = total ? Math.round((s.count / total) * 100) : 0;
        return (
          <li key={s.name} className={cn("animate-enter", STAGGER[i % STAGGER.length])}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium">{s.name}</span>
              <span className="shrink-0 tabular-nums text-slate-500">
                <span className="font-semibold text-slate-900 dark:text-white">%{pct}</span> · {s.count}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/5">
              <div
                className={cn(
                  "animate-grow-x h-full origin-left rounded-full bg-gradient-to-r",
                  SOURCE_COLORS[i % SOURCE_COLORS.length],
                  WIDTH[Math.round(pct / 5)],
                )}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** CSP: satır içi width yerine sabit sınıf basamakları (%5 adım). */
const WIDTH = [
  "w-[2%]",
  "w-[5%]",
  "w-[10%]",
  "w-[15%]",
  "w-[20%]",
  "w-[25%]",
  "w-[30%]",
  "w-[35%]",
  "w-[40%]",
  "w-[45%]",
  "w-[50%]",
  "w-[55%]",
  "w-[60%]",
  "w-[65%]",
  "w-[70%]",
  "w-[75%]",
  "w-[80%]",
  "w-[85%]",
  "w-[90%]",
  "w-[95%]",
  "w-full",
];
