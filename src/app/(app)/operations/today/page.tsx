import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { getTodayAppointments, type AppointmentListItem } from "@/server/services/appointments";
import { accessibleBranchOptions } from "@/server/services/org";
import { appointmentStatusAction, cancelAppointmentAction } from "@/app/actions/appointments";
import { ActionForm, InlineAction } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui";
import { AppointmentStatusBadge, formatLocalDate } from "@/components/appointment-ui";
import { LiveRefresh } from "@/components/notification-bell";
import type { AppointmentStatus } from "@/types/appointments";

export const metadata: Metadata = { title: "Bugünkü operasyon" };

/**
 * Klinik operasyon ekranı — bugünün randevuları, randevu durum makinesine göre (ikinci bir durum sistemi YOK).
 * Kapsam: şube / doktorun kendi randevuları (servis görünürlük kuralı). Eylemler mevcut izinlerle:
 * resepsiyon → giriş (check-in) / gelmedi / iptal; doktor → başlat / tamamla. Sunucu her geçişi yeniden doğrular.
 * Gerçek zamanlı: bildirim sinyali (SSE) + periyodik yenileme.
 */
const GROUPS: { key: string; title: string; statuses: AppointmentStatus[] }[] = [
  { key: "expected", title: "Beklenen", statuses: ["PENDING_APPROVAL", "BOOKED", "CONFIRMED"] },
  { key: "arrived", title: "Geldi", statuses: ["CHECKED_IN"] },
  { key: "in-progress", title: "İşlemde", statuses: ["IN_PROGRESS"] },
  { key: "completed", title: "Tamamlandı", statuses: ["COMPLETED"] },
  { key: "no-show", title: "Gelmedi", statuses: ["NO_SHOW"] },
];

/** "Gelmedi" yalnızca randevu saati geldikten sonra (sunucu da ayrıca doğrular). */
const hasStarted = (iso: string) => new Date(iso).getTime() <= Date.now();

export default async function OperationsTodayPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "appointment.read") && !hasPermission(ctx, "appointment.read.own"))
    return <Forbidden />;
  const sp = await searchParams;
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const branchId = branches.some((b) => b.id === sp.branch) ? sp.branch : undefined;
  const { today, items } = await getTodayAppointments(ctx, { branchId });
  const can = {
    checkin: hasPermission(ctx, "appointment.checkin"),
    noShow: hasPermission(ctx, "appointment.no_show"),
    cancel: hasPermission(ctx, "appointment.cancel"),
    start: hasPermission(ctx, "appointment.start"),
    complete: hasPermission(ctx, "appointment.complete"),
  };
  const cancelledCount = items.filter((i) => i.status === "CANCELLED").length;

  const actionsFor = (a: AppointmentListItem) => {
    const out: React.ReactNode[] = [];
    if ((a.status === "BOOKED" || a.status === "CONFIRMED") && can.checkin) {
      out.push(
        <InlineAction
          key="ci"
          action={appointmentStatusAction}
          fields={{ id: a.id, status: "CHECKED_IN" }}
          label="Giriş yaptı"
          variant="primary"
        />,
      );
    }
    if ((a.status === "BOOKED" || a.status === "CONFIRMED") && can.noShow && hasStarted(a.start)) {
      out.push(
        <InlineAction
          key="ns"
          action={appointmentStatusAction}
          fields={{ id: a.id, status: "NO_SHOW" }}
          label="Gelmedi"
          variant="danger"
          confirm="Hasta 'gelmedi' olarak işaretlensin mi?"
        />,
      );
    }
    if (a.status === "CHECKED_IN" && can.start) {
      out.push(
        <InlineAction
          key="st"
          action={appointmentStatusAction}
          fields={{ id: a.id, status: "IN_PROGRESS" }}
          label="Başlat"
          variant="primary"
        />,
      );
    }
    if (a.status === "IN_PROGRESS" && can.complete) {
      out.push(
        <InlineAction
          key="co"
          action={appointmentStatusAction}
          fields={{ id: a.id, status: "COMPLETED" }}
          label="Tamamla"
          variant="primary"
        />,
      );
    }
    if (["PENDING_APPROVAL", "BOOKED", "CONFIRMED", "CHECKED_IN"].includes(a.status) && can.cancel) {
      out.push(
        <details key="cx" className="text-left">
          <summary className="cursor-pointer text-xs font-medium text-red-700 dark:text-red-400">
            İptal
          </summary>
          <ActionForm action={cancelAppointmentAction} submitLabel="İptal et" className="mt-2 grid gap-2">
            <input type="hidden" name="id" value={a.id} />
            <label htmlFor={`cx-${a.id}`} className="sr-only">
              İptal gerekçesi
            </label>
            <input id={`cx-${a.id}`} name="reason" maxLength={500} className="input" placeholder="Gerekçe" />
          </ActionForm>
        </details>,
      );
    }
    return out;
  };

  return (
    <section className="grid gap-6">
      <LiveRefresh intervalMs={20_000} />
      <PageHeader
        title="Bugünkü operasyon"
        description={`${formatLocalDate(today)} · ${items.length - cancelledCount} randevu${cancelledCount ? ` · ${cancelledCount} iptal` : ""}`}
      />
      {branches.length > 1 ? (
        <form className="card flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="op-branch" className="label">
              Şube
            </label>
            <select id="op-branch" name="branch" defaultValue={branchId ?? ""} className="input">
              <option value="">Tüm şubeler</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn-ghost">
            Filtrele
          </button>
        </form>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5" aria-label="Durum özeti">
        {GROUPS.map((g) => (
          <a key={g.key} href={`#${g.key}`} className="card hover:border-brand-300">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{g.title}</p>
            <p className="mt-2 text-3xl font-bold tabular-nums" data-testid={`ops-count-${g.key}`}>
              {items.filter((i) => g.statuses.includes(i.status)).length}
            </p>
          </a>
        ))}
      </div>

      {GROUPS.map((g) => {
        const rows = items.filter((i) => g.statuses.includes(i.status));
        return (
          <div key={g.key} id={g.key} className="card overflow-x-auto p-0" data-testid={`ops-group-${g.key}`}>
            <h2 className="px-5 pt-5 font-semibold">
              {g.title} <span className="text-sm font-normal text-slate-500">({rows.length})</span>
            </h2>
            {rows.length === 0 ? (
              <p className="px-5 pb-5 pt-2 text-sm text-slate-500">Kayıt yok.</p>
            ) : (
              <table className="table mt-3">
                <thead>
                  <tr>
                    <th scope="col">Saat</th>
                    <th scope="col">Hasta</th>
                    <th scope="col">Doktor</th>
                    <th scope="col">Oda</th>
                    <th scope="col">Hizmet</th>
                    <th scope="col">Durum</th>
                    <th scope="col">
                      <span className="sr-only">İşlem</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id} data-testid="ops-row">
                      <td className="whitespace-nowrap font-medium tabular-nums">
                        {a.localStart}–{a.localEnd}
                      </td>
                      <td>
                        <Link href={`/appointments/${a.id}`} className="hover:text-brand-700">
                          {a.patient.name}
                        </Link>
                      </td>
                      <td>{a.doctor.name}</td>
                      <td>{a.room?.name ?? "—"}</td>
                      <td>{a.service?.name ?? "—"}</td>
                      <td>
                        <AppointmentStatusBadge status={a.status} />
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <div className="inline-flex flex-wrap items-start justify-end gap-2">
                          {actionsFor(a)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </section>
  );
}
