import { formatMinutes, parseTime } from "@/lib/time";
import { APPOINTMENT_STATUS, type QuickAction } from "@/components/appointment-ui";
import { CalendarEvent } from "@/components/calendar-event";
import { Avatar } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { AppointmentStatus } from "@/types/appointments";

/**
 * Randevu takvimi (gün: sütun = doktor, hafta: sütun = gün). 07:00–21:00, 15 dk satırlar.
 * CSP uyumu: konumlar inline style ile DEĞİL, sınıflarla (row-start-*, row-span-*, col-start-* — globals.css
 * @source inline). Aynı sütunda örtüşen randevular tek hücrede yan yana gösterilir. "Şimdi" çizgisi sunucu anına göre.
 */
const START = 7 * 60;
const END = 21 * 60;
const SLOT = 15;

const GRID_COLS: Record<number, string> = {
  1: "grid-cols-[64px_repeat(1,minmax(200px,1fr))]",
  2: "grid-cols-[64px_repeat(2,minmax(170px,1fr))]",
  3: "grid-cols-[64px_repeat(3,minmax(160px,1fr))]",
  4: "grid-cols-[64px_repeat(4,minmax(150px,1fr))]",
  5: "grid-cols-[64px_repeat(5,minmax(140px,1fr))]",
  6: "grid-cols-[64px_repeat(6,minmax(130px,1fr))]",
  7: "grid-cols-[64px_repeat(7,minmax(120px,1fr))]",
};

/** Etkinlik kartı tonları (durum makinesi renkleri; sol vurgu çizgisi + açık zemin). */
const EVENT_TONE: Record<AppointmentStatus, string> = {
  DRAFT: "border-slate-300 bg-slate-50 text-slate-700 dark:bg-white/5 dark:text-slate-300",
  PENDING_APPROVAL:
    "border-amber-400 bg-amber-50/80 text-amber-950 outline-dashed outline-1 -outline-offset-1 outline-amber-300 dark:bg-amber-500/10 dark:text-amber-100",
  BOOKED: "border-brand-500 bg-brand-50 text-brand-950 dark:bg-brand-500/10 dark:text-brand-50",
  CONFIRMED: "border-brand-600 bg-brand-100/70 text-brand-950 dark:bg-brand-500/20 dark:text-brand-50",
  CHECKED_IN: "border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-500/10 dark:text-amber-100",
  IN_PROGRESS: "border-sky-500 bg-sky-50 text-sky-950 dark:bg-sky-500/10 dark:text-sky-100",
  COMPLETED:
    "border-emerald-500 bg-emerald-50/70 text-emerald-950 dark:bg-emerald-500/10 dark:text-emerald-100",
  CANCELLED:
    "border-slate-300 bg-slate-50 text-slate-400 line-through dark:bg-white/[0.03] dark:text-slate-500",
  NO_SHOW: "border-red-500 bg-red-50 text-red-950 dark:bg-red-500/10 dark:text-red-100",
};
const DOT: Record<AppointmentStatus, string> = {
  DRAFT: "bg-slate-400",
  PENDING_APPROVAL: "bg-amber-500",
  BOOKED: "bg-brand-500",
  CONFIRMED: "bg-brand-600",
  CHECKED_IN: "bg-amber-500",
  IN_PROGRESS: "bg-sky-500",
  COMPLETED: "bg-emerald-500",
  CANCELLED: "bg-slate-300",
  NO_SHOW: "bg-red-500",
};

/** Klinik saat diliminde günün dakikası ("şimdi" çizgisi; istek anına göre). */
/** Randevu başlangıcı geldi mi ("gelmedi" işaretlemesi için; sunucu da ayrıca doğrular). */
export const hasStartedAt = (iso: string) => new Date(iso).getTime() <= Date.now();

export function clinicMinutesNow(timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

export type CalendarItem = {
  id: string;
  column: string;
  status: AppointmentStatus;
  localStart: string;
  localEnd: string;
  patient: string;
  doctor: string;
  room: string | null;
  service: string | null;
  /** Kullanıcının bu randevuda yapabileceği hızlı işlemler (sunucuda yetkiye göre hesaplanır). */
  actions?: QuickAction[];
};

export type CalendarColumn = {
  key: string;
  title: string;
  subtitle?: string;
  highlight?: boolean;
  /** day: hafta görünümü (gün adı + gün numarası) · doctor: gün görünümü (avatar + ad). */
  kind?: "day" | "doctor";
  dayNumber?: string;
};

const rowFor = (minutes: number) => 2 + (Math.min(Math.max(minutes, START), END) - START) / SLOT;

type Cluster = { start: number; end: number; items: CalendarItem[] };

function clusters(items: CalendarItem[]): Cluster[] {
  const sorted = [...items].sort((a, b) => a.localStart.localeCompare(b.localStart));
  const out: Cluster[] = [];
  for (const it of sorted) {
    const s = parseTime(it.localStart) ?? START;
    const e = it.localEnd === "24:00" ? 24 * 60 : (parseTime(it.localEnd) ?? s + SLOT);
    const last = out[out.length - 1];
    if (last && s < last.end) {
      last.end = Math.max(last.end, e);
      last.items.push(it);
    } else out.push({ start: s, end: e, items: [it] });
  }
  return out;
}

export function AppointmentCalendar({
  columns,
  items,
  label,
  showDoctor,
  now,
}: {
  columns: CalendarColumn[];
  items: CalendarItem[];
  label: string;
  showDoctor: boolean;
  /** Şimdi çizgisi: hangi sütun(lar)da ve günün kaçıncı dakikasında (klinik saat dilimi). */
  now?: { columns: string[]; minutes: number } | null;
}) {
  const shown = columns.slice(0, 7);
  const n = Math.min(Math.max(shown.length, 1), 7);
  const hours = Array.from({ length: (END - START) / 60 }, (_, i) => START + i * 60);
  const outside = items.filter(
    (i) => (parseTime(i.localStart) ?? 0) < START || (parseTime(i.localStart) ?? 0) >= END,
  );
  const nowRow = now && now.minutes >= START && now.minutes < END ? Math.floor(rowFor(now.minutes)) : null;
  const countFor = (key: string) => items.filter((i) => i.column === key && i.status !== "CANCELLED").length;

  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto rounded-xl border border-line bg-white shadow-card dark:border-line-dark dark:bg-surface-dark">
        <div
          role="grid"
          aria-label={label}
          className={`grid ${GRID_COLS[n]} grid-rows-[auto_repeat(56,minmax(1.4rem,auto))]`}
        >
          <div className="sticky left-0 z-20 col-start-1 row-start-1 border-b border-line bg-white dark:border-line-dark dark:bg-surface-dark" />
          {shown.map((c, i) => (
            <div
              key={c.key}
              role="columnheader"
              className={cn(
                `col-start-${i + 2} row-start-1 border-b border-l border-line px-3 py-2.5 dark:border-line-dark`,
                c.highlight && "bg-brand-50/50 dark:bg-brand-500/5",
              )}
            >
              {c.kind === "day" ? (
                <div className="flex items-center justify-center gap-2">
                  <span
                    className={cn(
                      "text-[11px] font-semibold uppercase tracking-wide",
                      c.highlight ? "text-brand-700 dark:text-brand-300" : "text-slate-500",
                    )}
                  >
                    {c.title}
                  </span>
                  <span
                    className={cn(
                      "grid size-7 place-items-center rounded-full text-sm font-semibold tabular-nums",
                      c.highlight ? "bg-brand-600 text-white" : "text-slate-900 dark:text-slate-100",
                    )}
                  >
                    {c.dayNumber}
                  </span>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={c.title} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold">{c.title}</p>
                    <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                      {countFor(c.key)} randevu{c.subtitle ? ` · ${c.subtitle}` : ""}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))}
          {hours.map((h) => (
            <div
              key={h}
              className={`sticky left-0 z-10 col-start-1 row-start-${rowFor(h)} row-span-4 border-t border-line bg-white pr-2 text-right dark:border-line-dark dark:bg-surface-dark`}
            >
              <span className="relative -top-2 bg-white px-1 text-[11px] font-medium tabular-nums text-slate-400 dark:bg-surface-dark">
                {formatMinutes(h)}
              </span>
            </div>
          ))}
          {/* Saat ve yarım saat çizgileri (sütun arka planı) */}
          {shown.flatMap((c, i) =>
            hours.flatMap((h) => [
              <div
                key={`h-${c.key}-${h}`}
                aria-hidden="true"
                className={cn(
                  `col-start-${i + 2} row-start-${rowFor(h)} row-span-2 border-l border-t border-line dark:border-line-dark`,
                  c.highlight && "bg-brand-50/30 dark:bg-brand-500/[0.03]",
                )}
              />,
              <div
                key={`hh-${c.key}-${h}`}
                aria-hidden="true"
                className={cn(
                  `col-start-${i + 2} row-start-${rowFor(h) + 2} row-span-2 border-l border-t border-dashed border-line border-t-slate-100 dark:border-line-dark dark:border-t-white/[0.04]`,
                  c.highlight && "bg-brand-50/30 dark:bg-brand-500/[0.03]",
                )}
              />,
            ]),
          )}
          {shown.flatMap((c, i) =>
            clusters(items.filter((it) => it.column === c.key)).map((cl) => {
              const start = rowFor(cl.start);
              const span = Math.max(2, Math.ceil(rowFor(cl.end) - start));
              return (
                <div
                  key={`${c.key}-${cl.items[0]!.id}`}
                  className={`col-start-${i + 2} row-start-${Math.floor(start)} row-span-${span} z-10 flex min-w-0 gap-1 p-[3px]`}
                >
                  {cl.items.map((it) => (
                    <CalendarEvent
                      key={it.id}
                      id={it.id}
                      patient={it.patient}
                      timeLabel={`${it.localStart}–${it.localEnd}`}
                      service={it.service}
                      room={it.room}
                      doctor={it.doctor}
                      showDoctor={showDoctor}
                      statusLabel={APPOINTMENT_STATUS[it.status].label}
                      statusBadge={APPOINTMENT_STATUS[it.status].badge}
                      toneClass={EVENT_TONE[it.status]}
                      dotClass={DOT[it.status]}
                      actions={it.actions ?? []}
                    />
                  ))}
                </div>
              );
            }),
          )}
          {nowRow
            ? shown.map((c, i) =>
                now!.columns.includes(c.key) ? (
                  <div
                    key={`now-${c.key}`}
                    aria-hidden="true"
                    className={`pointer-events-none relative z-20 col-start-${i + 2} row-start-${nowRow} self-start`}
                  >
                    <span className="absolute -left-1 -top-[5px] size-2.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-surface-dark" />
                    <span className="block h-0.5 bg-red-500" />
                  </div>
                ) : null,
              )
            : null}
        </div>
      </div>
      {outside.length ? (
        <p className="text-xs text-slate-500">
          07:00–21:00 dışındaki {outside.length} randevu takvimde gösterilmiyor; listeden açabilirsiniz.
        </p>
      ) : null}
    </div>
  );
}
