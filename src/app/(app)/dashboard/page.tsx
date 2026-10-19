import type { Metadata } from "next";
import Link from "next/link";
import { requireTenant } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { MFA_REQUIRED_ROLES } from "@/server/auth/permissions";
import { getAppointmentStats, getTodayAppointments, listAppointments } from "@/server/services/appointments";
import { getClinicProfile } from "@/server/services/clinic";
import { getInventoryDashboard } from "@/server/services/inventory";
import { listNotifications } from "@/server/services/notifications";
import { listPatients } from "@/server/services/patients";
import { accessibleBranchOptions } from "@/server/services/org";
import { AppointmentStatusBadge, formatLocalDate } from "@/components/appointment-ui";
import { timeAgo } from "@/components/notification-ui";
import { ClientOnly } from "@/components/client-only";
import { Avatar, EmptyState, Icon, SectionCard, type IconName } from "@/components/ui";
import { ActivityFeed, Ring, WeekStrip, type TrendPoint } from "@/components/dashboard-widgets";
import { DAYS, addDays, isoDayOfWeek } from "@/lib/time";
import { getFinanceDashboard } from "@/server/services/cash";
import { listOpenBalances } from "@/server/services/billing";
import { IncomeExpenseChart, IncomeExpenseLegend, TopServices } from "@/components/finance-widgets";
import { getPatientSourceStats } from "@/server/services/patients";
import { getMyTaskCounts, listTasks } from "@/server/services/tasks";
import { Accent, DonutChart, MetricTile, PillBarChart, SummaryTile } from "@/components/dashboard-tiles";
import { TaskList } from "@/components/patient-tasks";
import { formatMoney, formatMoneyMap } from "@/lib/money";
import type { FinanceDashboard, OpenBalanceRow, MoneyByCurrency } from "@/types/finance";
import type { AppointmentStatus } from "@/types/appointments";

export const metadata: Metadata = { title: "Panel" };

/** Sıradaki hasta: henüz bitmemiş (beklenen / geldi / muayenede) ilk randevu. */
const OPEN: AppointmentStatus[] = ["PENDING_APPROVAL", "BOOKED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"];
const MISSED: AppointmentStatus[] = ["CANCELLED", "NO_SHOW"];

/** Randevu bitiş saati henüz gelmedi mi (sunucu bileşeni; istek anına göre). */
const notEnded = (iso: string) => new Date(iso).getTime() > Date.now();

function greeting(timezone: string) {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hour12: false }).format(
      new Date(),
    ),
  );
  return h < 6 ? "İyi geceler" : h < 12 ? "Günaydın" : h < 18 ? "İyi günler" : "İyi akşamlar";
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const fmt = (n: number) => new Intl.NumberFormat("tr-TR").format(n);

/**
 * Panel — klinik operasyon özeti. Her bölüm YALNIZCA kullanıcının yetkili olduğu veriyle (doktor: kendi randevuları;
 * şube kapsamı servislerde). Yetkisi olmayan kart gösterilmez. Panel stok özetini audit'siz SAYI olarak alır
 * (rapor ekranları ayrıca audit'lenir).
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>;
}) {
  const { ctx, tenant } = await requireTenant();
  const sp = await searchParams;
  const profile = await getClinicProfile(ctx);
  const canAll = hasPermission(ctx, "appointment.read");
  const canAppointments = canAll || hasPermission(ctx, "appointment.read.own");
  const canPatients = hasPermission(ctx, "patient.read");
  const canInventory = hasPermission(ctx, "inventory.read");
  const canNotifications = hasPermission(ctx, "notification.read_own");
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const branchId = branches.some((b) => b.id === sp.branch) ? sp.branch : undefined;

  const [stats, todayList] = canAppointments
    ? await Promise.all([getAppointmentStats(ctx, { branchId }), getTodayAppointments(ctx, { branchId })])
    : [null, null];
  const today = stats?.date ?? todayList?.today ?? null;
  const canCash = hasPermission(ctx, "cash.read");
  const canBalances = hasPermission(ctx, "billing.read") && canPatients;
  const canTasks = hasPermission(ctx, "task.read");
  const [myTasks, taskCounts] = canTasks
    ? await Promise.all([listTasks(ctx, { scope: "mine", view: "open", limit: 6 }), getMyTaskCounts(ctx)])
    : [null, null];
  const [finance, balances, sourceStats] = await Promise.all([
    canCash ? getFinanceDashboard(ctx) : Promise.resolve(null),
    canBalances ? listOpenBalances(ctx, { limit: 5 }) : Promise.resolve(null),
    canPatients && canAll ? getPatientSourceStats(ctx) : Promise.resolve(null),
  ]);
  const [range, patients, inventory, notes] = await Promise.all([
    canAppointments && today
      ? listAppointments(ctx, { from: addDays(today, -13), to: addDays(today, 7), branchId })
      : Promise.resolve([]),
    canPatients ? listPatients(ctx, { limit: 1 }) : Promise.resolve(null),
    canInventory ? getInventoryDashboard(ctx, { branchId }, { audit: false }) : Promise.resolve(null),
    canNotifications ? listNotifications(ctx, { limit: 6 }) : Promise.resolve(null),
  ]);

  const isDoctor = ctx.roles.includes("DOCTOR");
  const listHref = (status?: AppointmentStatus) =>
    canAll && today
      ? `/appointments?date=${today}${branchId ? `&branch=${branchId}` : ""}${status ? `&status=${status}` : ""}`
      : "/operations/today";
  const dayHref = (date: string) =>
    canAll ? `/appointments?view=day&date=${date}` : `/doctor?view=day&date=${date}`;

  // 14 günlük eğilim + 7 günlük ileri bakış
  const trend: TrendPoint[] = today
    ? Array.from({ length: 14 }, (_, i) => {
        const date = addDays(today, i - 13);
        const day = range.filter((a) => a.localDate === date);
        return {
          date,
          label: `${Number(date.slice(8, 10))}`,
          total: day.length,
          completed: day.filter((a) => a.status === "COMPLETED").length,
          missed: day.filter((a) => MISSED.includes(a.status)).length,
        };
      })
    : [];
  const trendTotal = trend.reduce((s, d) => s + d.total, 0);
  const trendDone = trend.reduce((s, d) => s + d.completed, 0);
  const trendMissed = trend.reduce((s, d) => s + d.missed, 0);
  const upcoming = today
    ? Array.from({ length: 7 }, (_, i) => {
        const date = addDays(today, i);
        return {
          date,
          dayShort: DAYS[isoDayOfWeek(date) - 1]!.short,
          dayNumber: String(Number(date.slice(8, 10))),
          count: range.filter((a) => a.localDate === date && !MISSED.includes(a.status)).length,
          isToday: i === 0,
        };
      })
    : [];
  const nextWeek = range.filter((a) => today && a.localDate > today && !MISSED.includes(a.status));
  const pendingApproval = range.filter((a) => a.status === "PENDING_APPROVAL").length;

  // Metrik kartları (izinlere göre en çok 4). Değişim: bugün vs geçen haftanın aynı günü.
  const sameDayLastWeek = trend.length === 14 ? trend[6]!.total : 0;
  const tiles: React.ComponentProps<typeof MetricTile>[] = [];
  if (stats) {
    tiles.push({
      title: "Bugünkü randevular",
      value: fmt(stats.total),
      sub: `${stats.completed} tamamlandı · ${stats.waiting} bekleyen`,
      delta: { pct: sameDayLastWeek ? ((stats.total - sameDayLastWeek) / sameDayLastWeek) * 100 : null },
      href: listHref(),
      primary: true,
      testId: "tile-today",
    });
  }
  if (finance) {
    tiles.push({
      title: "Bu ay tahsilat",
      value: formatMoney(finance.monthCollectedMinor),
      sub: "Geçen ayın aynı dönemine göre",
      delta: {
        pct: finance.prevMonthSamePeriodMinor
          ? ((finance.monthCollectedMinor - finance.prevMonthSamePeriodMinor) /
              finance.prevMonthSamePeriodMinor) *
            100
          : null,
      },
      href: "/finance/cash",
    });
    if (balances) {
      tiles.push({
        title: "Açık bakiye",
        value: formatMoney(finance.openBalanceMinor),
        sub: `${finance.openBalancePatients} hastada tahsil edilmemiş`,
        href: "/finance/balances",
      });
    }
  }
  if (stats && tiles.length < 4) {
    tiles.push({
      title: "Muayene akışı",
      value: fmt(stats.inProgress),
      sub: `muayenede · ${stats.upcoming} sırada · ${stats.noShow} gelmedi`,
      href: "/operations/today",
    });
  }
  if (patients && tiles.length < 4) {
    tiles.push({
      title: "Aktif hasta",
      value: fmt(patients.total),
      sub: "Kayıtlı aktif hasta",
      href: "/patients",
    });
  }
  if (inventory && tiles.length < 4) {
    tiles.push({
      title: "Stok uyarısı",
      value: fmt(inventory.lowStock + inventory.outOfStock),
      sub: `${inventory.outOfStock} tükenen · ${inventory.lotCards?.expired ?? 0} SKT geçmiş`,
      href: "/inventory",
    });
  }

  const flow = (todayList?.items ?? []).filter((a) => a.status !== "CANCELLED");
  const nextUp = flow.find((a) => OPEN.includes(a.status) && notEnded(a.end));
  const done = stats ? pct(stats.completed, stats.total) : 0;
  const mfaRecommended = ctx.roles.some((r) => MFA_REQUIRED_ROLES.includes(r));

  const quick: { href: string; label: string; icon: IconName; show: boolean }[] = [
    {
      href: "/appointments/new",
      label: "Yeni randevu",
      icon: "plus",
      show: hasPermission(ctx, "appointment.create"),
    },
    {
      href: "/patients/new",
      label: "Yeni hasta",
      icon: "userPlus",
      show: hasPermission(ctx, "patient.create"),
    },
    { href: "/operations/today", label: "Bugünkü muayeneler", icon: "exam", show: canAppointments },
    { href: "/doctor", label: "Planım", icon: "calendar", show: hasPermission(ctx, "doctor.self.read") },
    { href: "/patients", label: "Hasta ara", icon: "search", show: canPatients },
    { href: "/inventory", label: "Stok durumu", icon: "inventory", show: canInventory },
  ];

  return (
    <section className="grid gap-6">
      {/* Karşılama şeridi */}
      <div className="animate-enter animate-gradient relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-500 via-brand-700 to-brand-900 p-5 text-white shadow-raised sm:p-6">
        <span
          aria-hidden="true"
          className="animate-float absolute -right-16 -top-24 size-72 rounded-full bg-white/10 blur-3xl"
        />
        <span
          aria-hidden="true"
          className="animate-float absolute -bottom-28 left-1/3 size-72 rounded-full bg-brand-300/20 blur-3xl [animation-delay:-4s]"
        />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div className="flex min-w-0 items-center gap-4">
            <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-white shadow-raised sm:size-16">
              {profile.hasLogo ? (
                // eslint-disable-next-line @next/next/no-img-element -- yalnızca oturumdaki kiracının logosu
                <img
                  src="/api/v1/clinic/logo"
                  alt=""
                  className="size-11 rounded-lg object-contain sm:size-12"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- statik marka görseli
                <img
                  src="/brand/kliniva-mark.png"
                  alt=""
                  width={44}
                  height={44}
                  className="size-11 sm:size-12"
                />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-brand-100/90">
                {profile.displayName || tenant.name}
              </p>
              <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight sm:text-[28px]">
                {greeting(profile.timezone)}, {isDoctor ? "Dr. " : ""}
                {ctx.user.firstName}
              </h1>
              <p className="mt-1 text-sm text-brand-50/90">
                {today ? formatLocalDate(today) : "Kliniva AI"}
                {stats ? ` · ${stats.total} randevu, ${stats.waiting} bekleyen` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-5">
            {nextUp ? (
              <Link
                href={`/appointments/${nextUp.id}`}
                className="rounded-xl bg-white/10 px-4 py-2.5 ring-1 ring-white/15 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-white/60"
              >
                <p className="text-[11px] font-medium uppercase tracking-wide text-brand-100/90">
                  Sıradaki hasta
                </p>
                <p className="mt-0.5 text-sm font-semibold">
                  {nextUp.localStart} · {nextUp.patient.name}
                </p>
              </Link>
            ) : null}
            {stats && stats.total ? (
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Ring value={done} label="Bugün tamamlanan" />
                  <span className="absolute inset-0 grid place-items-center text-sm font-semibold tabular-nums">
                    %{done}
                  </span>
                </div>
                <div className="text-sm leading-tight">
                  <p className="font-semibold">Tamamlanma</p>
                  <p className="text-brand-100/90">
                    {stats.completed}/{stats.total} muayene
                  </p>
                </div>
              </div>
            ) : null}
            {hasPermission(ctx, "appointment.create") ? (
              <Link
                href="/appointments/new"
                className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-brand-800 shadow-raised transition-colors hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <Icon name="plus" className="size-4" />
                Yeni randevu
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {stats && branches.length > 1 ? (
        <form className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="d-branch" className="label">
              Şube
            </label>
            <select id="d-branch" name="branch" defaultValue={branchId ?? ""} className="input">
              <option value="">Tüm şubeler</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn-ghost">
            Göster
          </button>
        </form>
      ) : null}

      {/* Üst bölüm: 2×2 metrik kartı + son 14 gün randevu eğilimi (hap çubuklar) */}
      {tiles.length || stats ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
          <div className="grid content-start gap-4 sm:grid-cols-2" aria-label="Özet">
            {tiles.map((t, i) => (
              <MetricTile key={t.title} index={i} {...t} />
            ))}
          </div>
          {stats ? (
            <SectionCard
              title="Randevu eğilimi"
              description="Son 14 gün · günlük randevu"
              className="animate-enter [animation-delay:120ms]"
              action={
                <div className="flex gap-5 text-right">
                  <div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Tamamlanma</p>
                    <p className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      %{pct(trendDone, trendTotal)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">İptal / gelmedi</p>
                    <p className="text-lg font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                      %{pct(trendMissed, trendTotal)}
                    </p>
                  </div>
                </div>
              }
            >
              <ClientOnly
                fallback={
                  <div className="aspect-[3/1] w-full animate-pulse rounded-lg bg-slate-100 dark:bg-white/5" />
                }
              >
                <PillBarChart
                  label="Son 14 günün randevu eğilimi"
                  data={trend.map((d) => ({
                    key: d.date,
                    label: d.label,
                    value: d.total,
                    display: `${d.total} randevu`,
                  }))}
                />
              </ClientOnly>
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {/* Özet kartları: onay bekleyen randevular, görevler, önümüzdeki 7 gün */}
      {stats || taskCounts ? (
        <div
          className={`grid gap-4 md:grid-cols-2 ${sourceStats?.total ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}
        >
          {stats ? (
            <SummaryTile
              icon="check"
              count={pendingApproval}
              word="randevu"
              href={listHref("PENDING_APPROVAL")}
              index={0}
            >
              {pendingApproval ? (
                <>
                  {pendingApproval} randevu <Accent>onay bekliyor</Accent>.
                </>
              ) : (
                "Onay bekleyen randevu yok."
              )}
            </SummaryTile>
          ) : null}
          {taskCounts ? (
            <SummaryTile icon="users" count={taskCounts.open} word="görev" href="/tasks" wave index={1}>
              {taskCounts.overdue ? (
                <>
                  {taskCounts.overdue} görev <Accent>gecikti</Accent>, {taskCounts.today} tanesi bugün.
                </>
              ) : (
                `Size atanmış ${taskCounts.today} görev bugün.`
              )}
            </SummaryTile>
          ) : null}
          {sourceStats?.total ? <SourcesCard stats={sourceStats} /> : null}
          {stats ? (
            <SectionCard
              title="Önümüzdeki 7 gün"
              description={`${nextWeek.length} randevu planlı`}
              className="animate-enter [animation-delay:180ms]"
            >
              <WeekStrip days={upcoming} hrefFor={dayHref} />
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {/* Finans: tahsilat, gelir-gider, en çok ciro yapan hizmetler, açık bakiyeler */}
      {finance ? <FinanceSection finance={finance} balances={balances} /> : null}

      {/* Bugünkü akış + son etkinlikler */}
      <div className="grid gap-6 lg:grid-cols-3">
        {todayList ? (
          <SectionCard
            title="Bugünkü muayene akışı"
            description={
              isDoctor ? "Size atanmış hastalar, saat sırasıyla" : "Yetkili olduğunuz şubeler, saat sırasıyla"
            }
            action={
              <Link href="/operations/today" className="btn-ghost btn-sm">
                Tümünü gör
                <Icon name="chevronRight" className="size-4" />
              </Link>
            }
            flush
            className="lg:col-span-2"
          >
            {flow.length === 0 ? (
              <div className="px-5 pb-5">
                <EmptyState title="Bugün için randevu yok" icon="calendar">
                  Yeni randevular burada saat sırasıyla görünür.
                </EmptyState>
              </div>
            ) : (
              <ol className="divide-y divide-slate-100 border-t border-line dark:divide-line-dark dark:border-line-dark">
                {flow.slice(0, 8).map((a) => {
                  const isNext = nextUp?.id === a.id;
                  return (
                    <li key={a.id}>
                      <Link
                        href={`/appointments/${a.id}`}
                        className={`flex items-center gap-4 px-5 py-3 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:shadow-focus dark:hover:bg-white/[0.02] ${isNext ? "bg-brand-50/60 dark:bg-brand-500/5" : ""}`}
                      >
                        <div className="w-14 shrink-0 text-right">
                          <p className="text-sm font-semibold tabular-nums">{a.localStart}</p>
                          <p className="text-xs tabular-nums text-slate-400">{a.localEnd}</p>
                        </div>
                        <span
                          aria-hidden="true"
                          className={`h-9 w-[3px] shrink-0 rounded-full ${isNext ? "bg-brand-500" : "bg-slate-200 dark:bg-line-dark"}`}
                        />
                        <Avatar name={a.patient.name} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {a.patient.name}
                            {isNext ? (
                              <span className="ml-2 rounded-full bg-brand-600 px-2 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-white">
                                Sıradaki
                              </span>
                            ) : null}
                          </p>
                          <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                            {a.service?.name ?? "Muayene"}
                            {isDoctor ? "" : ` · ${a.doctor.name}`}
                            {a.room ? ` · ${a.room.name}` : ""}
                          </p>
                        </div>
                        <AppointmentStatusBadge status={a.status} />
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </SectionCard>
        ) : null}

        {notes ? (
          <SectionCard
            title="Son etkinlikler"
            description={notes.unread ? `${notes.unread} okunmamış bildirim` : "Tüm bildirimler okundu"}
            action={
              <Link
                href="/notifications"
                className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
              >
                Tümü
              </Link>
            }
          >
            {notes.items.length ? (
              <ActivityFeed
                items={notes.items.map((n) => ({
                  id: n.id,
                  title: n.title,
                  context: n.context,
                  severity: n.severity,
                  href: n.href,
                  at: timeAgo(n.createdAt),
                  unread: n.status === "UNREAD",
                }))}
              />
            ) : (
              <EmptyState title="Henüz etkinlik yok" icon="bell" />
            )}
          </SectionCard>
        ) : null}
      </div>

      {/* Bana atanmış işler */}
      {myTasks && taskCounts ? (
        <SectionCard
          title="Bana atanmış işler"
          description={`${taskCounts.open} açık · ${taskCounts.overdue} geciken · ${taskCounts.today} bugün`}
          className="animate-enter [animation-delay:160ms]"
          action={
            <Link href="/tasks" className="btn-ghost btn-sm">
              Tümü
              <Icon name="chevronRight" className="size-4" />
            </Link>
          }
        >
          <TaskList tasks={myTasks} empty="Size atanmış açık görev yok" />
        </SectionCard>
      ) : null}

      {/* Hızlı işlemler + güvenlik + asistan */}
      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard title="Hızlı işlemler" className="lg:col-span-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {quick
              .filter((q) => q.show)
              .map((q) => (
                <Link
                  key={q.href}
                  href={q.href}
                  className="group flex min-h-[72px] items-center gap-3 rounded-xl border border-line p-3 text-[13px] font-medium transition-[border-color,background-color,transform] duration-150 hover:-translate-y-px hover:border-brand-300 hover:bg-brand-50/50 focus-visible:outline-none focus-visible:shadow-focus dark:border-line-dark dark:hover:border-brand-700 dark:hover:bg-brand-500/5"
                >
                  <span className="stat-icon bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-600 group-hover:text-white dark:bg-brand-500/10 dark:text-brand-300">
                    <Icon name={q.icon} className="size-[18px]" />
                  </span>
                  <span>{q.label}</span>
                </Link>
              ))}
          </div>
        </SectionCard>

        <div className="grid content-start gap-6">
          <SectionCard title="Hesap güvenliği">
            {ctx.user.twoFactorEnabled ? (
              <div className="flex items-center gap-3">
                <span className="stat-icon bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                  <Icon name="shield" className="size-[18px]" />
                </span>
                <div>
                  <p className="text-sm font-medium">İki adımlı doğrulama etkin</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Hesabınız ek güvenlik katmanıyla korunuyor.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <span
                  className={`stat-icon ${mfaRecommended ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" : "bg-slate-100 text-slate-500 dark:bg-white/5"}`}
                >
                  <Icon name="shield" className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">İki adımlı doğrulama kapalı</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {mfaRecommended
                      ? "Rolünüz hasta verisine eriştiği için etkinleştirmeniz önerilir."
                      : "Hesabınızı ek bir doğrulama adımıyla koruyabilirsiniz."}
                  </p>
                  <Link href="/settings/security" className="btn-ghost btn-sm mt-3">
                    Etkinleştir
                  </Link>
                </div>
              </div>
            )}
          </SectionCard>
          {hasPermission(ctx, "voice.use") && profile.voiceEnabled ? (
            <div className="card relative overflow-hidden border-brand-200 bg-gradient-to-br from-brand-50 to-white dark:border-brand-800 dark:from-brand-500/10 dark:to-surface-dark">
              <div className="flex items-start gap-3">
                <span className="stat-icon bg-brand-600 text-white">
                  <Icon name="sparkle" className="size-[18px]" />
                </span>
                <div>
                  <p className="text-sm font-semibold">Kliniva AI asistanı</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    Sağ alttaki asistana yazarak veya konuşarak randevu, müsaitlik ve stok sorabilirsiniz.
                    Değişiklikler her zaman açık onayınızla yapılır.
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SourcesCard({ stats }: { stats: { total: number; items: { name: string; count: number }[] } }) {
  return (
    <SectionCard
      title="Hasta kaynakları"
      description={`Son 90 gün · ${stats.total} ziyaret`}
      className="animate-enter [animation-delay:200ms]"
    >
      {stats.total ? (
        <DonutChart items={stats.items} label="Hasta kaynaklarının dağılımı" />
      ) : (
        <EmptyState title="Son 90 günde ziyaret yok" icon="patients" />
      )}
    </SectionCard>
  );
}

function FinanceSection({
  finance: f,
  balances,
}: {
  finance: FinanceDashboard;
  balances: { rows: OpenBalanceRow[]; patients: number; total: MoneyByCurrency } | null;
}) {
  const income6 = f.months.reduce((s, m) => s + m.incomeMinor, 0);
  const expense6 = f.months.reduce((s, m) => s + m.expenseMinor, 0);
  const thisMonth = f.months[f.months.length - 1];
  const monthNet = thisMonth ? thisMonth.incomeMinor - thisMonth.expenseMinor : 0;
  return (
    <>
      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Gelir ve gider"
          description={`Son 6 ay (TRY) · gelir ${formatMoney(income6)} · gider ${formatMoney(expense6)} · bu ay net ${formatMoney(monthNet)}`}
          className="animate-enter lg:col-span-2 [animation-delay:120ms]"
          action={
            <Link href="/finance/cash" className="btn-ghost btn-sm">
              Kasa
              <Icon name="chevronRight" className="size-4" />
            </Link>
          }
        >
          <IncomeExpenseLegend />
          <div className="mt-2">
            <ClientOnly
              fallback={
                <div className="aspect-[720/220] w-full animate-pulse rounded-lg bg-slate-100 dark:bg-white/5" />
              }
            >
              <IncomeExpenseChart data={f.months} />
            </ClientOnly>
          </div>
        </SectionCard>
        <SectionCard
          title="En çok ciro yapan hizmetler"
          description="Son 90 gün, hizmet bedeline göre"
          className="animate-enter [animation-delay:180ms]"
        >
          {f.topServices.length ? (
            <TopServices items={f.topServices} />
          ) : (
            <EmptyState title="Henüz hizmet bedeli yok" icon="receipt">
              Hizmetlere fiyat girildiğinde tamamlanan randevular burada görünür.
            </EmptyState>
          )}
        </SectionCard>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        {balances && balances.rows.length ? (
          <SectionCard
            className="lg:col-span-3"
            title="Açık bakiyeler"
            description={`${balances.patients} hastada tahsil edilmemiş tutar · ${formatMoneyMap(balances.total)}`}
            flush
            action={
              <Link href="/finance/balances" className="btn-ghost btn-sm">
                Tümü
                <Icon name="chevronRight" className="size-4" />
              </Link>
            }
          >
            <ul className="divide-y divide-slate-100 border-t border-line dark:divide-line-dark dark:border-line-dark">
              {balances.rows.map((r) => (
                <li key={r.patientId}>
                  <Link
                    href={`/patients/${r.patientId}?tab=account`}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:shadow-focus dark:hover:bg-white/[0.02]"
                  >
                    <Avatar name={r.patientName} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.patientName}</span>
                      <span className="block text-xs text-slate-500">{r.phoneMasked}</span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                      {formatMoneyMap(r.balance)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </SectionCard>
        ) : null}
      </div>
    </>
  );
}
