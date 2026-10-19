"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Filter, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";

type Option = { value: string; label: string };
type Params = { view: "day" | "week"; date: string; branch?: string; doctor?: string; status?: string };

/** "2026-10-16" → yerel takvim günü (UTC öğlen: saat dilimi kayması yok). */
const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);
const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (iso: string, n: number) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("tr-TR", { timeZone: "UTC", ...opts }).format(toDate(iso));

/**
 * Randevu takvimi araç çubuğu: görünüm (Gün / Hafta), Bugün / önceki / sonraki, tarih seçici (mini takvim),
 * doktor / durum / şube filtreleri (açılır menü) ve etkin filtre etiketleri. Durum URL'dedir (paylaşılabilir,
 * sunucu bileşeni yeniden render eder); veri kapsamı sunucuda uygulanır.
 */
export function AppointmentsToolbar({
  params,
  today,
  weekStart,
  doctors,
  branches,
  statuses,
  basePath = "/appointments",
}: {
  params: Params;
  today: string;
  weekStart: string;
  doctors: Option[];
  branches: Option[];
  statuses: Option[];
  /** Takvimin bulunduğu sayfa (Randevular veya doktorun Planım sayfası). */
  basePath?: string;
}) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const href = (patch: Partial<Params>) => {
    const merged: Record<string, string | undefined> = { ...params, ...patch };
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    return `${basePath}?${u.toString()}`;
  };
  const step = params.view === "week" ? 7 : 1;
  const label =
    params.view === "week"
      ? `${fmt(weekStart, { day: "numeric", month: "short" })} – ${fmt(addDays(weekStart, 6), { day: "numeric", month: "short", year: "numeric" })}`
      : fmt(params.date, { day: "numeric", month: "long", year: "numeric", weekday: "long" });

  const filters: { key: "doctor" | "status" | "branch"; title: string; all: string; options: Option[] }[] = [
    { key: "doctor", title: "Doktor", all: "Tüm doktorlar", options: doctors },
    { key: "status", title: "Durum", all: "Tüm durumlar", options: statuses },
    { key: "branch", title: "Şube", all: "Tüm şubeler", options: branches },
  ];
  const active = filters
    .map((f) => ({ ...f, value: params[f.key], current: f.options.find((o) => o.value === params[f.key]) }))
    .filter((f) => f.current);

  return (
    <div className="mb-4 grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Görünüm"
          className="inline-flex h-10 items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-white/5"
        >
          {(["day", "week"] as const).map((v) => (
            <Link
              key={v}
              href={href({ view: v })}
              aria-current={params.view === v ? "page" : undefined}
              className={cn(
                "inline-flex h-9 items-center rounded-md px-4 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus",
                params.view === v
                  ? "bg-white text-slate-900 shadow-[0_1px_2px_rgb(16_24_40/0.08)] dark:bg-raised-dark dark:text-white"
                  : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white",
              )}
            >
              {v === "day" ? "Gün" : "Hafta"}
            </Link>
          ))}
        </div>

        <div className="inline-flex items-center rounded-lg border border-line bg-white shadow-[0_1px_2px_rgb(16_24_40/0.05)] dark:border-line-dark dark:bg-surface-dark">
          <Link
            href={href({ date: addDays(params.date, -step) })}
            aria-label="Önceki"
            className="grid size-10 place-items-center rounded-l-lg text-slate-500 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:shadow-focus dark:hover:bg-raised-dark dark:hover:text-white"
          >
            <ChevronLeft className="size-4" />
          </Link>
          <Link
            href={href({ date: today })}
            className="inline-flex h-10 items-center border-x border-line px-3.5 text-[13px] font-medium hover:bg-slate-50 focus-visible:outline-none focus-visible:shadow-focus dark:border-line-dark dark:hover:bg-raised-dark"
          >
            Bugün
          </Link>
          <Link
            href={href({ date: addDays(params.date, step) })}
            aria-label="Sonraki"
            className="grid size-10 place-items-center rounded-r-lg text-slate-500 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:shadow-focus dark:hover:bg-raised-dark dark:hover:text-white"
          >
            <ChevronRight className="size-4" />
          </Link>
        </div>

        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-10 min-h-10 capitalize" aria-label={`Tarih seç: ${label}`}>
              <CalendarDays className="text-slate-400" />
              {label}
              <ChevronDown className="text-slate-400" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto">
            <Calendar
              mode="single"
              selected={toDate(params.date)}
              defaultMonth={toDate(params.date)}
              onSelect={(d) => {
                if (!d) return;
                setPickerOpen(false);
                router.push(href({ date: toIso(d) }));
              }}
            />
            <div className="mt-2 flex justify-end border-t border-line pt-2 dark:border-line-dark">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPickerOpen(false);
                  router.push(href({ date: today }));
                }}
              >
                Bugüne git
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {filters
            .filter((f) => f.options.length > (f.key === "branch" ? 1 : 0))
            .map((f) => (
              <DropdownMenu key={f.key}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "h-10 min-h-10",
                      params[f.key] && "border-brand-300 bg-brand-50/60 text-brand-800 dark:border-brand-700",
                    )}
                  >
                    <Filter className="text-slate-400" />
                    {f.title}
                    <ChevronDown className="text-slate-400" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-80 overflow-y-auto">
                  <DropdownMenuLabel>{f.title} filtresi</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => router.push(href({ [f.key]: undefined }))}>
                    {!params[f.key] ? <Check className="!text-brand-600" /> : <span className="size-4" />}
                    {f.all}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {f.options.map((o) => (
                    <DropdownMenuItem key={o.value} onSelect={() => router.push(href({ [f.key]: o.value }))}>
                      {params[f.key] === o.value ? (
                        <Check className="!text-brand-600" />
                      ) : (
                        <span className="size-4" />
                      )}
                      {o.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
        </div>
      </div>

      {active.length ? (
        <div className="flex flex-wrap items-center gap-2" aria-label="Etkin filtreler">
          {active.map((f) => (
            <Link
              key={f.key}
              href={href({ [f.key]: undefined })}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 pl-3 pr-2 text-xs font-medium text-brand-800 transition-colors hover:bg-brand-100 focus-visible:outline-none focus-visible:shadow-focus dark:border-brand-800 dark:bg-brand-500/10 dark:text-brand-200"
              aria-label={`${f.title} filtresini kaldır: ${f.current!.label}`}
            >
              {f.title}: {f.current!.label}
              <X className="size-3.5" />
            </Link>
          ))}
          <Link
            href={href({ doctor: undefined, status: undefined, branch: undefined })}
            className={cn(buttonVariants({ variant: "link", size: "sm" }), "min-h-7 text-xs")}
          >
            Tümünü temizle
          </Link>
        </div>
      ) : null}
    </div>
  );
}
