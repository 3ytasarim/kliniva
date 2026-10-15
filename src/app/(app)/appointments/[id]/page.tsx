import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { clinicToday, getAppointment } from "@/server/services/appointments";
import {
  appointmentNotesAction,
  appointmentStatusAction,
  approveAppointmentAction,
  cancelAppointmentAction,
  declineAppointmentAction,
} from "@/app/actions/appointments";
import { ActionForm, InlineAction } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { PageHeader } from "@/components/ui";
import { AppointmentReschedule } from "@/components/appointment-reschedule";
import {
  ACTION_LABELS,
  AppointmentStatusBadge,
  EVENT_LABELS,
  formatLocalDate,
} from "@/components/appointment-ui";
import { formatDateTime } from "@/components/patient-ui";
import { listPatientMaterialUsage } from "@/server/services/material-usage";
import { createUsageAction } from "@/app/actions/inventory";
import { MaterialUsageList } from "@/components/material-usage-list";

export const metadata: Metadata = { title: "Randevu" };

export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "appointment.read") && !hasPermission(ctx, "appointment.read.own"))
    return <Forbidden />;
  const { id } = await params;
  let a: Awaited<ReturnType<typeof getAppointment>>;
  try {
    a = await getAppointment(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const today = await clinicToday(ctx);
  const statusActions = a.actions.filter((x) => x !== "CANCEL" && x !== "RESCHEDULE");
  const editable = ["BOOKED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"].includes(a.status);
  const canUsageRead = hasPermission(ctx, "inventory.usage.read");
  const usages = canUsageRead ? await listPatientMaterialUsage(ctx, { appointmentId: a.id }) : [];
  const canAddUsage =
    hasPermission(ctx, "inventory.usage.create") && (a.status === "IN_PROGRESS" || a.status === "COMPLETED");

  return (
    <section className="grid gap-6">
      <PageHeader
        title={`${a.patient.name} · ${a.localStart}`}
        description={`${formatLocalDate(a.localDate)} · ${a.doctor.name}`}
        back={{ href: `/appointments?date=${a.localDate}`, label: "Randevular" }}
        actions={<AppointmentStatusBadge status={a.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid content-start gap-6">
          <div className="card">
            <h2 className="mb-4 font-semibold">Randevu bilgileri</h2>
            <dl className="grid gap-4 sm:grid-cols-2">
              {[
                [
                  "Hasta",
                  <Link
                    key="p"
                    href={`/patients/${a.patient.id}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {a.patient.name}{" "}
                    <span className="font-mono text-xs text-slate-500">{a.patient.patientNumber}</span>
                  </Link>,
                ],
                ["Doktor", a.doctor.name],
                ["Şube", a.branch.name],
                ["Oda", a.room?.name ?? "Atanmadı"],
                ["Hizmet", a.service?.name ?? "—"],
                ["Tarih", formatLocalDate(a.localDate)],
                ["Başlangıç – bitiş", `${a.localStart} – ${a.localEnd}`],
                ["Süre", `${a.durationMinutes} dk`],
              ].map(([k, v]) => (
                <div key={String(k)}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt>
                  <dd className="mt-1">{v}</dd>
                </div>
              ))}
            </dl>
            {a.status === "CANCELLED" && a.cancellationReason ? (
              <p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800">
                <span className="font-medium">İptal gerekçesi:</span> {a.cancellationReason}
              </p>
            ) : null}
          </div>

          {a.actions.includes("RESCHEDULE") ? (
            <details className="card">
              <summary className="cursor-pointer font-semibold">Randevuyu taşı</summary>
              <div className="mt-4">
                <AppointmentReschedule
                  appointmentId={a.id}
                  branchId={a.branch.id}
                  doctorId={a.doctor.id}
                  serviceId={a.serviceId}
                  patientId={a.patient.id}
                  initialDate={a.localDate >= today ? a.localDate : today}
                  today={today}
                />
              </div>
            </details>
          ) : null}

          <div className="card">
            <h2 className="mb-1 font-semibold">Operasyon notu</h2>
            <p className="hint mb-3">
              Tıbbi kayıt değildir; şifreli saklanır ve denetim kaydına içerik yazılmaz.
            </p>
            {hasPermission(ctx, "appointment.update") && editable ? (
              <ActionForm action={appointmentNotesAction} submitLabel="Notu kaydet" className="grid gap-3">
                <input type="hidden" name="id" value={a.id} />
                <label htmlFor="ap-notes" className="sr-only">
                  Operasyon notu
                </label>
                <textarea
                  id="ap-notes"
                  name="notes"
                  rows={3}
                  maxLength={2000}
                  defaultValue={a.notes ?? ""}
                  className="input"
                />
              </ActionForm>
            ) : (
              <p className="whitespace-pre-line text-sm">{a.notes || "—"}</p>
            )}
          </div>

          {canUsageRead ? (
            <div className="card grid gap-3" id="malzemeler">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">Kullanılan malzemeler</h2>
                {canAddUsage ? (
                  <ActionForm
                    action={createUsageAction}
                    submitLabel="Malzeme kullanımı ekle"
                    className="flex"
                  >
                    <input type="hidden" name="patientId" value={a.patient.id} />
                    <input type="hidden" name="appointmentId" value={a.id} />
                  </ActionForm>
                ) : null}
              </div>
              {!canAddUsage && hasPermission(ctx, "inventory.usage.create") ? (
                <p className="hint">
                  Malzeme kullanımı randevu işlemdeyken veya tamamlandıktan sonra girilir.
                </p>
              ) : null}
              <MaterialUsageList rows={usages} showAppointment={false} />
            </div>
          ) : null}
        </div>

        <div className="grid content-start gap-6">
          <div className="card grid gap-3">
            <h2 className="font-semibold">İşlemler</h2>
            {a.canDecideApproval ? (
              <div className="grid gap-2 rounded-xl bg-amber-50 p-3 dark:bg-amber-950">
                <p className="text-sm">
                  Bu randevu onayınızı bekliyor. Onaylayana kadar slot sizin için tutulur.
                </p>
                <div className="flex flex-wrap gap-2">
                  <InlineAction
                    action={approveAppointmentAction}
                    fields={{ id: a.id }}
                    label="Onayla"
                    variant="primary"
                  />
                  <InlineAction
                    action={declineAppointmentAction}
                    fields={{ id: a.id }}
                    label="Reddet"
                    variant="danger"
                    confirm="Randevu reddedilsin mi? Slot yeniden müsait olacak."
                  />
                </div>
              </div>
            ) : a.status === "PENDING_APPROVAL" ? (
              <p className="text-sm text-amber-800 dark:text-amber-300">Doktor onayı bekleniyor.</p>
            ) : null}
            {statusActions.length === 0 && !a.actions.includes("CANCEL") && !a.canDecideApproval ? (
              <p className="text-sm text-slate-500">Bu randevu için yapılabilecek işlem yok.</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {statusActions.map((s) => (
                <InlineAction
                  key={s}
                  action={appointmentStatusAction}
                  fields={{ id: a.id, status: s }}
                  label={ACTION_LABELS[s] ?? s}
                  variant={s === "NO_SHOW" ? "danger" : "primary"}
                  confirm={s === "NO_SHOW" ? "Hasta 'gelmedi' olarak işaretlensin mi?" : undefined}
                />
              ))}
            </div>
            {a.actions.includes("CANCEL") ? (
              <details>
                <summary className="cursor-pointer text-sm font-medium text-red-700 dark:text-red-400">
                  Randevuyu iptal et
                </summary>
                <ActionForm
                  action={cancelAppointmentAction}
                  submitLabel="İptal et"
                  className="mt-3 grid gap-3"
                >
                  <input type="hidden" name="id" value={a.id} />
                  <div>
                    <label htmlFor="ap-reason" className="label">
                      İptal gerekçesi
                    </label>
                    <textarea
                      id="ap-reason"
                      name="reason"
                      rows={2}
                      maxLength={500}
                      required
                      className="input"
                    />
                    <p className="hint">Randevu silinmez; geçmişiyle birlikte korunur, slot boşalır.</p>
                  </div>
                </ActionForm>
              </details>
            ) : null}
          </div>

          <div className="card">
            <h2 className="mb-3 font-semibold">Geçmiş</h2>
            <ol className="grid gap-3">
              {a.history.map((h) => (
                <li key={h.id} className="border-l-2 border-brand-500 pl-3">
                  <p className="text-sm font-medium">{EVENT_LABELS[h.type] ?? h.type}</p>
                  {h.type === "RESCHEDULED" && typeof h.metadata.oldStart === "string" ? (
                    <p className="text-xs text-slate-500">
                      {formatDateTime(h.metadata.oldStart)} → {formatDateTime(String(h.metadata.newStart))}
                    </p>
                  ) : null}
                  <p className="text-xs text-slate-500">
                    {h.actorName ?? "Sistem"} · {formatDateTime(h.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
