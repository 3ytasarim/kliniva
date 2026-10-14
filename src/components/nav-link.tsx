"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui";

const base =
  "flex min-h-11 items-center gap-3 whitespace-nowrap rounded-lg px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600";

export function NavLink({ href, label, icon }: { href: string; label: string; icon: IconName }) {
  const pathname = usePathname();
  const active = pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`${base} ${
        active
          ? "bg-brand-50 font-semibold text-brand-700 dark:bg-brand-900 dark:text-brand-100"
          : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      <Icon name={icon} className="size-5 shrink-0 opacity-80" />
      {label}
    </Link>
  );
}

/** Geliştirilmemiş özellik: tıklanamaz, "Yakında" etiketi ile (bağlantı değildir). */
export function NavSoon({ label, icon }: { label: string; icon: IconName }) {
  return (
    <span aria-disabled="true" className={`${base} cursor-not-allowed text-slate-400 dark:text-slate-600`}>
      <Icon name={icon} className="size-5 shrink-0 opacity-60" />
      {label}
      <span className="badge badge-gray ml-auto">Yakında</span>
    </span>
  );
}
