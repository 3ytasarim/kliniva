import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { listFailedOutboxEvents } from "@/server/notifications/outbox";
import { retryOutboxEventAction } from "@/app/actions/notifications";
import { InlineAction } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/components/patient-ui";

export const metadata: Metadata = { title: "Sistem olayları" };

/**
 * Başarısız sistem olayları (outbox) — yalnızca klinik sahibi / yöneticisi (kiracı geneli). Ham yük, yığın izi,
 * sır GÖSTERİLMEZ: yalnızca tip, toplam, deneme sayısı, durum, zaman ve güvenli hata kodu.
 */
export default async function SystemEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "notification.admin.read_failed_events") || !ctx.branchScope.all)
    return <Forbidden />;
  const sp = await searchParams;
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const r = await listFailedOutboxEvents(ctx, { page });
  const pages = Math.max(Math.ceil(r.total / r.limit), 1);
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Sistem olayları"
        description="İşlenemeyen bildirim olayları (en fazla 5 deneme sonrası). İş kayıtları etkilenmez; yeniden deneme güvenlidir (idempotent)."
      />
      {r.items.length === 0 ? (
        <EmptyState title="Başarısız olay yok" />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Olay tipi</th>
                <th scope="col">Toplam</th>
                <th scope="col">Deneme</th>
                <th scope="col">Durum</th>
                <th scope="col">Oluşturma</th>
                <th scope="col">Son hata kodu</th>
                <th scope="col">
                  <span className="sr-only">İşlem</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((e) => (
                <tr key={e.id}>
                  <td className="font-mono text-xs">{e.eventType}</td>
                  <td className="text-xs">
                    {e.aggregateType} · <span className="font-mono">{e.aggregateId.slice(0, 8)}</span>
                  </td>
                  <td className="tabular-nums">{e.attemptCount}</td>
                  <td>
                    <span className="badge badge-red">{e.status}</span>
                  </td>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(e.createdAt)}</td>
                  <td className="font-mono text-xs">{e.lastErrorCode ?? "—"}</td>
                  <td className="text-right">
                    <InlineAction
                      action={retryOutboxEventAction}
                      fields={{ id: e.id }}
                      label="Yeniden dene"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <nav aria-label="Sayfalama" className="flex justify-between text-sm">
          <span className="text-slate-500">
            Sayfa {r.page} / {pages}
          </span>
          <div className="flex gap-2">
            {r.page > 1 ? (
              <Link href={`/settings/system-events?page=${r.page - 1}`} className="btn-ghost btn-sm">
                ← Önceki
              </Link>
            ) : null}
            {r.page < pages ? (
              <Link href={`/settings/system-events?page=${r.page + 1}`} className="btn-ghost btn-sm">
                Sonraki →
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </section>
  );
}
