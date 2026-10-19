import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, CircleAlert, Clock3, MapPin, PackageOpen, Stethoscope } from "lucide-react";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getMyDoctorOverview } from "@/server/services/schedule";
import {
  getTodayAppointments,
  listAppointments,
  listMyPendingApprovals,
} from "@/server/services/appointments";
import { getClinicProfile } from "@/server/services/clinic";
import {
  appointmentStatusAction,
  approveAppointmentAction,
  declineAppointmentAction,
} from "@/app/actions/appointments";
import { InlineAction } from "@/components/action-form";
import {
  APPOINTMENT_STATUS,
  AppointmentStatusBadge,
  formatLocalDate,
  quickActions,
} from "@/components/appointment-ui";
import {
  AppointmentCalendar,
  clinicMinutesNow,
  hasStartedAt,
  type CalendarColumn,
  type CalendarItem,
} from "@/components/appointment-calendar";
import { AppointmentsToolbar } from "@/components/appointments-toolbar";
import { Forbidden } from "@/components/forbidden";
import { Avatar, EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { DAYS, addDays, isValidDate, isoDayOfWeek } from "@/lib/time";
import type { AppointmentStatus } from "@/types/appointments";
import { LiveRefresh } from "@/components/notification-bell";

export const metadata: Metadata = { title: "Planım" };

const REASON: Record<string, string> = {
  NOT_WORKING: "Çalışma planı yok",
  DOCTOR_EXCEPTION: "İzinli",
  BRANCH_CLOSED: "Şube kapalı",
  INACTIVE: "Pasif",
};

type Search = { view?: string; date?: string; status?: string };

/**
 * Doktor portalı — yalnızca kendi planı ve KENDİ randevuları (doctor.self.read + appointment.read.own).
 * Üstte doktorun kendi takvimi (varsayılan hafta görünümü; gün / hafta, tarih seçici, durum filtresi), altta bugünkü
 * muayeneler (Başlat / Tamamla) ve çalışma planı. Servis kapsamı doktoru yalnızca kendi randevularıyla sınırlar.
 */
export default async function DoctorPortalPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "doctor.self.read")) return <Forbidden />;
  let overview: Awaited<ReturnType<typeof getMyDoctorOverview>>;
  try {
    overview = await getMyDoctorOverview(ctx);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") {
      return (
        <EmptyState title="Doktor profiliniz henüz oluşturulmamış" icon="doctor">
          Klinik yöneticinizden doktor profilinizi ve çalışma planınızı tanımlamasını isteyin.
        </EmptyState>
      );
    }
    throw e;
  }
  const { doctor, today, todayItems, upcoming, exceptions } = overview;
  const canSeeAppointments =
    hasPermission(ctx, "appointment.read.own") || hasPermission(ctx, "appointment.read");
  // Doktor portalı her zaman YALNIZCA bu doktorun randevularını gösterir (yönetici de olsa).
  const appts = canSeeAppointments
    ? (await getTodayAppointments(ctx)).items.filter((a) => a.doctor.id === doctor.id)
    : [];
  // Onay bekleyen randevular — yalnızca KENDİ kaydı (servis doktor eşleşmesini zorunlu tutar).
  const pending = hasPermission(ctx, "appointment.approve_own") ? await listMyPendingApprovals(ctx) : [];
  const active = appts.filter((a) => a.status !== "CANCELLED");

  // ---- Takvim (kendi randevuları) ----
  const sp = await searchParams;
  const view = sp.view === "day" ? "day" : "week";
  const date = sp.date && isValidDate(sp.date) ? sp.date : today;
  const status = sp.status && sp.status in APPOINTMENT_STATUS ? (sp.status as AppointmentStatus) : undefined;
  const weekStart = addDays(date, 1 - isoDayOfWeek(date));
  const from = view === "week" ? weekStart : date;
  const to = view === "week" ? addDays(weekStart, 6) : date;
  const calendarItems = canSeeAppointments
    ? (await listAppointments(ctx, { from, to, doctorId: doctor.id, status })).filter(
        (a) => a.doctor.id === doctor.id,
      )
    : [];
  const workingDays = new Set(upcoming.map((u) => u.date));
  if (todayItems.some((t) => t.windows.length)) workingDays.add(today);
  const offDays = new Set(exceptions.filter((x) => x.type === "ALL_DAY").map((x) => x.date));
  const columns: CalendarColumn[] =
    view === "week"
      ? DAYS.map((d, i) => {
          const day = addDays(weekStart, i);
          return {
            key: day,
            title: d.short,
            dayNumber: String(Number(day.slice(8, 10))),
            highlight: day === today,
            kind: "day" as const,
          };
        })
      : [{ key: doctor.id, title: doctor.displayName, subtitle: doctor.specialty, kind: "doctor" as const }];
  const perms = {
    checkin: hasPermission(ctx, "appointment.checkin"),
    start: hasPermission(ctx, "appointment.start"),
    complete: hasPermission(ctx, "appointment.complete"),
    noShow: hasPermission(ctx, "appointment.no_show"),
  };
  const calItems: CalendarItem[] = calendarItems.map((a) => ({
    actions: quickActions(a.status, perms, hasStartedAt(a.start)),
    id: a.id,
    column: view === "week" ? a.localDate : doctor.id,
    status: a.status,
    localStart: a.localStart,
    localEnd: a.localEnd,
    patient: a.patient.name,
    doctor: a.doctor.name,
    room: a.room?.name ?? null,
    service: a.service?.name ?? null,
  }));
  const timezone = (await getClinicProfile(ctx)).timezone;
  const nowCols = view === "week" ? [today] : date === today ? [doctor.id] : [];
  const now = nowCols.length ? { columns: nowCols, minutes: clinicMinutesNow(timezone) } : null;
  const weekOff = view === "week" ? columns.filter((c) => offDays.has(c.key)).map((c) => c.key) : [];
  const chips = [
    { label: "bugün", value: active.length, icon: CalendarClock },
    { label: "bekliyor", value: active.filter((a) => a.status === "CHECKED_IN").length, icon: Clock3 },
    { label: "muayenede", value: active.filter((a) => a.status === "IN_PROGRESS").length, icon: Stethoscope },
  ];

  return (
    <section className="grid gap-6">
      <LiveRefresh />
      <PageHeader
        title={`Merhaba, ${doctor.displayName}`}
        description={`${formatLocalDate(today)} · ${doctor.specialty}`}
        actions={
          canSeeAppointments ? (
            <div className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <span
                  key={c.label}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-sm shadow-card dark:border-line-dark dark:bg-surface-dark"
                >
                  <c.icon className="size-4 text-brand-600 dark:text-brand-300" aria-hidden="true" />
                  <span className="font-semibold tabular-nums">{c.value}</span>
                  <span className="text-slate-500 dark:text-slate-400">{c.label}</span>
                </span>
              ))}
            </div>
          ) : null
        }
      />

      {pending.length ? (
        <section
          id="onay-bekleyen"
          className="card overflow-hidden border-amber-200 p-0 dark:border-amber-500/30"
        >
          <div className="flex items-start gap-3 bg-amber-50/70 px-5 py-4 dark:bg-amber-500/5">
            <span className="stat-icon bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <CircleAlert className="size-[18px]" aria-hidden="true" />
            </span>
            <div>
              <h2 className="card-title">Onay Bekleyen Randevular</h2>
              <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                Onay verene kadar slot sizin için tutulur; reddettiğinizde yeniden müsait olur.
              </p>
            </div>
          </div>
          <div className="overflow-x-auto border-t border-amber-200 dark:border-amber-500/20">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Tarih</th>
                  <th scope="col">Saat</th>
                  <th scope="col">Hizmet</th>
                  <th scope="col">Şube</th>
                  <th scope="col">Hasta</th>
                  <th scope="col">
                    <span className="sr-only">İşlem</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pending.map((a) => (
                  <tr key={a.id} data-testid="pending-approval">
                    <td className="whitespace-nowrap align-middle">
                      {a.localDate.split("-").reverse().join(".")}
                    </td>
                    <td className="whitespace-nowrap align-middle font-medium tabular-nums">
                      {a.localStart}–{a.localEnd}
                    </td>
                    <td className="align-middle">{a.service?.name ?? "—"}</td>
                    <td className="align-middle">{a.branch.name}</td>
                    <td className="align-middle">
                      <Link
                        href={`/appointments/${a.id}`}
                        className="inline-flex items-center gap-2 font-medium hover:text-brand-700"
                      >
                        <Avatar name={a.patient.name} size="sm" />
                        {a.patient.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap text-right align-middle">
                      <div className="inline-flex flex-wrap justify-end gap-2">
                        {hasPermission(ctx, "appointment.approve_own") ? (
                          <InlineAction
                            action={approveAppointmentAction}
                            fields={{ id: a.id }}
                            label="Onayla"
                            variant="primary"
                          />
                        ) : null}
                        {hasPermission(ctx, "appointment.decline_own") ? (
                          <InlineAction
                            action={declineAppointmentAction}
                            fields={{ id: a.id }}
                            label="Reddet"
                            variant="danger"
                            confirm="Randevu reddedilsin mi? Slot yeniden müsait olacak."
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {canSeeAppointments ? (
        <section aria-label="Takvimim" className="min-w-0">
          <AppointmentsToolbar
            basePath="/doctor"
            params={{ view, date, status: sp.status }}
            today={today}
            weekStart={weekStart}
            doctors={[]}
            branches={[]}
            statuses={Object.entries(APPOINTMENT_STATUS).map(([k, v]) => ({ value: k, label: v.label }))}
          />
          {weekOff.length || (view === "week" && workingDays.size === 0) ? (
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              {weekOff.length
                ? `İzinli: ${weekOff.map((d) => formatLocalDate(d)).join(", ")}`
                : "Bu hafta için tanımlı çalışma günü yok."}
            </p>
          ) : null}
          <AppointmentCalendar
            columns={columns}
            items={calItems}
            label={view === "week" ? "Haftalık takvimim" : "Günlük takvimim"}
            showDoctor={false}
            now={now}
          />
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {canSeeAppointments ? (
          <SectionCard
            title="Bugünkü muayeneler"
            description={active.length ? `${active.length} hasta · saat sırasıyla` : undefined}
            flush
          >
            {appts.length === 0 ? (
              <div className="px-5 pb-5">
                <EmptyState title="Bugün randevunuz yok" icon="calendar" />
              </div>
            ) : (
              <ol className="divide-y divide-slate-100 border-t border-line dark:divide-line-dark dark:border-line-dark">
                {appts.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                    <div className="w-14 shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums">{a.localStart}</p>
                      <p className="text-xs tabular-nums text-slate-400">{a.localEnd}</p>
                    </div>
                    <span aria-hidden="true" className="h-10 w-[3px] shrink-0 rounded-full bg-brand-500/70" />
                    <Avatar name={a.patient.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/appointments/${a.id}`}
                        className="block truncate text-sm font-medium hover:text-brand-700 dark:hover:text-brand-300"
                      >
                        {a.patient.name}
                      </Link>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {a.service?.name ?? "—"}
                        {a.room ? ` · ${a.room.name}` : ""}
                      </p>
                    </div>
                    <AppointmentStatusBadge status={a.status} />
                    <div className="flex items-center gap-2">
                      {a.status === "CHECKED_IN" && hasPermission(ctx, "appointment.start") ? (
                        <InlineAction
                          action={appointmentStatusAction}
                          fields={{ id: a.id, status: "IN_PROGRESS" }}
                          label="Başlat"
                          variant="primary"
                        />
                      ) : a.status === "IN_PROGRESS" && hasPermission(ctx, "appointment.complete") ? (
                        <InlineAction
                          action={appointmentStatusAction}
                          fields={{ id: a.id, status: "COMPLETED" }}
                          label="Tamamla"
                          variant="primary"
                        />
                      ) : null}
                      {(a.status === "IN_PROGRESS" || a.status === "COMPLETED") &&
                      hasPermission(ctx, "inventory.usage.create") ? (
                        <Link href={`/appointments/${a.id}#malzemeler`} className="btn-ghost btn-sm">
                          <PackageOpen className="size-4" aria-hidden="true" />
                          Malzeme kullanımı
                        </Link>
                      ) : a.status === "BOOKED" || a.status === "CONFIRMED" ? (
                        <span className="text-xs text-slate-500">Hasta bekleniyor</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        ) : null}

        <div className="grid content-start gap-6">
          <SectionCard title="Bugünkü çalışma planı">
            {todayItems.some((t) => t.windows.length) ? (
              <div className="grid gap-3">
                {todayItems
                  .filter((t) => t.windows.length)
                  .map((t) => (
                    <div
                      key={t.branchId}
                      className="rounded-lg border border-line p-3.5 dark:border-line-dark"
                    >
                      <p className="flex items-center gap-1.5 text-sm font-semibold">
                        <MapPin className="size-4 text-slate-400" aria-hidden="true" />
                        {t.branchName}
                      </p>
                      <ul className="mt-2.5 grid gap-2">
                        {t.windows.map((w, i) => (
                          <li key={i} className="flex items-center justify-between gap-3 text-sm">
                            <span className="font-mono text-xs">
                              {w.start}–{w.end}
                            </span>
                            <span className={`badge ${w.roomName ? "badge-brand" : "badge-gray"}`}>
                              {w.roomName ?? "Oda atanmamış"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                {todayItems.length
                  ? (REASON[todayItems[0]!.reason] ?? "Bugün çalışma yok")
                  : "Bugün çalışma planınız yok."}
              </p>
            )}
          </SectionCard>

          <SectionCard title="Yaklaşan çalışma günleri">
            {upcoming.length ? (
              <ul className="divide-y divide-slate-100 dark:divide-line-dark">
                {upcoming.map((u) => (
                  <li
                    key={`${u.date}-${u.branchId}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                  >
                    <span className="font-medium">{formatLocalDate(u.date)}</span>
                    <span className="text-right text-xs text-slate-500">
                      {u.branchName} ·{" "}
                      <span className="font-mono">
                        {u.windows
                          .map((w) => `${w.start}–${w.end}${w.roomName ? ` (${w.roomName})` : ""}`)
                          .join(", ")}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Önümüzdeki iki haftada planlı çalışma yok.</p>
            )}
          </SectionCard>

          <SectionCard title="İzinler">
            {exceptions.length ? (
              <ul className="grid gap-2 text-sm">
                {exceptions.map((x) => (
                  <li key={x.id}>
                    <span className="font-medium">{formatLocalDate(x.date)}</span>{" "}
                    <span className="badge badge-amber">
                      {x.type === "ALL_DAY" ? "Tüm gün" : `${x.startTime}–${x.endTime}`}
                    </span>
                    {x.reason ? <p className="text-slate-500">{x.reason}</p> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Yaklaşan izin yok.</p>
            )}
          </SectionCard>
        </div>
      </div>
    </section>
  );
}
