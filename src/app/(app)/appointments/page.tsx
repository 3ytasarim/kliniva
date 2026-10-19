import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { clinicToday, listAppointments } from "@/server/services/appointments";
import { getClinicProfile } from "@/server/services/clinic";
import { accessibleBranchOptions } from "@/server/services/org";
import { listDoctors } from "@/server/services/doctors";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { AppointmentsToolbar } from "@/components/appointments-toolbar";
import {
  AppointmentCalendar,
  clinicMinutesNow,
  hasStartedAt,
  type CalendarColumn,
  type CalendarItem,
} from "@/components/appointment-calendar";
import {
  APPOINTMENT_STATUS,
  AppointmentStatusBadge,
  formatLocalDate,
  quickActions,
} from "@/components/appointment-ui";
import { DAYS, addDays, isValidDate, isoDayOfWeek } from "@/lib/time";
import type { AppointmentStatus } from "@/types/appointments";

export const metadata: Metadata = { title: "Randevular" };

type Search = { view?: string; date?: string; branch?: string; doctor?: string; status?: string };

/**
 * Randevu takvimi — gün (sütun = doktor) / hafta (sütun = gün). Tarih penceresiyle sorgulanır (yıllık yükleme yok).
 * Şube / doktor kapsamı serviste uygulanır; doktor rolü yalnızca kendi randevularını görür.
 */
export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "appointment.read") && !hasPermission(ctx, "appointment.read.own"))
    return <Forbidden />;
  const sp = await searchParams;
  const [today, profile] = await Promise.all([clinicToday(ctx), getClinicProfile(ctx)]);
  const view = sp.view === "week" ? "week" : "day";
  const date = sp.date && isValidDate(sp.date) ? sp.date : today;
  const status = sp.status && sp.status in APPOINTMENT_STATUS ? (sp.status as AppointmentStatus) : undefined;
  const weekStart = addDays(date, 1 - isoDayOfWeek(date));
  const from = view === "week" ? weekStart : date;
  const to = view === "week" ? addDays(weekStart, 6) : date;

  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const doctors = hasPermission(ctx, "doctor.read") ? (await listDoctors(ctx)).filter((d) => d.active) : [];
  const items = await listAppointments(ctx, {
    from,
    to,
    branchId: sp.branch || undefined,
    doctorId: sp.doctor || undefined,
    status,
  });
  const canCreate = hasPermission(ctx, "appointment.create");
  const newHref = `/appointments/new?date=${date >= today ? date : today}`;

  const perms = {
    checkin: hasPermission(ctx, "appointment.checkin"),
    start: hasPermission(ctx, "appointment.start"),
    complete: hasPermission(ctx, "appointment.complete"),
    noShow: hasPermission(ctx, "appointment.no_show"),
  };
  const calItems: CalendarItem[] = items.map((a) => ({
    actions: quickActions(a.status, perms, hasStartedAt(a.start)),
    id: a.id,
    column: view === "week" ? a.localDate : a.doctor.id,
    status: a.status,
    localStart: a.localStart,
    localEnd: a.localEnd,
    patient: a.patient.name,
    doctor: a.doctor.name,
    room: a.room?.name ?? null,
    service: a.service?.name ?? null,
  }));

  let columns: CalendarColumn[];
  if (view === "week") {
    columns = DAYS.map((d, i) => {
      const day = addDays(weekStart, i);
      return {
        key: day,
        title: d.short,
        dayNumber: String(Number(day.slice(8, 10))),
        highlight: day === today,
        kind: "day",
      };
    });
  } else {
    // Gün görünümü: o gün çalışan (filtreye uyan) doktorlar + randevusu olan doktorlar — boş gün de takvim olarak görünür.
    const cols = new Map<string, CalendarColumn>();
    for (const d of doctors) {
      if (sp.doctor && d.id !== sp.doctor) continue;
      if (sp.branch && !d.branches.some((b) => b.id === sp.branch)) continue;
      if (!d.workingDays.includes(isoDayOfWeek(date))) continue;
      cols.set(d.id, { key: d.id, title: d.displayName, subtitle: d.specialty, kind: "doctor" });
    }
    for (const a of items) {
      if (!cols.has(a.doctor.id))
        cols.set(a.doctor.id, { key: a.doctor.id, title: a.doctor.name, kind: "doctor" });
    }
    columns = [...cols.values()].sort((a, b) => a.title.localeCompare(b.title, "tr"));
  }
  const tooManyColumns = view === "day" && columns.length > 7;
  const nowCols = view === "week" ? [today] : date === today ? columns.map((c) => c.key) : [];
  const now = nowCols.length ? { columns: nowCols, minutes: clinicMinutesNow(profile.timezone) } : null;

  return (
    <section>
      <PageHeader
        title="Randevular"
        description={
          view === "week"
            ? `${formatLocalDate(from)} – ${formatLocalDate(to)} · ${items.length} randevu`
            : `${formatLocalDate(date)} · ${items.length} randevu`
        }
        actions={
          canCreate ? (
            <Button asChild>
              <Link href={newHref}>
                <Plus />
                Yeni randevu
              </Link>
            </Button>
          ) : null
        }
      />

      <AppointmentsToolbar
        params={{ view, date, branch: sp.branch, doctor: sp.doctor, status: sp.status }}
        today={today}
        weekStart={weekStart}
        doctors={doctors.map((d) => ({ value: d.id, label: d.displayName }))}
        branches={branches.map((b) => ({ value: b.id, label: b.name }))}
        statuses={Object.entries(APPOINTMENT_STATUS).map(([k, v]) => ({ value: k, label: v.label }))}
      />

      {columns.length === 0 ? (
        <EmptyState title="Bu aralıkta randevu yok" icon="calendar">
          {canCreate ? (
            <Link href={newHref} className="font-medium text-brand-700 dark:text-brand-300">
              Randevu oluşturun
            </Link>
          ) : null}
        </EmptyState>
      ) : tooManyColumns ? null : (
        <AppointmentCalendar
          columns={columns}
          items={calItems}
          label={view === "week" ? "Haftalık randevu takvimi" : "Günlük randevu takvimi"}
          showDoctor={view === "week"}
          now={now}
        />
      )}

      {items.length ? (
        <details className="group mt-6" open={tooManyColumns}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-md text-sm font-medium text-brand-700 hover:underline focus-visible:outline-none focus-visible:shadow-focus dark:text-brand-300 [&::-webkit-details-marker]:hidden">
            <span className="transition-transform group-open:rotate-90" aria-hidden="true">
              ›
            </span>
            Liste görünümü ({items.length})
          </summary>
          <SectionCard title="Randevu listesi" flush className="mt-3 overflow-hidden">
            <div className="overflow-x-auto border-t border-line dark:border-line-dark">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Tarih / saat</th>
                    <th scope="col">Hasta</th>
                    <th scope="col">Doktor</th>
                    <th scope="col">Hizmet</th>
                    <th scope="col">Oda</th>
                    <th scope="col">Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap tabular-nums">
                        <Link href={`/appointments/${a.id}`} className="font-medium hover:text-brand-700">
                          {a.localDate.slice(8, 10)}.{a.localDate.slice(5, 7)} {a.localStart}–{a.localEnd}
                        </Link>
                      </td>
                      <td>{a.patient.name}</td>
                      <td>{a.doctor.name}</td>
                      <td>{a.service?.name ?? "—"}</td>
                      <td>{a.room?.name ?? "—"}</td>
                      <td>
                        <AppointmentStatusBadge status={a.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </details>
      ) : null}
    </section>
  );
}
