import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getMyDoctorOverview } from "@/server/services/schedule";
import { getTodayAppointments } from "@/server/services/appointments";
import { appointmentStatusAction } from "@/app/actions/appointments";
import { InlineAction } from "@/components/action-form";
import { AppointmentStatusBadge } from "@/components/appointment-ui";
import Link from "next/link";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, PageHeader } from "@/components/ui";
import { dayName, isoDayOfWeek } from "@/lib/time";

export const metadata: Metadata = { title: "Planım" };

const REASON: Record<string, string> = {
  NOT_WORKING: "Çalışma planı yok",
  DOCTOR_EXCEPTION: "İzinli",
  BRANCH_CLOSED: "Şube kapalı",
  INACTIVE: "Pasif",
};

/** Doktor portalı — yalnızca kendi planı ve KENDİ randevuları (doctor.self.read + appointment.read.own). */
export default async function DoctorPortalPage() {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "doctor.self.read")) return <Forbidden />;
  let overview: Awaited<ReturnType<typeof getMyDoctorOverview>>;
  try {
    overview = await getMyDoctorOverview(ctx);
  } catch (e) {
    if (isAppError(e) && e.code === "NOT_FOUND") {
      return (
        <EmptyState title="Doktor profiliniz henüz oluşturulmamış">
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

  return (
    <section className="grid gap-6">
      <PageHeader
        title={`Merhaba, ${doctor.displayName}`}
        description={`${dayName(isoDayOfWeek(today))}, ${today} · ${doctor.specialty}`}
      />

      {canSeeAppointments ? (
        <div className="card overflow-x-auto p-0">
          <h2 className="px-5 pt-5 font-semibold">Bugünkü randevular</h2>
          {appts.length === 0 ? (
            <p className="px-5 pb-5 pt-2 text-sm text-slate-500">Bugün randevunuz yok.</p>
          ) : (
            <table className="table mt-3">
              <thead>
                <tr>
                  <th scope="col">Saat</th>
                  <th scope="col">Hasta</th>
                  <th scope="col">Hizmet</th>
                  <th scope="col">Oda</th>
                  <th scope="col">Durum</th>
                  <th scope="col">
                    <span className="sr-only">İşlem</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {appts.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap font-medium tabular-nums">
                      {a.localStart}–{a.localEnd}
                    </td>
                    <td>
                      <Link href={`/appointments/${a.id}`} className="hover:text-brand-700">
                        {a.patient.name}
                      </Link>
                    </td>
                    <td>{a.service?.name ?? "—"}</td>
                    <td>{a.room?.name ?? "—"}</td>
                    <td>
                      <AppointmentStatusBadge status={a.status} />
                    </td>
                    <td className="whitespace-nowrap text-right">
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
                      ) : a.status === "BOOKED" || a.status === "CONFIRMED" ? (
                        <span className="text-xs text-slate-500">Hasta bekleniyor</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      <div className="card">
        <h2 className="mb-4 font-semibold">Bugün</h2>
        {todayItems.some((t) => t.windows.length) ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {todayItems
              .filter((t) => t.windows.length)
              .map((t) => (
                <div
                  key={t.branchId}
                  className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
                >
                  <p className="text-sm text-slate-500">Şube</p>
                  <p className="text-lg font-semibold">{t.branchName}</p>
                  <ul className="mt-3 grid gap-2">
                    {t.windows.map((w, i) => (
                      <li key={i} className="flex items-center justify-between gap-3 text-sm">
                        <span className="font-mono">
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
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="card">
          <h2 className="mb-4 font-semibold">Yaklaşan çalışma günleri</h2>
          {upcoming.length ? (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {upcoming.map((u) => (
                <li
                  key={`${u.date}-${u.branchId}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                >
                  <span>
                    <span className="font-medium">{dayName(isoDayOfWeek(u.date))}</span>{" "}
                    <span className="text-slate-500">{u.date}</span>
                  </span>
                  <span className="text-right">
                    {u.branchName} ·{" "}
                    <span className="font-mono text-xs">
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
        </div>
        <div className="card">
          <h2 className="mb-4 font-semibold">İzinler</h2>
          {exceptions.length ? (
            <ul className="grid gap-2 text-sm">
              {exceptions.map((x) => (
                <li key={x.id}>
                  <span className="font-medium">{x.date}</span>{" "}
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
        </div>
      </div>
    </section>
  );
}
