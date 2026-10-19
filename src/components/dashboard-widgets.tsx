import Link from "next/link";
import { Icon, type IconName } from "@/components/ui";
import { cn } from "@/lib/cn";
import { CountUp } from "@/components/count-up";
import { SEVERITY_DOT } from "@/components/notification-ui";
import type { NotificationSeverityCode } from "@/types/notifications";

/**
 * Panel bileşenleri (sunucu bileşeni; CSP uyumlu — satır içi stil YOK, grafik SVG öznitelikleriyle çizilir).
 * Görsel dil: üst vurgu şeridi + hafif renk parıltısı + degrade simge karosu + 2×2 alt metrik (çok metrikli KPI kartı).
 */
export type Accent = "brand" | "sky" | "violet" | "amber" | "rose";

const ACCENT: Record<Accent, { bar: string; glow: string; tile: string }> = {
  brand: {
    bar: "before:bg-brand-500",
    glow: "bg-brand-500",
    tile: "from-brand-500/15 to-brand-500/5 text-brand-700 ring-brand-500/15 dark:text-brand-300",
  },
  sky: {
    bar: "before:bg-sky-500",
    glow: "bg-sky-500",
    tile: "from-sky-500/15 to-sky-500/5 text-sky-700 ring-sky-500/15 dark:text-sky-300",
  },
  violet: {
    bar: "before:bg-violet-500",
    glow: "bg-violet-500",
    tile: "from-violet-500/15 to-violet-500/5 text-violet-700 ring-violet-500/15 dark:text-violet-300",
  },
  amber: {
    bar: "before:bg-amber-500",
    glow: "bg-amber-500",
    tile: "from-amber-500/15 to-amber-500/5 text-amber-700 ring-amber-500/15 dark:text-amber-300",
  },
  rose: {
    bar: "before:bg-rose-500",
    glow: "bg-rose-500",
    tile: "from-rose-500/15 to-rose-500/5 text-rose-700 ring-rose-500/15 dark:text-rose-300",
  },
};

export type StatTone = "default" | "success" | "warning" | "danger" | "muted";
const TONE: Record<StatTone, string> = {
  default: "text-slate-900 dark:text-white",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-rose-600 dark:text-rose-400",
  muted: "text-slate-500 dark:text-slate-400",
};

/** Kademeli giriş animasyonu (satır içi stil yerine sınıf; prefers-reduced-motion'da kapanır). */
export const STAGGER = [
  "",
  "[animation-delay:60ms]",
  "[animation-delay:120ms]",
  "[animation-delay:180ms]",
  "[animation-delay:240ms]",
  "[animation-delay:300ms]",
];

export function KpiCard({
  title,
  icon,
  accent,
  stats,
  href,
  footer,
  index = 0,
}: {
  title: string;
  icon: IconName;
  accent: Accent;
  stats: { label: string; value: string | number; tone?: StatTone }[];
  href?: string;
  footer?: string;
  index?: number;
}) {
  const a = ACCENT[accent];
  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -right-10 -top-10 size-32 rounded-full opacity-[0.13] blur-2xl",
          a.glow,
        )}
      />
      <div className="relative flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold tracking-tight text-slate-700 dark:text-slate-200">
          {title}
        </h2>
        <span className={cn("grid size-10 place-items-center rounded-xl bg-gradient-to-br ring-1", a.tile)}>
          <Icon name={icon} className="size-5" />
        </span>
      </div>
      <dl className="relative mt-4 grid grid-cols-2 gap-x-4 gap-y-3.5">
        {stats.map((s, i) => (
          <div key={s.label} className={cn(i === 0 && "col-span-1")}>
            <dt className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{s.label}</dt>
            <dd
              className={cn(
                "mt-0.5 text-2xl font-semibold leading-none tracking-tight tabular-nums",
                TONE[s.tone ?? "default"],
              )}
            >
              {typeof s.value === "number" ? <CountUp value={s.value} /> : s.value}
            </dd>
          </div>
        ))}
      </dl>
      {footer ? (
        <p className="relative mt-4 flex items-center gap-1 border-t border-line pt-3 text-xs font-medium text-slate-500 dark:border-line-dark dark:text-slate-400">
          {footer}
          {href ? <Icon name="chevronRight" className="size-3.5" /> : null}
        </p>
      ) : null}
    </>
  );
  const cls = cn(
    "card animate-enter relative block h-full overflow-hidden rounded-2xl p-5 before:absolute before:inset-x-0 before:top-0 before:h-1 before:content-['']",
    a.bar,
    STAGGER[index % STAGGER.length],
  );
  return href ? (
    <Link href={href} className={cn(cls, "card-link")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export type TrendPoint = { date: string; label: string; total: number; completed: number; missed: number };

/**
 * Randevu eğilimi — SVG alan + çizgi grafiği (toplam alan, tamamlanan çizgi, iptal / gelmedi kesikli çizgi).
 * Yalnızca SVG öznitelikleri (CSP). Her nokta <title> ile erişilebilir değer taşır.
 */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  const W = 720;
  const H = 220;
  const P = { l: 34, r: 12, t: 14, b: 28 };
  const max = Math.max(4, ...data.map((d) => d.total));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const x = (i: number) => P.l + (i * (W - P.l - P.r)) / Math.max(data.length - 1, 1);
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - v / top);
  const line = (k: keyof Pick<TrendPoint, "total" | "completed" | "missed">) =>
    data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(" ");
  const area = `${line("total")} L${x(data.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Son 14 günün randevu eğilimi"
      className="h-auto w-full"
    >
      <defs>
        <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#138a7e" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#138a7e" stopOpacity="0.02" />
        </linearGradient>
      </defs>
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
            {t}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#trend-fill)" className="animate-enter [animation-delay:500ms]" />
      <path
        d={line("total")}
        fill="none"
        pathLength={1}
        className="animate-draw stroke-brand-600"
        strokeWidth="2.25"
        strokeLinejoin="round"
      />
      <path
        d={line("completed")}
        fill="none"
        pathLength={1}
        className="animate-draw stroke-emerald-500 [animation-delay:150ms]"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d={line("missed")}
        fill="none"
        className="stroke-rose-400"
        strokeWidth="1.75"
        strokeDasharray="4 4"
        strokeLinejoin="round"
      />
      {data.map((d, i) => (
        <g key={d.date}>
          <circle
            cx={x(i)}
            cy={y(d.total)}
            r={i === data.length - 1 ? 4.5 : 3}
            className={cn(
              "animate-rise fill-white stroke-brand-600 dark:fill-surface-dark",
              STAGGER[i % STAGGER.length],
            )}
            strokeWidth="2"
          >
            <title>{`${d.label}: ${d.total} randevu, ${d.completed} tamamlandı, ${d.missed} iptal / gelmedi`}</title>
          </circle>
          {i % 2 === data.length % 2 || i === data.length - 1 ? (
            <text
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              className={cn(
                "text-[10px] tabular-nums",
                i === data.length - 1 ? "fill-brand-700 font-semibold dark:fill-brand-300" : "fill-slate-400",
              )}
            >
              {d.label}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

export function ChartLegend() {
  const items = [
    ["bg-brand-600", "Toplam"],
    ["bg-emerald-500", "Tamamlanan"],
    ["bg-rose-400", "İptal / gelmedi"],
  ] as const;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
      {items.map(([c, l]) => (
        <li key={l} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("h-2 w-3 rounded-full", c)} />
          {l}
        </li>
      ))}
    </ul>
  );
}

/** Önümüzdeki 7 gün — gün başına randevu sayısı (yatay çubuk). */
export function WeekStrip({
  days,
  hrefFor,
}: {
  days: { date: string; dayShort: string; dayNumber: string; count: number; isToday: boolean }[];
  hrefFor: (date: string) => string;
}) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const WIDTH = [
    "w-0",
    "w-[10%]",
    "w-1/5",
    "w-[30%]",
    "w-2/5",
    "w-1/2",
    "w-3/5",
    "w-[70%]",
    "w-4/5",
    "w-[90%]",
    "w-full",
  ];
  return (
    <ul className="grid gap-1.5">
      {days.map((d) => (
        <li key={d.date}>
          <Link
            href={hrefFor(d.date)}
            className="group grid grid-cols-[3rem_minmax(0,1fr)_2rem] items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:shadow-focus dark:hover:bg-white/[0.03]"
          >
            <span className="flex items-baseline gap-1.5">
              <span
                className={cn(
                  "text-[11px] font-semibold uppercase",
                  d.isToday ? "text-brand-700 dark:text-brand-300" : "text-slate-400",
                )}
              >
                {d.dayShort}
              </span>
              <span
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  d.isToday && "text-brand-700 dark:text-brand-300",
                )}
              >
                {d.dayNumber}
              </span>
            </span>
            <span className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-white/5">
              <span
                className={cn(
                  "animate-grow-x block h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-[width]",
                  WIDTH[Math.round((d.count / max) * 10)],
                )}
              />
            </span>
            <span className="text-right text-sm font-semibold tabular-nums">{d.count}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ActivityFeed({
  items,
}: {
  items: {
    id: string;
    title: string;
    context: string | null;
    severity: NotificationSeverityCode;
    href: string | null;
    at: string;
    unread: boolean;
  }[];
}) {
  return (
    <ol className="relative grid gap-0.5 before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-line before:content-[''] dark:before:bg-line-dark">
      {items.map((n) => {
        const inner = (
          <>
            <span className="relative z-10 mt-1 grid size-[23px] shrink-0 place-items-center rounded-full bg-white ring-1 ring-line dark:bg-surface-dark dark:ring-line-dark">
              <span aria-hidden="true" className={cn("size-2 rounded-full", SEVERITY_DOT[n.severity])} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className={cn("truncate text-sm", n.unread ? "font-semibold" : "font-medium")}>
                  {n.title}
                </span>
                {n.unread ? (
                  <span className="size-1.5 shrink-0 rounded-full bg-brand-500" aria-label="okunmamış" />
                ) : null}
              </span>
              {n.context ? (
                <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{n.context}</span>
              ) : null}
              <span className="block text-[11px] text-slate-400">{n.at}</span>
            </span>
          </>
        );
        return (
          <li key={n.id}>
            {n.href ? (
              <Link
                href={n.href}
                className="flex gap-3 rounded-lg px-1 py-2 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:shadow-focus dark:hover:bg-white/[0.03]"
              >
                {inner}
              </Link>
            ) : (
              <div className="flex gap-3 px-1 py-2">{inner}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Halka gösterge (yüzde) — SVG öznitelikleri. */
export function Ring({ value, label }: { value: number; label: string }) {
  const r = 26;
  const v = Math.max(0, Math.min(100, value));
  return (
    <svg
      viewBox="0 0 64 64"
      className="size-16 -rotate-90"
      role="img"
      aria-label={`${label}: %${Math.round(v)}`}
    >
      <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-white/25" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        strokeWidth="6"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${v.toFixed(1)} 100`}
        className="animate-ring stroke-white"
      />
    </svg>
  );
}
