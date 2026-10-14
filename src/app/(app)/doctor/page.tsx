import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getMyDoctorOverview } from "@/server/services/schedule";
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

/** Doktor portalı — yalnızca kendi planı (doctor.self.read). Hasta/randevu verisi Sprint 2'de eklenecek. */
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

  return (
    <section className="grid gap-6">
      <PageHeader
        title={`Merhaba, ${doctor.displayName}`}
        description={`${dayName(isoDayOfWeek(today))}, ${today} · ${doctor.specialty}`}
      />

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
