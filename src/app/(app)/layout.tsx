import { requireTenant } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { getClinicProfile } from "@/server/services/clinic";
import { SYSTEM_ROLES, type Permission } from "@/server/auth/permissions";
import { logoutAction } from "@/app/actions/auth";
import { NavGroup, NavLink, NavSoon } from "@/components/nav-link";
import { NotificationBell } from "@/components/notification-bell";
import { KlinivaAssistant } from "@/components/kliniva-assistant";
import { AppointmentReminders } from "@/components/appointment-reminders";
import { Avatar, Icon, type IconName } from "@/components/ui";

/**
 * Korumalı uygulama kabuğu. Oturum yoksa requireUser() /login'e yönlendirir.
 * Menüde öğe gizlemek yalnızca kullanım kolaylığıdır; her sayfa ve servis yetkiyi sunucuda ayrıca kontrol eder.
 * Yerleşim: masaüstünde sol kenar menü (gruplu) + üst çubuk; mobilde üst çubuk + yatay kaydırılan menü.
 * Bildirim zili TEK örnektir (tek SSE bağlantısı).
 */
type NavItem =
  | { href: string; label: string; icon: IconName; perm: Permission | Permission[] }
  | { soon: true; label: string; icon: IconName };

const GROUPS: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: "/dashboard", label: "Panel", icon: "dashboard", perm: "clinic.read" },
      { href: "/doctor", label: "Planım", icon: "calendar", perm: "doctor.self.read" },
      {
        href: "/operations/today",
        label: "Bugünkü muayeneler",
        icon: "exam",
        perm: ["appointment.read", "appointment.read.own"],
      },
      { href: "/notifications", label: "Bildirimler", icon: "bell", perm: "notification.read_own" },
    ],
  },
  {
    title: "Klinik",
    items: [
      { href: "/patients", label: "Hastalar", icon: "patients", perm: "patient.read" },
      { href: "/appointments", label: "Randevular", icon: "clock", perm: "appointment.read" },
      { href: "/tasks", label: "Görevler", icon: "check", perm: "task.read" },
      { href: "/admin/doctors", label: "Doktorlar", icon: "doctor", perm: "doctor.read" },
    ],
  },
  {
    title: "Finans",
    items: [
      { href: "/finance/cash", label: "Kasa", icon: "cash", perm: "cash.read" },
      { href: "/finance/balances", label: "Açık bakiyeler", icon: "wallet", perm: "billing.read" },
    ],
  },
  {
    title: "Kaynaklar",
    items: [
      // Yönetim menüsü: yalnızca yöneten roller (doktor / resepsiyon okuma iznini arka planda kullanır, menüde görmez).
      { href: "/admin/branches", label: "Şubeler", icon: "branch", perm: "branch.manage" },
      { href: "/admin/rooms", label: "Odalar", icon: "room", perm: "room.manage" },
      { href: "/inventory", label: "Stok", icon: "inventory", perm: "inventory.read" },
      { soon: true, label: "Raporlar", icon: "reports" },
    ],
  },
  {
    title: "Ayarlar",
    items: [
      { href: "/settings/clinic", label: "Klinik", icon: "settings", perm: "clinic.manage" },
      {
        href: "/settings/documents",
        label: "Belge şablonları",
        icon: "reports",
        perm: "document.template.manage",
      },
      { href: "/settings/services", label: "Hizmetler", icon: "exam", perm: "service.manage" },
      {
        href: "/settings/patient-definitions",
        label: "Hasta tanımları",
        icon: "patients",
        perm: "clinic.manage",
      },
      { href: "/settings/lab-panels", label: "Tahlil tipleri", icon: "exam", perm: "clinic.manage" },
      { href: "/admin/users", label: "Kullanıcılar", icon: "users", perm: "user.read" },
      {
        href: "/settings/system-events",
        label: "Sistem olayları",
        icon: "alert",
        perm: "notification.admin.read_failed_events",
      },
    ],
  },
];

function todayLabel(timezone: string) {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
    weekday: "long",
  }).format(new Date());
}

import { cookies } from "next/headers";
import { THEME_COOKIE, parseTheme, type Theme } from "@/lib/theme";
import { setThemeAction } from "@/app/actions/theme";

/** Tema anahtarı: açık ↔ koyu. Sunucu formu → çerez; JS gerekmez. */
function ThemeToggle({ theme }: { theme: Theme }) {
  const next = theme === "dark" ? "light" : "dark";
  const label = theme === "dark" ? "Açık temaya geç" : "Koyu temaya geç";
  return (
    <form action={setThemeAction}>
      <input type="hidden" name="theme" value={next} />
      <button type="submit" className="btn-icon" aria-label={label} title={label} data-testid="theme-toggle">
        <Icon name={theme === "dark" ? "sun" : "moon"} className="size-[18px]" />
      </button>
    </form>
  );
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { ctx, tenant } = await requireTenant();
  const profile = await getClinicProfile(ctx);
  const allowed = (perm: Permission | Permission[]) =>
    (Array.isArray(perm) ? perm : [perm]).some((p) => hasPermission(ctx, p));
  const visible = (items: NavItem[]) => items.filter((n) => "soon" in n || allowed(n.perm));
  const clinicName = profile.displayName || tenant.name;
  const fullName = `${ctx.user.firstName} ${ctx.user.lastName}`.trim();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const roleLabel = ctx.roles.map((r) => SYSTEM_ROLES[r]?.name ?? r).join(", ") || "Rol atanmamış";

  const logo = profile.hasLogo ? (
    // Logo yalnızca oturumdaki kiracının logosudur (uç nokta parametre almaz).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/api/v1/clinic/logo"
      alt=""
      className="size-9 rounded-lg bg-white object-contain ring-1 ring-line dark:ring-line-dark"
    />
  ) : (
    // Kliniva marka işareti (klinik kendi logosunu yüklemediyse). Koyu temada beyaz karo: işaretteki beyaz çizgi korunur.
    <span className="grid size-9 place-items-center rounded-lg bg-white ring-1 ring-line dark:ring-0">
      {/* eslint-disable-next-line @next/next/no-img-element -- statik marka görseli */}
      <img src="/brand/kliniva-mark.png" alt="" width={30} height={30} className="size-[30px]" />
    </span>
  );

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[256px_minmax(0,1fr)] md:grid-rows-[auto_1fr]">
      {/* Üst çubuk */}
      <header className="app-topbar sticky top-0 z-30 flex h-16 md:col-start-2 md:row-start-1 items-center gap-3 border-b border-line bg-white/80 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-white/70 md:px-8 dark:border-line-dark dark:bg-canvas-dark/80">
        <div className="flex items-center gap-3 md:hidden">
          {logo}
          <p className="truncate text-sm font-semibold">{clinicName}</p>
        </div>
        <div className="hidden min-w-0 md:block">
          <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{clinicName}</p>
          <p className="truncate text-xs capitalize text-slate-500 dark:text-slate-400">
            {todayLabel(profile.timezone)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle theme={theme} />
          {hasPermission(ctx, "notification.read_own") ? <NotificationBell /> : null}
          <span className="mx-1 hidden h-6 w-px bg-line md:block dark:bg-line-dark" aria-hidden="true" />
          <div className="hidden items-center gap-2.5 md:flex">
            <Avatar name={fullName} size="sm" />
            <div className="leading-tight">
              <p className="text-[13px] font-medium">{fullName}</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{roleLabel}</p>
            </div>
          </div>
          <form action={logoutAction} className="md:hidden">
            <button type="submit" className="btn-icon" aria-label="Çıkış yap">
              <Icon name="logout" className="size-[18px]" />
            </button>
          </form>
        </div>
      </header>
      {/* Kenar menü (masaüstü) / yatay menü (mobil) */}
      <div className="app-sidebar border-b border-line bg-white md:sticky md:top-0 md:col-start-1 md:row-span-2 md:row-start-1 md:flex md:h-dvh md:flex-col md:self-start md:border-b-0 md:border-r dark:border-line-dark dark:bg-surface-dark">
        <div className="hidden h-16 items-center gap-3 px-5 md:flex">
          {logo}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold tracking-tight">Kliniva AI</p>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{clinicName}</p>
          </div>
        </div>
        <nav
          aria-label="Ana menü"
          className="flex gap-1 overflow-x-auto px-3 py-2 md:flex-1 md:flex-col md:gap-0.5 md:overflow-y-auto md:[scrollbar-width:thin] md:px-3 md:pb-4 md:pt-2"
        >
          {GROUPS.map((g, gi) => {
            const items = visible(g.items);
            if (!items.length && gi !== GROUPS.length - 1) return null;
            return (
              <div key={g.title ?? "main"} className="contents">
                {g.title ? <NavGroup title={g.title} /> : null}
                {items.map((n) =>
                  "soon" in n ? (
                    <NavSoon key={n.label} label={n.label} icon={n.icon} />
                  ) : (
                    <NavLink key={n.href} href={n.href} label={n.label} icon={n.icon} />
                  ),
                )}
                {gi === GROUPS.length - 1 ? (
                  <NavLink href="/settings/security" label="Güvenlik" icon="shield" />
                ) : null}
              </div>
            );
          })}
        </nav>
        <div className="hidden border-t border-line p-3 md:block dark:border-line-dark">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <Avatar name={fullName} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{fullName}</p>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">{roleLabel}</p>
            </div>
            <form action={logoutAction}>
              <button
                type="submit"
                className="btn-icon hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                aria-label="Çıkış yap"
                title="Çıkış yap"
              >
                <Icon name="logout" className="size-[18px]" />
              </button>
            </form>
          </div>
        </div>
      </div>
      <main
        id="main"
        className="animate-enter w-full min-w-0 px-4 py-6 md:col-start-2 md:row-start-2 md:px-8 md:py-8 xl:px-10 2xl:px-12"
      >
        {children}
      </main>
      {/* Saati gelen randevu kartı: randevu okuyabilen VE durum değiştirebilen kullanıcılar (kapsam sunucuda). */}
      {allowed(["appointment.read", "appointment.read.own"]) &&
      allowed(["appointment.checkin", "appointment.start", "appointment.complete", "appointment.no_show"]) ? (
        <AppointmentReminders />
      ) : null}
      {hasPermission(ctx, "voice.use") && profile.voiceEnabled ? <KlinivaAssistant /> : null}
    </div>
  );
}
