"use client";

import * as React from "react";
import { DayPicker, type DayPickerProps } from "react-day-picker";
import { tr } from "react-day-picker/locale";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

/** Takvim (react-day-picker, Türkçe, hafta Pazartesi başlar). Yalnızca sınıflarla biçimlenir (satır içi stil yok). */
export function Calendar({ className, classNames, ...props }: DayPickerProps) {
  return (
    <DayPicker
      locale={tr}
      weekStartsOn={1}
      showOutsideDays
      className={cn("select-none", className)}
      classNames={{
        months: "relative flex flex-col",
        month: "grid gap-3",
        month_caption: "flex h-8 items-center px-1",
        caption_label: "text-sm font-semibold capitalize",
        nav: "absolute right-0 top-0 z-10 flex items-center gap-1",
        button_previous:
          "grid size-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40 dark:hover:bg-white/5",
        button_next:
          "grid size-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40 dark:hover:bg-white/5",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "w-9 pb-1 text-center text-[11px] font-medium uppercase text-slate-400",
        week: "mt-0.5 flex",
        day: "relative size-9 p-0 text-center text-sm",
        day_button:
          "grid size-9 place-items-center rounded-lg tabular-nums transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:shadow-focus dark:hover:bg-white/5",
        today:
          "font-semibold text-brand-700 dark:text-brand-300 [&>button]:ring-1 [&>button]:ring-inset [&>button]:ring-brand-300",
        selected:
          "[&>button]:bg-brand-600 [&>button]:font-semibold [&>button]:text-white [&>button]:ring-0 [&>button]:hover:bg-brand-700",
        outside: "text-slate-300 dark:text-slate-600",
        disabled: "opacity-40",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />,
      }}
      {...props}
    />
  );
}
