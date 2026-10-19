import Link from "next/link";
import {
  Bell,
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardList,
  Clock3,
  DoorOpen,
  FileText,
  LayoutDashboard,
  LogOut,
  MessageSquareText,
  Mic,
  Package,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  TriangleAlert,
  Sun,
  MoonStar,
  Wallet,
  Banknote,
  ReceiptText,
  TrendingUp,
  TrendingDown,
  UserPlus,
  UserRound,
  Users,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";

/** Küçük, bağımlılıksız UI yapı taşları (sunucu bileşeni olarak da kullanılabilir). */

export function PageHeader({
  title,
  description,
  actions,
  back,
  eyebrow,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  eyebrow?: string;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back ? (
          <Link
            href={back.href}
            className="mb-3 inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-slate-500 transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:shadow-focus dark:text-slate-400 dark:hover:text-brand-300"
          >
            <span aria-hidden="true">←</span> {back.label}
          </Link>
        ) : null}
        {eyebrow ? <p className="eyebrow mb-1.5">{eyebrow}</p> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px] dark:text-white">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
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

export function EmptyState({
  title,
  children,
  icon = "search",
}: {
  title: string;
  children?: React.ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-slate-300 bg-white/50 px-6 py-10 text-center dark:border-line-dark dark:bg-white/[0.01]">
      <span className="mb-3 grid size-10 place-items-center rounded-full bg-slate-100 text-slate-400 dark:bg-white/5 dark:text-slate-500">
        <Icon name={icon} className="size-5" />
      </span>
      <p className="font-medium text-slate-900 dark:text-slate-100">{title}</p>
      {children ? (
        <div className="mt-1.5 max-w-md text-sm text-slate-500 dark:text-slate-400">{children}</div>
      ) : null}
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
        <span className="transition-transform duration-200 group-open:rotate-45" aria-hidden="true">
          +
        </span>
        {summary}
      </summary>
      <div className="card animate-enter mt-3">{children}</div>
    </details>
  );
}

export type Tone = "brand" | "amber" | "sky" | "green" | "red" | "slate" | "violet";

const TONE: Record<Tone, string> = {
  brand: "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300",
  amber: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  sky: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
  green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  red: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300",
  slate: "bg-slate-100 text-slate-600 dark:bg-white/5 dark:text-slate-300",
  violet: "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300",
};

/** KPI kartı — etiket, değer, açıklama, renkli simge. href verilirse tıklanabilir (filtreli listeye gider). */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "slate",
  href,
  testId,
}: {
  label: string;
  value: number | string;
  hint?: string;
  icon: IconName;
  tone?: Tone;
  href?: string;
  testId?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="eyebrow">{label}</p>
        <span className={`stat-icon ${TONE[tone]}`}>
          <Icon name={icon} className="size-[18px]" />
        </span>
      </div>
      <p className="stat-value mt-3" data-testid={testId}>
        {value}
      </p>
      {hint ? <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </>
  );
  return href ? (
    <Link href={href} className="card card-link block">
      {body}
    </Link>
  ) : (
    <div className="card">{body}</div>
  );
}

/** Baş harfli avatar (fotoğraf yok — KVKK: personel görseli tutulmaz). */
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials =
    name
      .replace(/^Dr.?s+/i, "")
      .split(/s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toLocaleUpperCase("tr-TR"))
      .join("") || "?";
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 font-semibold text-white ring-2 ring-white dark:ring-surface-dark ${size === "sm" ? "size-8 text-xs" : size === "lg" ? "size-14 text-lg" : "size-9 text-[13px]"}`}
    >
      {initials}
    </span>
  );
}

/** Başlıklı kart bölümü (başlık + isteğe bağlı sağ eylem + içerik). */
export function SectionCard({
  title,
  description,
  action,
  children,
  flush,
  className = "",
  id,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`card min-w-0 p-0 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0">
          <h2 className="card-title">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className={flush ? "" : "px-5 pb-5"}>{children}</div>
    </section>
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

/** Simge eşlemesi — lucide (tutarlı 1.75 çizgi kalınlığı; aria-hidden: anlam her zaman yanındaki metinde). */
const ICONS: Record<IconName, LucideIcon> = {
  dashboard: LayoutDashboard,
  patients: Users,
  calendar: CalendarDays,
  doctor: UserRound,
  branch: Building2,
  room: DoorOpen,
  inventory: Package,
  reports: FileText,
  settings: Settings,
  users: UsersRound,
  shield: ShieldCheck,
  logout: LogOut,
  bell: Bell,
  operations: ClipboardList,
  exam: Stethoscope,
  plus: Plus,
  clock: Clock3,
  search: Search,
  chevronRight: ChevronRight,
  check: Check,
  userPlus: UserPlus,
  sparkle: Sparkles,
  chat: MessageSquareText,
  mic: Mic,
  send: SendHorizontal,
  close: X,
  alert: TriangleAlert,
  sun: Sun,
  moon: MoonStar,
  wallet: Wallet,
  cash: Banknote,
  receipt: ReceiptText,
  trendUp: TrendingUp,
  trendDown: TrendingDown,
};

export function Icon({ name, className = "size-5" }: { name: IconName; className?: string }) {
  const C = ICONS[name];
  return <C aria-hidden="true" strokeWidth={1.75} className={className} />;
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
  | "operations"
  | "exam"
  | "plus"
  | "wallet"
  | "cash"
  | "receipt"
  | "trendUp"
  | "trendDown"
  | "sun"
  | "moon"
  | "clock"
  | "search"
  | "chevronRight"
  | "check"
  | "userPlus"
  | "sparkle"
  | "chat"
  | "mic"
  | "send"
  | "close"
  | "alert";
