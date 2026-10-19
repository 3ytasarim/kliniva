import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listOpenBalances } from "@/server/services/billing";
import { Forbidden } from "@/components/forbidden";
import { Avatar, EmptyState, PageHeader, SectionCard, StatCard } from "@/components/ui";
import { formatDateTime } from "@/components/patient-ui";
import { formatMoneyMap } from "@/lib/money";

export const metadata: Metadata = { title: "Açık bakiyeler" };

/** Tahsil edilmemiş hizmet bedeli olan hastalar (TRY borcuna göre). Satırdan hastanın hesabına gidilir. */
export default async function BalancesPage() {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "billing.read") || !hasPermission(ctx, "patient.read")) return <Forbidden />;
  const ob = await listOpenBalances(ctx, { limit: 200 });
  return (
    <section className="grid gap-6">
      <PageHeader
        eyebrow="Finans"
        title="Açık bakiyeler"
        description="Hizmet bedeli tahsil edilmemiş hastalar. Tahsilat hastanın Hesap sekmesinden alınır."
        actions={
          hasPermission(ctx, "cash.read") ? (
            <Link href="/finance/cash" className="btn-ghost btn-sm">
              Kasaya git
            </Link>
          ) : null
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Toplam açık bakiye"
          value={formatMoneyMap(ob.total)}
          icon="cash"
          tone="red"
          testId="balances-total"
        />
        <StatCard label="Borçlu hasta" value={ob.patients} icon="patients" tone="amber" />
      </div>
      <SectionCard title="Borçlu hastalar" flush>
        {ob.rows.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyState title="Açık bakiye yok" icon="wallet">
              Tüm hizmet bedelleri tahsil edilmiş.
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Hasta</th>
                  <th>Telefon</th>
                  <th>Son işlem</th>
                  <th className="text-right">Bakiye</th>
                </tr>
              </thead>
              <tbody>
                {ob.rows.map((r) => (
                  <tr key={r.patientId} data-testid="balance-row">
                    <td>
                      <Link
                        href={`/patients/${r.patientId}?tab=account`}
                        className="flex items-center gap-3 font-medium hover:text-brand-700"
                      >
                        <Avatar name={r.patientName} size="sm" />
                        <span>
                          {r.patientName}
                          <span className="block font-mono text-xs font-normal text-slate-500">
                            {r.patientNumber}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">{r.phoneMasked}</td>
                    <td className="whitespace-nowrap">
                      {r.lastActivityAt ? formatDateTime(r.lastActivityAt) : "—"}
                    </td>
                    <td className="whitespace-nowrap text-right font-semibold tabular-nums text-red-700 dark:text-red-400">
                      {formatMoneyMap(r.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </section>
  );
}
