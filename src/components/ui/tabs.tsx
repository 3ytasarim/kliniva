"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Sekmeler — bağımlılıksız, CSP uyumlu (satır içi stil YAZILMAZ). Radix Tabs içeriği ilk render'da
 * style="animation-duration:0s" ürettiği için nonce'lu CSP'yi ihlal ediyordu; bu uygulama aynı API'yi sağlar.
 * Erişilebilirlik: role=tablist / tab / tabpanel, aria-selected, aria-controls / aria-labelledby, ← → Home End.
 * Paneller her zaman bağlı kalır (etkin olmayan `hidden`) → sekme değişince durum (ör. sesli oturum) kaybolmaz.
 */
type Ctx = { value: string; setValue: (v: string) => void; baseId: string };
const TabsCtx = React.createContext<Ctx | null>(null);
const useTabs = () => {
  const c = React.useContext(TabsCtx);
  if (!c) throw new Error("Tabs bileşeni dışında kullanıldı");
  return c;
};
const slug = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, "-");

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  className,
  children,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const [inner, setInner] = React.useState(defaultValue ?? "");
  const baseId = React.useId();
  const current = value ?? inner;
  const setValue = React.useCallback(
    (v: string) => {
      if (value === undefined) setInner(v);
      onValueChange?.(v);
    },
    [onValueChange, value],
  );
  return (
    <TabsCtx.Provider value={{ value: current, setValue, baseId }}>
      <div className={className}>{children}</div>
    </TabsCtx.Provider>
  );
}

export function TabsList({ className, children, ...props }: React.ComponentProps<"div">) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next =
      e.key === "ArrowRight"
        ? tabs[(i + 1) % tabs.length]
        : e.key === "ArrowLeft"
          ? tabs[(i - 1 + tabs.length) % tabs.length]
          : e.key === "Home"
            ? tabs[0]
            : e.key === "End"
              ? tabs[tabs.length - 1]
              : null;
    if (next) {
      e.preventDefault();
      next.focus();
      next.click();
    }
  };
  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex h-9 items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 text-slate-500 dark:bg-white/5 dark:text-slate-400",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"button">, "value"> & { value: string }) {
  const t = useTabs();
  const active = t.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${t.baseId}-tab-${slug(value)}`}
      aria-selected={active}
      aria-controls={`${t.baseId}-panel-${slug(value)}`}
      tabIndex={active ? 0 : -1}
      data-state={active ? "active" : "inactive"}
      onClick={() => t.setValue(value)}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-[color,background-color,box-shadow] duration-150 hover:text-slate-900 focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-white data-[state=active]:text-slate-900 data-[state=active]:shadow-[0_1px_2px_rgb(16_24_40/0.08)] dark:hover:text-white dark:data-[state=active]:bg-raised-dark dark:data-[state=active]:text-white [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "value"> & { value: string }) {
  const t = useTabs();
  const active = t.value === value;
  return (
    <div
      role="tabpanel"
      id={`${t.baseId}-panel-${slug(value)}`}
      aria-labelledby={`${t.baseId}-tab-${slug(value)}`}
      hidden={!active}
      data-state={active ? "active" : "inactive"}
      tabIndex={0}
      className={cn("focus-visible:outline-none", className)}
      {...props}
    >
      {children}
    </div>
  );
}
