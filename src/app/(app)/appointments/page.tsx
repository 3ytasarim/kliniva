import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { clinicToday, listAppointments } from "@/server/services/appointments";
import { accessibleBranchOptions } from "@/server/services/org";
import { listDoctors } from "@/server/services/doctors";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader } from "@/components/ui";
import {
  AppointmentCalendar,
  type CalendarColumn,
  type CalendarItem,
} from "@/components/appointment-calendar";
import { APPOINTMENT_STATUS, AppointmentStatusBadge, formatLocalDate } from "@/components/appointment-ui";
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
  const today = await clinicToday(ctx);
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

  const qs = (patch: Partial<Search>) => {
    const u = new URLSearchParams();
    const merged = { view, date, branch: sp.branch, doctor: sp.doctor, status: sp.status, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) u.set(k, v);
    return `/appointments?${u.toString()}`;
  };
  const step = view === "week" ? 7 : 1;

  const calItems: CalendarItem[] = items.map((a) => ({
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
        title: d.long,
        subtitle: day.slice(8, 10) + "." + day.slice(5, 7),
        highlight: day === today,
      };
    });
  } else {
    const seen = new Map<string, string>();
    for (const a of items) seen.set(a.doctor.id, a.doctor.name);
    columns = [...seen.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], "tr"))
      .map(([key, title]) => ({ key, title }));
  }
  const tooManyColumns = view === "day" && columns.length > 7;

  return (
    <section>
      <PageHeader
        title="Randevular"
        description={
          view === "week" ? `${formatLocalDate(from)} – ${formatLocalDate(to)}` : formatLocalDate(date)
        }
        actions={
          hasPermission(ctx, "appointment.create") ? (
            <Link href={`/appointments/new?date=${date >= today ? date : today}`} className="btn">
              + Yeni randevu
            </Link>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div
          className="inline-flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700"
          role="group"
          aria-label="Görünüm"
        >
          {(["day", "week"] as const).map((v) => (
            <Link
              key={v}
              href={qs({ view: v })}
              aria-current={view === v ? "page" : undefined}
              className={`inline-flex min-h-10 items-center rounded-md px-4 text-sm font-medium ${
                view === v
                  ? "bg-brand-600 text-white"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`}
            >
              {v === "day" ? "Gün" : "Hafta"}
            </Link>
          ))}
        </div>
        <Link href={qs({ date: addDays(date, -step) })} className="btn-ghost btn-sm" aria-label="Önceki">
          ←
        </Link>
        <Link href={qs({ date: today })} className="btn-ghost btn-sm">
          Bugün
        </Link>
        <Link href={qs({ date: addDays(date, step) })} className="btn-ghost btn-sm" aria-label="Sonraki">
          →
        </Link>
      </div>

      <form className="card mb-6 grid gap-3 sm:grid-cols-2 sm:items-end xl:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)_160px_auto]">
        <input type="hidden" name="view" value={view} />
        <div>
          <label htmlFor="f-date" className="label">
            Tarih
          </label>
          <input id="f-date" type="date" name="date" defaultValue={date} className="input" />
        </div>
        <div>
          <label htmlFor="f-branch" className="label">
            Şube
          </label>
          <select id="f-branch" name="branch" defaultValue={sp.branch ?? ""} className="input">
            <option value="">Tüm şubeler</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-doctor" className="label">
            Doktor
          </label>
          <select id="f-doctor" name="doctor" defaultValue={sp.doctor ?? ""} className="input">
            <option value="">Tüm doktorlar</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="f-status" className="label">
            Durum
          </label>
          <select id="f-status" name="status" defaultValue={status ?? ""} className="input">
            <option value="">Tümü</option>
            {Object.entries(APPOINTMENT_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-ghost">
          Filtrele
        </button>
      </form>

      {items.length === 0 ? (
        <EmptyState title="Bu aralıkta randevu yok">
          {hasPermission(ctx, "appointment.create") ? (
            <Link
              href={`/appointments/new?date=${date >= today ? date : today}`}
              className="font-medium text-brand-700"
            >
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
        />
      )}

      {items.length ? (
        <details className="mt-6" open={tooManyColumns}>
          <summary className="cursor-pointer text-sm font-medium text-brand-700">
            Liste görünümü ({items.length})
          </summary>
          <div className="card mt-3 overflow-x-auto p-0">
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
        </details>
      ) : null}
    </section>
  );
}
