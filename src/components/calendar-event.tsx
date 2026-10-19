"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Clock3, DoorOpen, Stethoscope, UserRound } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar } from "@/components/ui";
import { QuickActionButtons } from "@/components/appointment-quick-actions";
import type { QuickAction } from "@/components/appointment-ui";
import { cn } from "@/lib/cn";

/**
 * Takvim etkinlik kartı — tıklayınca ayrıntı + hızlı işlemler (Hasta geldi / Muayeneyi başlat / Tamamla / Gelmedi)
 * ve "Detayı aç". İşlem sonrası sayfa sunucudan yenilenir (sayılar ve takvim güncellenir).
 */
export function CalendarEvent({
  id,
  patient,
  timeLabel,
  service,
  room,
  doctor,
  showDoctor,
  statusLabel,
  statusBadge,
  toneClass,
  dotClass,
  actions,
}: {
  id: string;
  patient: string;
  timeLabel: string;
  service: string | null;
  room: string | null;
  doctor: string;
  showDoctor: boolean;
  statusLabel: string;
  statusBadge: string;
  toneClass: string;
  dotClass: string;
  actions: QuickAction[];
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const router = useRouter();
  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setDone(null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group min-w-0 flex-1 overflow-hidden rounded-md border-l-[3px] px-2 py-1.5 text-left text-xs leading-tight shadow-[0_1px_2px_rgb(16_24_40/0.06)] transition-[box-shadow,transform] duration-150 hover:-translate-y-px hover:shadow-raised focus-visible:outline-none focus-visible:shadow-focus data-[state=open]:shadow-raised data-[state=open]:ring-2 data-[state=open]:ring-brand-500/40",
            toneClass,
          )}
        >
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
            <span className="truncate font-semibold">{patient}</span>
          </span>
          <span className="mt-0.5 block truncate tabular-nums opacity-75">
            {timeLabel}
            {service ? ` · ${service}` : ""}
          </span>
          {showDoctor ? <span className="block truncate opacity-75">{doctor}</span> : null}
          {room ? <span className="block truncate opacity-60">{room}</span> : null}
          <span className="sr-only">Durum: {statusLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start" side="right">
        <div className="flex items-start gap-3 border-b border-line p-4 dark:border-line-dark">
          <Avatar name={patient} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{patient}</p>
            <span className={`badge mt-1 ${statusBadge}`}>{statusLabel}</span>
          </div>
        </div>
        <dl className="grid gap-2 p-4 text-sm">
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
            <Clock3 className="size-4 text-slate-400" aria-hidden="true" />
            <dt className="sr-only">Saat</dt>
            <dd className="tabular-nums">{timeLabel}</dd>
          </div>
          {service ? (
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <Stethoscope className="size-4 text-slate-400" aria-hidden="true" />
              <dt className="sr-only">Hizmet</dt>
              <dd>{service}</dd>
            </div>
          ) : null}
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
            <UserRound className="size-4 text-slate-400" aria-hidden="true" />
            <dt className="sr-only">Doktor</dt>
            <dd>{doctor}</dd>
          </div>
          {room ? (
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <DoorOpen className="size-4 text-slate-400" aria-hidden="true" />
              <dt className="sr-only">Oda</dt>
              <dd>{room}</dd>
            </div>
          ) : null}
        </dl>
        {done ? (
          <p
            role="status"
            className="mx-4 mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"
          >
            {done}
          </p>
        ) : (
          <QuickActionButtons
            id={id}
            actions={actions}
            className="px-4 pb-3"
            onDone={(m) => {
              setDone(m || "İşlem tamamlandı.");
              router.refresh();
            }}
          />
        )}
        <div className="flex justify-end border-t border-line px-4 py-2.5 dark:border-line-dark">
          <Link
            href={`/appointments/${id}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            Detayı aç
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
