import Link from "next/link";

/** Küçük, bağımlılıksız UI yapı taşları (sunucu bileşeni olarak da kullanılabilir). */

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back ? (
          <Link href={back.href} className="mb-2 inline-flex text-sm text-slate-500 hover:text-brand-700">
            ← {back.label}
          </Link>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function StatusBadge({
  active,
  on = "Aktif",
  off = "Pasif",
}: {
  active: boolean;
  on?: string;
  off?: string;
}) {
  return <span className={`badge ${active ? "badge-green" : "badge-gray"}`}>{active ? on : off}</span>;
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-2 text-sm text-slate-500">{children}</div> : null}
    </div>
  );
}

/** <details> tabanlı açılır panel — "Yeni …" formları için (drawer/modal yerine, JS gerektirmez). */
export function Panel({
  summary,
  children,
  open,
  variant = "primary",
}: {
  summary: string;
  children: React.ReactNode;
  open?: boolean;
  variant?: "primary" | "ghost";
}) {
  return (
    <details className="panel group" open={open}>
      <summary className={variant === "primary" ? "btn" : "btn-ghost btn-sm"}>
        <span className="transition-transform group-open:rotate-45" aria-hidden="true">
          +
        </span>
        {summary}
      </summary>
      <div className="card mt-3">{children}</div>
    </details>
  );
}

export const ROOM_TYPE_LABELS: Record<string, string> = {
  EXAMINATION: "Muayene",
  PROCEDURE: "İşlem",
  TREATMENT: "Tedavi",
  LASER: "Lazer",
  CONSULTATION: "Konsültasyon",
  SURGERY: "Cerrahi",
  OTHER: "Diğer",
};

export function Icon({ name, className = "size-5" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    dashboard: <path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z" />,
    patients: (
      <path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.7 0-6 1.3-6 3.5V19h12v-2.5C14 14.3 10.7 13 8 13Zm8 0c-.4 0-.8 0-1.2.1 1.3.9 2.2 2 2.2 3.4V19h5v-2.5c0-2.2-3.3-3.5-6-3.5Z" />
    ),
    calendar: (
      <path d="M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7Zm12 7v10H5V9h14Z" />
    ),
    doctor: (
      <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9v-1c0-3.3 2.7-6 6-6h2c3.3 0 6 2.7 6 6v1H5Zm11-5v2h-2v2h2v2h2v-2h2v-2h-2v-2h-2Z" />
    ),
    branch: <path d="M3 21V8l9-5 9 5v13h-6v-7H9v7H3Z" />,
    room: <path d="M4 21V3h11v2h5v16h-2V7h-3v14H4Zm7-8h2v-2h-2v2Z" />,
    inventory: (
      <path d="M20 7 12 3 4 7v10l8 4 8-4V7Zm-8 11.8L6 16V9.2l6 3v6.6Zm1-8.4L7.1 7.5 12 5.2l4.9 2.3L13 10.4Zm5 5.6-4 2v-6.6l4-2V16Z" />
    ),
    reports: <path d="M4 20V10h3v10H4Zm6 0V4h3v16h-3Zm6 0v-7h3v7h-3Z" />,
    settings: (
      <path d="m19.4 13 .1-1-.1-1 2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.9c-.6.2-1.2.6-1.7 1l-2.5-1-2 3.5L6.5 11l-.1 1 .1 1-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.8 1.7 1L11 21h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.5-2.2-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
    ),
    users: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-8 2-8 5v2h16v-2c0-3-4-5-8-5Z" />,
    shield: <path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Z" />,
    logout: <path d="M10 17v-3H3v-4h7V7l5 5-5 5Zm9 4h-6v-2h6V5h-6V3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2Z" />,
    bell: (
      <path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" />
    ),
    operations: (
      <path d="M9 2h6a1 1 0 0 1 1 1v1h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3V3a1 1 0 0 1 1-1Zm1 2v2h4V4h-4Zm-3 7v2h2v-2H7Zm4 0v2h6v-2h-6Zm-4 5v2h2v-2H7Zm4 0v2h6v-2h-6Z" />
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      {paths[name]}
    </svg>
  );
}

export type IconName =
  | "dashboard"
  | "patients"
  | "calendar"
  | "doctor"
  | "branch"
  | "room"
  | "inventory"
  | "reports"
  | "settings"
  | "users"
  | "shield"
  | "logout"
  | "bell"
  | "operations";
