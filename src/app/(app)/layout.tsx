import { requireTenant } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { getClinicProfile } from "@/server/services/clinic";
import { logoutAction } from "@/app/actions/auth";
import { NavLink, NavSoon } from "@/components/nav-link";
import { Icon, type IconName } from "@/components/ui";
import type { Permission } from "@/server/auth/permissions";

/**
 * Korumalı uygulama kabuğu. Oturum yoksa requireUser() /login'e yönlendirir.
 * Menüde öğe gizlemek yalnızca kullanım kolaylığıdır; her sayfa ve servis yetkiyi sunucuda ayrıca kontrol eder.
 */
type NavItem =
  | { href: string; label: string; icon: IconName; perm: Permission }
  | { soon: true; label: string; icon: IconName };

const MAIN: NavItem[] = [
  { href: "/dashboard", label: "Panel", icon: "dashboard", perm: "clinic.read" },
  { href: "/doctor", label: "Planım", icon: "calendar", perm: "doctor.self.read" },
  { href: "/patients", label: "Hastalar", icon: "patients", perm: "patient.read" },
  { href: "/appointments", label: "Randevular", icon: "calendar", perm: "appointment.read" },
  { href: "/admin/doctors", label: "Doktorlar", icon: "doctor", perm: "doctor.read" },
  { href: "/admin/branches", label: "Şubeler", icon: "branch", perm: "branch.read" },
  { href: "/admin/rooms", label: "Odalar", icon: "room", perm: "room.read" },
  { href: "/inventory", label: "Stok", icon: "inventory", perm: "inventory.read" },
  { soon: true, label: "Raporlar", icon: "reports" },
];

const SETTINGS: NavItem[] = [
  { href: "/settings/clinic", label: "Klinik", icon: "settings", perm: "clinic.manage" },
  {
    href: "/settings/documents",
    label: "Belge şablonları",
    icon: "reports",
    perm: "document.template.manage",
  },
  { href: "/settings/services", label: "Hizmetler", icon: "settings", perm: "service.manage" },
  { href: "/admin/users", label: "Kullanıcılar", icon: "users", perm: "user.read" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { ctx, tenant } = await requireTenant();
  const profile = await getClinicProfile(ctx);
  const visible = (items: NavItem[]) => items.filter((n) => "soon" in n || hasPermission(ctx, n.perm));

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[260px_minmax(0,1fr)]">
      <header className="border-b border-slate-200 bg-white md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:border-b-0 md:border-r dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-3 p-4">
          {profile.hasLogo ? (
            // Logo yalnızca oturumdaki kiracının logosudur (uç nokta parametre almaz).
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/api/v1/clinic/logo" alt="" className="size-10 rounded-lg object-contain" />
          ) : (
            <span className="grid size-10 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
              K
            </span>
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-brand-700 dark:text-brand-100">Kliniva AI</p>
            <p className="truncate text-xs text-slate-500">{profile.displayName || tenant.name}</p>
          </div>
        </div>
        <nav
          aria-label="Ana menü"
          className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:overflow-y-auto"
        >
          {visible(MAIN).map((n) =>
            "soon" in n ? (
              <NavSoon key={n.label} label={n.label} icon={n.icon} />
            ) : (
              <NavLink key={n.href} href={n.href} label={n.label} icon={n.icon} />
            ),
          )}
          <p className="mt-4 hidden px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400 md:block">
            Ayarlar
          </p>
          {visible(SETTINGS).map((n) =>
            "soon" in n ? null : <NavLink key={n.href} href={n.href} label={n.label} icon={n.icon} />,
          )}
          <NavLink href="/settings/security" label="Güvenlik" icon="shield" />
        </nav>
        <div className="hidden border-t border-slate-200 p-3 md:block dark:border-slate-800">
          <p className="truncate px-3 text-sm font-medium">
            {ctx.user.firstName} {ctx.user.lastName}
          </p>
          <p className="truncate px-3 text-xs text-slate-500">{ctx.user.email}</p>
          <form action={logoutAction} className="mt-2">
            <button
              type="submit"
              className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
            >
              <Icon name="logout" />
              Çıkış yap
            </button>
          </form>
        </div>
        <form action={logoutAction} className="px-3 pb-3 md:hidden">
          <button type="submit" className="btn-ghost btn-sm w-full">
            Çıkış yap
          </button>
        </form>
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl p-4 md:p-8">
        {children}
      </main>
    </div>
  );
}
