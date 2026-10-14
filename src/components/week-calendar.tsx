import { DAYS, formatMinutes, parseTime } from "@/lib/time";

/**
 * Haftalık takvim önizlemesi (Pazartesi–Pazar, 06:00–22:00, 15 dk satırlar).
 * CSP uyumu: konumlar inline style ile DEĞİL, sınıflarla verilir (row-start-*, row-span-*, col-start-* —
 * globals.css'te @source inline ile üretilir).
 */
const START = 6 * 60;
const END = 22 * 60;
const SLOT = 15;
const ROWS = (END - START) / SLOT; // 64

const PALETTE = [
  "bg-brand-50 border-brand-500 text-brand-900 dark:bg-brand-900 dark:text-brand-50",
  "bg-sky-50 border-sky-500 text-sky-900 dark:bg-sky-950 dark:text-sky-100",
  "bg-violet-50 border-violet-500 text-violet-900 dark:bg-violet-950 dark:text-violet-100",
  "bg-amber-50 border-amber-500 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  "bg-rose-50 border-rose-500 text-rose-900 dark:bg-rose-950 dark:text-rose-100",
];

export type CalendarBlock = {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  branchId: string;
  branchName: string;
  rooms: { name: string; startTime: string; endTime: string }[];
};

function rowFor(minutes: number) {
  const clamped = Math.min(Math.max(minutes, START), END);
  return 2 + (clamped - START) / SLOT;
}

export function WeekCalendar({ blocks, branchOrder }: { blocks: CalendarBlock[]; branchOrder: string[] }) {
  const colorOf = (branchId: string) => PALETTE[Math.max(0, branchOrder.indexOf(branchId)) % PALETTE.length];
  const hours = Array.from({ length: (END - START) / 60 + 1 }, (_, i) => START + i * 60);

  return (
    <div className="overflow-x-auto">
      <div
        role="grid"
        aria-label="Haftalık çalışma planı"
        className="grid min-w-[720px] grid-cols-[56px_repeat(7,minmax(0,1fr))] grid-rows-[auto_repeat(64,minmax(0.6rem,1fr))] rounded-xl border border-slate-200 dark:border-slate-800"
      >
        <div className="col-start-1 row-start-1 border-b border-slate-200 dark:border-slate-800" />
        {DAYS.map((d) => (
          <div
            key={d.iso}
            role="columnheader"
            className={`col-start-${d.iso + 1} row-start-1 border-b border-l border-slate-200 px-2 py-2 text-center text-xs font-semibold dark:border-slate-800`}
          >
            <span className="hidden sm:inline">{d.long}</span>
            <span className="sm:hidden">{d.short}</span>
          </div>
        ))}
        {hours.slice(0, -1).map((h) => (
          <div
            key={h}
            className={`col-start-1 row-start-${rowFor(h)} row-span-4 border-t border-slate-100 pr-2 text-right text-[10px] text-slate-400 dark:border-slate-800`}
          >
            {formatMinutes(h)}
          </div>
        ))}
        {DAYS.map((d) => (
          <div
            key={`bg-${d.iso}`}
            aria-hidden="true"
            className={`col-start-${d.iso + 1} row-start-2 row-span-${ROWS} border-l border-slate-200 dark:border-slate-800`}
          />
        ))}
        {blocks.map((b) => {
          const s = parseTime(b.startTime)!;
          const e = parseTime(b.endTime)!;
          const start = rowFor(s);
          const span = Math.max(1, rowFor(e) - start);
          return (
            <div
              key={b.id}
              role="gridcell"
              className={`col-start-${b.dayOfWeek + 1} row-start-${start} row-span-${span} z-10 m-0.5 overflow-hidden rounded-lg border-l-4 px-2 py-1 text-xs ${colorOf(b.branchId)}`}
            >
              <p className="font-semibold">
                {b.startTime}–{b.endTime}
              </p>
              <p className="truncate">{b.branchName}</p>
              {b.rooms.map((r, i) => (
                <p key={i} className="truncate opacity-80">
                  {r.name} · {r.startTime}–{r.endTime}
                </p>
              ))}
            </div>
          );
        })}
      </div>
      <ul className="mt-3 flex flex-wrap gap-2 text-xs" aria-label="Şube renkleri">
        {branchOrder.map((id) => {
          const name = blocks.find((b) => b.branchId === id)?.branchName;
          return name ? (
            <li key={id} className={`badge border-l-4 ${colorOf(id)}`}>
              {name}
            </li>
          ) : null;
        })}
      </ul>
    </div>
  );
}
