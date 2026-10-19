"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui";

const base =
  "group relative flex min-h-10 items-center gap-3 whitespace-nowrap rounded-lg px-3 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-focus";

export function NavLink({ href, label, icon }: { href: string; label: string; icon: IconName }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`${base} ${
        active
          ? "app-nav-active bg-brand-50 font-semibold text-brand-800 md:before:absolute md:before:inset-y-2 md:before:-left-3 md:before:w-[3px] md:before:rounded-r-full md:before:bg-brand-600 md:before:content-[''] dark:bg-brand-500/10 dark:text-brand-200"
          : "font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/5 dark:hover:text-slate-100"
      }`}
    >
      <Icon
        name={icon}
        className={`size-[18px] shrink-0 ${active ? "text-brand-600 dark:text-brand-300" : "text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300"}`}
      />
      {label}
    </Link>
  );
}

/** Geliştirilmemiş özellik: tıklanamaz, "Yakında" etiketi ile (bağlantı değildir). */
export function NavSoon({ label, icon }: { label: string; icon: IconName }) {
  return (
    <span aria-disabled="true" className={`${base} cursor-not-allowed text-slate-400 dark:text-slate-600`}>
      <Icon name={icon} className="size-[18px] shrink-0 opacity-60" />
      {label}
      <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-white/5 dark:text-slate-500">
        Yakında
      </span>
    </span>
  );
}

/** Menü grubu başlığı (masaüstü). */
export function NavGroup({ title }: { title: string }) {
  return (
    <p className="mt-5 hidden px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400 md:block dark:text-slate-500">
      {title}
    </p>
  );
}
