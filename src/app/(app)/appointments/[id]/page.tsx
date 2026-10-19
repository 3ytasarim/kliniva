import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CalendarDays,
  Check,
  Clock3,
  DoorOpen,
  FileLock2,
  History,
  MapPin,
  NotebookPen,
  PackageOpen,
  Stethoscope,
  UserRound,
  X,
} from "lucide-react";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { clinicToday, getAppointment } from "@/server/services/appointments";
import { CLINICAL_NOTE_FIELDS, getClinicalNote } from "@/server/services/clinical-notes";
import { listClinicalAttachments } from "@/server/services/clinical-attachments";
import { ClinicalAttachments } from "@/components/clinical-attachments";
import {
  appointmentNotesAction,
  appointmentStatusAction,
  approveAppointmentAction,
  cancelAppointmentAction,
  declineAppointmentAction,
  saveClinicalNoteAction,
} from "@/app/actions/appointments";
import { ActionForm, InlineAction } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { Avatar, SectionCard } from "@/components/ui";
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
import { cn } from "@/lib/cn";
import { getPatientHealthAlerts } from "@/server/services/patients";
import { AllergyAlert } from "@/components/health-profile";
import { PatientAccountPanel } from "@/components/patient-account";
import { getPatientAccount, listBillableServices } from "@/server/services/billing";
import type { AppointmentStatus } from "@/types/appointments";

export const metadata: Metadata = { title: "Randevu" };

const STEPS: { key: string; label: string; event: string; reached: AppointmentStatus[] }[] = [
  {
    key: "booked",
    label: "Planlama",
    event: "CREATED",
    reached: [
      "BOOKED",
      "CONFIRMED",
      "CHECKED_IN",
      "IN_PROGRESS",
      "COMPLETED",
      "NO_SHOW",
      "CANCELLED",
      "PENDING_APPROVAL",
    ],
  },
  {
    key: "arrived",
    label: "Geliş",
    event: "CHECKED_IN",
    reached: ["CHECKED_IN", "IN_PROGRESS", "COMPLETED"],
  },
  { key: "exam", label: "Muayene süreci", event: "STARTED", reached: ["IN_PROGRESS", "COMPLETED"] },
  { key: "done", label: "Sonuç", event: "COMPLETED", reached: ["COMPLETED"] },
];
const clock = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("tr-TR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

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
  const note = hasPermission(ctx, "patient.health.read") ? await getClinicalNote(ctx, a.id) : null;
  const files = note ? await listClinicalAttachments(ctx, a.id) : null;
  const alerts =
    hasPermission(ctx, "patient.health.read") && hasPermission(ctx, "patient.read")
      ? await getPatientHealthAlerts(ctx, a.patient.id).catch(() => null)
      : null;
  const billingCan = {
    charge: hasPermission(ctx, "billing.charge"),
    payment: hasPermission(ctx, "billing.payment"),
    void: hasPermission(ctx, "billing.void"),
  };
  const showBilling = hasPermission(ctx, "billing.read") && hasPermission(ctx, "patient.read");
  const [account, billable] = showBilling
    ? await Promise.all([
        getPatientAccount(ctx, a.patient.id, { appointmentId: a.id }),
        billingCan.charge ? listBillableServices(ctx) : Promise.resolve([]),
      ])
    : [null, []];
  const eventAt = (type: string) => a.history.find((h) => h.type === type)?.createdAt ?? null;
  const terminal =
    a.status === "NO_SHOW"
      ? { label: "Gelmedi", at: eventAt("NO_SHOW"), tone: "red" as const }
      : a.status === "CANCELLED"
        ? { label: "İptal", at: eventAt("CANCELLED"), tone: "slate" as const }
        : null;
  const steps = terminal ? STEPS.slice(0, 1) : STEPS;

  return (
    <section className="grid gap-6">
      <Link
        href={`/appointments?date=${a.localDate}`}
        className="inline-flex w-fit items-center gap-1 rounded-md text-[13px] font-medium text-slate-500 transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:shadow-focus dark:text-slate-400 dark:hover:text-brand-300"
      >
        <span aria-hidden="true">←</span> Randevular
      </Link>

      {/* Başlık: hasta + randevu + ilerleme */}
      <div className="card animate-enter overflow-hidden p-0">
        <div className="flex flex-wrap items-start gap-5 p-5 sm:p-6">
          <Avatar name={a.patient.name} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">
                <Link
                  href={`/patients/${a.patient.id}`}
                  className="rounded-md hover:text-brand-700 focus-visible:outline-none focus-visible:shadow-focus dark:hover:text-brand-300"
                >
                  {a.patient.name}
                </Link>{" "}
                · {a.localStart}
              </h1>
              <AppointmentStatusBadge status={a.status} />
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="size-4" aria-hidden="true" />
                {formatLocalDate(a.localDate)}
              </span>
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <Clock3 className="size-4" aria-hidden="true" />
                {a.localStart} – {a.localEnd} · {a.durationMinutes} dk
              </span>
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="size-4" aria-hidden="true" />
                {a.doctor.name}
              </span>
              {a.room ? (
                <span className="inline-flex items-center gap-1.5">
                  <DoorOpen className="size-4" aria-hidden="true" />
                  {a.room.name}
                </span>
              ) : null}
            </p>
            <p className="mt-2 text-sm">
              <span className="font-mono text-xs text-slate-400">Hasta no {a.patient.patientNumber}</span>
            </p>
          </div>
          {statusActions.length || a.canDecideApproval ? (
            <div className="flex flex-wrap items-center gap-2">
              {a.canDecideApproval ? (
                <>
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
                </>
              ) : null}
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
          ) : null}
        </div>
        {alerts?.allergies || alerts?.chronicConditions ? (
          <div className="grid gap-2 px-5 pb-4">
            <AllergyAlert allergies={alerts.allergies} />
            {alerts.chronicConditions ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                <span className="font-semibold">Kronik hastalıklar: </span>
                {alerts.chronicConditions}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Durum ilerlemesi */}
        <ol
          aria-label="Randevu ilerlemesi"
          className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4 dark:border-line-dark dark:bg-line-dark"
        >
          {steps.map((s, i) => {
            const done = s.reached.includes(a.status);
            const at = eventAt(s.event);
            return (
              <li
                key={s.key}
                className={cn(
                  "animate-rise flex items-center gap-3 bg-white px-5 py-3.5 dark:bg-surface-dark",
                  ["", "[animation-delay:80ms]", "[animation-delay:160ms]", "[animation-delay:240ms]"][i],
                )}
              >
                <span
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold",
                    done
                      ? "bg-brand-600 text-white"
                      : "bg-slate-100 text-slate-400 ring-1 ring-inset ring-slate-200 dark:bg-white/5 dark:ring-white/10",
                  )}
                >
                  {done ? <Check className="size-3.5" aria-hidden="true" /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-sm font-medium", !done && "text-slate-400")}>
                    {s.label}
                  </span>
                  <span className="block text-xs tabular-nums text-slate-400">
                    {done && at ? clock(at, a.timezone) : "—"}
                  </span>
                </span>
              </li>
            );
          })}
          {terminal ? (
            <li className="col-span-1 flex items-center gap-3 bg-white px-5 py-3.5 sm:col-span-3 dark:bg-surface-dark">
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full text-white",
                  terminal.tone === "red" ? "bg-red-500" : "bg-slate-400",
                )}
              >
                <X className="size-3.5" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-medium">{terminal.label}</span>
                <span className="block text-xs tabular-nums text-slate-400">
                  {terminal.at ? clock(terminal.at, a.timezone) : "—"}
                </span>
              </span>
            </li>
          ) : null}
        </ol>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid min-w-0 content-start gap-6">
          {/* Muayene kaydı (sağlık verisi) */}
          {note ? (
            <SectionCard
              id="muayene-kaydi"
              title="Muayene kaydı"
              description="Sağlık verisi · şifreli saklanır · her kaydetme yeni sürüm olur, önceki sürümler korunur"
              action={
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                  <FileLock2 className="size-3.5" aria-hidden="true" />
                  {note.latest ? `Sürüm ${note.latest.version}` : "Henüz kayıt yok"}
                </span>
              }
              className="animate-enter [animation-delay:80ms]"
            >
              {note.integrityError ? (
                <p
                  role="alert"
                  className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-300"
                >
                  Kayıt bütünlüğü doğrulanamadı. Yöneticinize bildirin.
                </p>
              ) : null}
              {note.canWrite ? (
                <ActionForm
                  action={saveClinicalNoteAction}
                  submitLabel="Muayene kaydını kaydet"
                  className="grid gap-4"
                >
                  <input type="hidden" name="id" value={a.id} />
                  <div className="grid gap-4 md:grid-cols-2">
                    {CLINICAL_NOTE_FIELDS.map((f) => (
                      <div key={f.key}>
                        <label htmlFor={`cn-${f.key}`} className="label">
                          {f.label}
                        </label>
                        <textarea
                          id={`cn-${f.key}`}
                          name={f.key}
                          rows={f.key === "procedures" ? 5 : 4}
                          maxLength={4000}
                          defaultValue={note.latest?.content[f.key] ?? ""}
                          placeholder={f.hint}
                          className="input resize-y leading-relaxed"
                        />
                      </div>
                    ))}
                  </div>
                </ActionForm>
              ) : note.latest ? (
                <dl className="grid gap-4 md:grid-cols-2">
                  {CLINICAL_NOTE_FIELDS.map((f) => (
                    <div key={f.key} className="rounded-lg border border-line p-3.5 dark:border-line-dark">
                      <dt className="eyebrow">{f.label}</dt>
                      <dd className="mt-1.5 whitespace-pre-line text-sm leading-relaxed">
                        {note.latest!.content[f.key] || <span className="text-slate-400">—</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                  <NotebookPen className="size-4" aria-hidden="true" />
                  {note.writeBlockedReason ?? "Henüz muayene kaydı yok."}
                </p>
              )}
              {note.canWrite === false && note.latest && note.writeBlockedReason ? (
                <p className="hint mt-3">{note.writeBlockedReason}</p>
              ) : null}
              {alerts?.allergies ? (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Alerjiler hastanın sağlık bilgilerinden gelir ·{" "}
                  <Link
                    href={`/patients/${a.patient.id}`}
                    className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                  >
                    hasta dosyasında düzenle
                  </Link>
                </p>
              ) : null}
              {files ? (
                <ClinicalAttachments
                  appointmentId={a.id}
                  items={files.items}
                  canUpload={files.canUpload}
                  canVoid={files.canUpload}
                  blockedReason={files.uploadBlockedReason}
                />
              ) : null}
              {note.versions.length ? (
                <details className="group mt-4 border-t border-line pt-3 dark:border-line-dark">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white [&::-webkit-details-marker]:hidden">
                    <History className="size-3.5" aria-hidden="true" />
                    Sürüm geçmişi ({note.versions.length})
                  </summary>
                  <ol className="mt-2 grid gap-1 text-xs text-slate-500 dark:text-slate-400">
                    {note.versions.map((v) => (
                      <li key={v.version} className="tabular-nums">
                        Sürüm {v.version} · {v.authorName} · {formatDateTime(v.createdAt)}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </SectionCard>
          ) : null}

          {canUsageRead ? (
            <SectionCard
              id="malzemeler"
              title="Kullanılan malzemeler"
              action={
                canAddUsage ? (
                  <ActionForm
                    action={createUsageAction}
                    submitLabel="Malzeme kullanımı ekle"
                    className="flex"
                  >
                    <input type="hidden" name="patientId" value={a.patient.id} />
                    <input type="hidden" name="appointmentId" value={a.id} />
                  </ActionForm>
                ) : (
                  <PackageOpen className="size-5 text-slate-300" aria-hidden="true" />
                )
              }
              className="animate-enter [animation-delay:140ms]"
            >
              {!canAddUsage && hasPermission(ctx, "inventory.usage.create") ? (
                <p className="hint mb-3">
                  Malzeme kullanımı muayene sürerken veya tamamlandıktan sonra girilir.
                </p>
              ) : null}
              <MaterialUsageList rows={usages} showAppointment={false} />
            </SectionCard>
          ) : null}

          {account ? (
            <div className="animate-enter [animation-delay:170ms]">
              <PatientAccountPanel
                title="Ücret ve tahsilat"
                account={account}
                patientId={a.patient.id}
                appointmentId={a.id}
                services={billable}
                can={billingCan}
              />
            </div>
          ) : null}

          <SectionCard
            title="Randevu notu"
            description="İdari not (ör. refakatçi gelecek) · tıbbi kayıt değildir · şifreli saklanır"
            className="animate-enter [animation-delay:200ms]"
          >
            {hasPermission(ctx, "appointment.update") && editable ? (
              <ActionForm action={appointmentNotesAction} submitLabel="Notu kaydet" className="grid gap-3">
                <input type="hidden" name="id" value={a.id} />
                <label htmlFor="ap-notes" className="sr-only">
                  Randevu notu
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
              <p className="whitespace-pre-line text-sm">
                {a.notes || <span className="text-slate-400">—</span>}
              </p>
            )}
          </SectionCard>
        </div>

        <div className="grid content-start gap-6">
          <SectionCard title="Randevu bilgileri" className="animate-enter [animation-delay:120ms]">
            <dl className="grid gap-3 text-sm">
              {(
                [
                  [UserRound, "Doktor", a.doctor.name],
                  [MapPin, "Şube", a.branch.name],
                  [DoorOpen, "Oda", a.room?.name ?? "Atanmadı"],
                  [Stethoscope, "Hizmet", a.service?.name ?? "—"],
                  [CalendarDays, "Tarih", formatLocalDate(a.localDate)],
                  [Clock3, "Saat", `${a.localStart} – ${a.localEnd} (${a.durationMinutes} dk)`],
                ] as const
              ).map(([I, k, v]) => (
                <div key={k} className="flex items-start gap-3">
                  <I className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" />
                  <dt className="w-16 shrink-0 text-slate-500 dark:text-slate-400">{k}</dt>
                  <dd className="min-w-0 font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            {a.status === "CANCELLED" && a.cancellationReason ? (
              <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm dark:bg-white/5">
                <span className="font-medium">İptal gerekçesi:</span> {a.cancellationReason}
              </p>
            ) : null}
            {a.status === "PENDING_APPROVAL" && !a.canDecideApproval ? (
              <p className="mt-4 text-sm text-amber-800 dark:text-amber-300">Doktor onayı bekleniyor.</p>
            ) : null}
          </SectionCard>

          {a.actions.includes("RESCHEDULE") || a.actions.includes("CANCEL") ? (
            <SectionCard title="Randevuyu yönet">
              <div className="grid gap-3">
                {a.actions.includes("RESCHEDULE") ? (
                  <details className="group rounded-lg border border-line p-3 dark:border-line-dark">
                    <summary className="cursor-pointer list-none text-sm font-medium [&::-webkit-details-marker]:hidden">
                      Randevuyu taşı
                    </summary>
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
                {a.actions.includes("CANCEL") ? (
                  <details className="rounded-lg border border-red-100 p-3 dark:border-red-500/20">
                    <summary className="cursor-pointer list-none text-sm font-medium text-red-700 dark:text-red-400 [&::-webkit-details-marker]:hidden">
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
            </SectionCard>
          ) : null}

          <SectionCard title="Geçmiş" className="animate-enter [animation-delay:180ms]">
            <ol className="relative grid gap-4 before:absolute before:bottom-1 before:left-[7px] before:top-1 before:w-px before:bg-line before:content-[''] dark:before:bg-line-dark">
              {a.history.map((h) => (
                <li key={h.id} className="relative pl-6">
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1 size-[15px] rounded-full border-[3px] border-white bg-brand-500 shadow-[0_0_0_1px_rgb(19_138_126/0.3)] dark:border-surface-dark"
                  />
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
          </SectionCard>
        </div>
      </div>
    </section>
  );
}
