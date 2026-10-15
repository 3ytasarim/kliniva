import Link from "next/link";
import { formatMinutes, parseTime } from "@/lib/time";
import { APPOINTMENT_STATUS } from "@/components/appointment-ui";
import type { AppointmentStatus } from "@/types/appointments";

/**
 * Randevu takvimi (gün: sütun = doktor, hafta: sütun = gün). 07:00–21:00, 15 dk satırlar.
 * CSP uyumu: konumlar inline style ile DEĞİL, sınıflarla (row-start-*, row-span-*, col-start-* — globals.css
 * @source inline). Aynı sütunda örtüşen randevular tek hücrede yan yana gösterilir.
 */
const START = 7 * 60;
const END = 21 * 60;
const SLOT = 15;

const GRID_COLS: Record<number, string> = {
  1: "grid-cols-[56px_repeat(1,minmax(180px,1fr))]",
  2: "grid-cols-[56px_repeat(2,minmax(160px,1fr))]",
  3: "grid-cols-[56px_repeat(3,minmax(150px,1fr))]",
  4: "grid-cols-[56px_repeat(4,minmax(140px,1fr))]",
  5: "grid-cols-[56px_repeat(5,minmax(130px,1fr))]",
  6: "grid-cols-[56px_repeat(6,minmax(120px,1fr))]",
  7: "grid-cols-[56px_repeat(7,minmax(112px,1fr))]",
};

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
};

export type CalendarColumn = { key: string; title: string; subtitle?: string; highlight?: boolean };

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
}: {
  columns: CalendarColumn[];
  items: CalendarItem[];
  label: string;
  showDoctor: boolean;
}) {
  const n = Math.min(Math.max(columns.length, 1), 7);
  const hours = Array.from({ length: (END - START) / 60 }, (_, i) => START + i * 60);
  const outside = items.filter(
    (i) => (parseTime(i.localStart) ?? 0) < START || (parseTime(i.localStart) ?? 0) >= END,
  );

  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div
          role="grid"
          aria-label={label}
          className={`grid ${GRID_COLS[n]} grid-rows-[auto_repeat(56,minmax(1.35rem,auto))]`}
        >
          <div className="col-start-1 row-start-1 border-b border-slate-200 dark:border-slate-800" />
          {columns.slice(0, 7).map((c, i) => (
            <div
              key={c.key}
              role="columnheader"
              className={`col-start-${i + 2} row-start-1 border-b border-l border-slate-200 px-2 py-2 text-center dark:border-slate-800 ${
                c.highlight ? "bg-brand-50 dark:bg-brand-900" : ""
              }`}
            >
              <p className="truncate text-xs font-semibold">{c.title}</p>
              {c.subtitle ? <p className="truncate text-[11px] text-slate-500">{c.subtitle}</p> : null}
            </div>
          ))}
          {hours.map((h) => (
            <div
              key={h}
              className={`col-start-1 row-start-${rowFor(h)} row-span-4 border-t border-slate-100 pr-2 pt-0.5 text-right text-[11px] text-slate-400 dark:border-slate-800`}
            >
              {formatMinutes(h)}
            </div>
          ))}
          {columns.slice(0, 7).map((c, i) => (
            <div
              key={`bg-${c.key}`}
              aria-hidden="true"
              className={`col-start-${i + 2} row-start-2 row-span-56 border-l border-slate-200 dark:border-slate-800`}
            />
          ))}
          {columns.slice(0, 7).flatMap((c, i) =>
            clusters(items.filter((it) => it.column === c.key)).map((cl) => {
              const start = rowFor(cl.start);
              const span = Math.max(2, Math.ceil(rowFor(cl.end) - start));
              return (
                <div
                  key={`${c.key}-${cl.items[0]!.id}`}
                  className={`col-start-${i + 2} row-start-${Math.floor(start)} row-span-${span} z-10 flex min-w-0 gap-1 p-0.5`}
                >
                  {cl.items.map((it) => (
                    <Link
                      key={it.id}
                      href={`/appointments/${it.id}`}
                      className={`min-w-0 flex-1 overflow-hidden rounded-lg border-l-4 px-2 py-1 text-xs leading-tight shadow-sm hover:ring-2 hover:ring-brand-500/40 focus-visible:outline-2 focus-visible:outline-brand-600 ${APPOINTMENT_STATUS[it.status].card}`}
                    >
                      <span className="block font-semibold tabular-nums">
                        {it.localStart}–{it.localEnd}
                      </span>
                      <span className="block truncate font-medium">{it.patient}</span>
                      {showDoctor ? (
                        <span className="block truncate text-slate-600 dark:text-slate-300">{it.doctor}</span>
                      ) : null}
                      <span className="block truncate text-slate-500 dark:text-slate-400">
                        {[it.service, it.room].filter(Boolean).join(" · ")}
                      </span>
                      <span className="sr-only">Durum: {APPOINTMENT_STATUS[it.status].label}</span>
                    </Link>
                  ))}
                </div>
              );
            }),
          )}
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
