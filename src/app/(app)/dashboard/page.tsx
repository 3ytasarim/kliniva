import type { Metadata } from "next";
import { requireTenant } from "@/server/auth/guards";

export const metadata: Metadata = { title: "Panel" };

export default async function DashboardPage() {
  const { ctx, tenant } = await requireTenant();
  return (
    <section>
      <h1 className="text-3xl font-bold tracking-tight">Kliniva AI</h1>
      <p className="mt-1 text-slate-600 dark:text-slate-400">Kliniva AI Projesi</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
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
