import type { Metadata } from "next";
import Link from "next/link";
import { requireTenant } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { getAppointmentStats } from "@/server/services/appointments";
import { accessibleBranchOptions } from "@/server/services/org";
import { formatLocalDate } from "@/components/appointment-ui";

export const metadata: Metadata = { title: "Panel" };

/** Panel — bugünün randevu sayıları (şube filtresi; yalnızca yetkili şube verisi sayılır). */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const { ctx, tenant } = await requireTenant();
  const sp = await searchParams;
  const canAppointments =
    hasPermission(ctx, "appointment.read") || hasPermission(ctx, "appointment.read.own");
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const branchId = branches.some((b) => b.id === sp.branch) ? sp.branch : undefined;
  const stats = canAppointments ? await getAppointmentStats(ctx, { branchId }) : null;

  const cards = stats
    ? ([
        ["Bugünkü randevular", stats.total, "Planlanan + gerçekleşen (iptal hariç)", "BOOKED"],
        ["Bekleyen hastalar", stats.waiting, "Geldi, muayene bekliyor", "CHECKED_IN"],
        ["Şu an işlemde", stats.inProgress, "Muayene / işlem sürüyor", "IN_PROGRESS"],
        ["Tamamlanan", stats.completed, "Bugün tamamlandı", "COMPLETED"],
        ["İptal", stats.cancelled, "Bugün için iptal edilen", "CANCELLED"],
        ["Gelmedi", stats.noShow, "No-show", "NO_SHOW"],
      ] as const)
    : [];

  return (
    <section className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Kliniva AI</h1>
          <p className="mt-1 text-slate-600 dark:text-slate-400">
            {tenant.name}
            {stats ? ` · ${formatLocalDate(stats.date)}` : ""}
          </p>
        </div>
        {stats && branches.length > 1 ? (
          <form className="flex items-end gap-2">
            <div>
              <label htmlFor="d-branch" className="label">
                Şube
              </label>
              <select id="d-branch" name="branch" defaultValue={branchId ?? ""} className="input">
                <option value="">Tüm şubeler</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-ghost">
              Göster
            </button>
          </form>
        ) : null}
      </div>

      {stats ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map(([title, value, hint, status]) => (
            <Link
              key={title}
              href={`/appointments?date=${stats.date}${branchId ? `&branch=${branchId}` : ""}${status !== "BOOKED" ? `&status=${status}` : ""}`}
              className="card transition-colors hover:border-brand-500"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</p>
              <p className="mt-2 text-3xl font-bold tabular-nums">{value}</p>
              <p className="mt-1 text-xs text-slate-500">{hint}</p>
            </Link>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-500">Klinik</p>
          <p className="mt-1 font-semibold">{tenant.name}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-500">Kullanıcı</p>
          <p className="mt-1 font-semibold">
            {ctx.user.firstName} {ctx.user.lastName}
          </p>
          <p className="text-xs text-slate-500">{ctx.roles.join(", ") || "Rol atanmamış"}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wide text-slate-500">İki adımlı doğrulama</p>
          <p className="mt-1 font-semibold">{ctx.user.twoFactorEnabled ? "Etkin" : "Kapalı"}</p>
        </div>
      </div>
    </section>
  );
}
