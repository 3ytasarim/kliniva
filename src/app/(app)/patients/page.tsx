import type { Metadata } from "next";
import Link from "next/link";
import { Ellipsis, FileText, Pencil, Plus, Search, UserRound } from "lucide-react";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getPatientListSummary, listPatients } from "@/server/services/patients";
import { listPatientLookups } from "@/server/services/patient-lookups";
import { STAGGER } from "@/components/dashboard-widgets";
import { formatMoney } from "@/lib/money";
import { PATIENT_SEGMENTS } from "@/types/patients";
import { accessibleBranchOptions } from "@/server/services/org";
import { Forbidden } from "@/components/forbidden";
import { Avatar, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PrivacyBadge, formatDateTime } from "@/components/patient-ui";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Hastalar" };

type Search = {
  q?: string;
  branch?: string;
  status?: string;
  page?: string;
  segment?: string;
  source?: string;
};

const dateFmt = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const relDays = (d: Date) => {
  const days = Math.round((Date.now() - d.getTime()) / 86_400_000);
  return days <= 0
    ? "bugün"
    : days === 1
      ? "dün"
      : days < 30
        ? `${days} gün önce`
        : days < 365
          ? `${Math.round(days / 30)} ay önce`
          : `${Math.round(days / 365)} yıl önce`;
};

const STATUS_TABS = [
  ["active", "Aktif"],
  ["inactive", "Pasif"],
  ["all", "Tümü"],
] as const;

/**
 * Hasta listesi — sunucu tarafı arama + sayfalama (varsayılan 25). Minimum veri: maskeli telefon; sağlık verisi
 * listede asla yer almaz. KVKK durumu belgelerden türetilir.
 */
export default async function PatientsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "patient.read")) return <Forbidden />;
  const sp = await searchParams;
  const status = sp.status === "inactive" || sp.status === "all" ? sp.status : "active";
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const branches = hasPermission(ctx, "branch.read") ? await accessibleBranchOptions(ctx) : [];
  const canBilling = hasPermission(ctx, "billing.read");
  const segments = PATIENT_SEGMENTS.filter((x) => x.key !== "balance" || canBilling);
  const segment = segments.find((x) => x.key === sp.segment)?.key;
  const [summary, sources] = await Promise.all([
    getPatientListSummary(ctx),
    listPatientLookups(ctx, { kind: "SOURCE" }),
  ]);
  const sourceId = sources.some((x) => x.id === sp.source) ? sp.source : undefined;

  let result: Awaited<ReturnType<typeof listPatients>> = { items: [], total: 0, page, limit: 25 };
  let searchError: string | null = null;
  try {
    result = await listPatients(ctx, { q: sp.q, branchId: sp.branch, status, page, segment, sourceId });
  } catch (e) {
    if (isAppError(e) && e.code === "VALIDATION") searchError = e.message;
    else throw e;
  }
  const pages = Math.max(Math.ceil(result.total / result.limit), 1);
  const qs = (p: number, st: string = status, seg: string | undefined = segment) => {
    const u = new URLSearchParams();
    if (sp.q) u.set("q", sp.q);
    if (sp.branch) u.set("branch", sp.branch);
    if (sourceId) u.set("source", sourceId);
    if (seg) u.set("segment", seg);
    if (st !== "active") u.set("status", st);
    if (p > 1) u.set("page", String(p));
    const q = u.toString();
    return q ? `/patients?${q}` : "/patients";
  };
  const canEdit = hasPermission(ctx, "patient.update");
  const canDocs = hasPermission(ctx, "patient.document.read");

  return (
    <section>
      <PageHeader
        title="Hastalar"
        description={`${result.total} kayıt${sp.q ? ` · “${sp.q}” araması` : ""}`}
        actions={
          hasPermission(ctx, "patient.create") ? (
            <Button asChild>
              <Link href="/patients/new">
                <Plus />
                Yeni hasta
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Hasta özeti">
        {[
          {
            label: "Aktif hasta",
            value: String(summary.total),
            href: qs(1, status, undefined),
            tone: "text-slate-900 dark:text-white",
          },
          {
            label: "Yaklaşan randevulu",
            value: String(summary.upcoming),
            href: qs(1, status, "upcoming"),
            tone: "text-brand-700 dark:text-brand-300",
          },
          {
            label: "Bu ay kayıt",
            value: String(summary.newThisMonth),
            href: qs(1, status, "new_month"),
            tone: "text-violet-700 dark:text-violet-300",
          },
          summary.openBalance
            ? {
                label: `Açık bakiyeli · ${formatMoney(summary.openBalance.totalMinor)}`,
                value: String(summary.openBalance.patients),
                href: qs(1, status, "balance"),
                tone: "text-rose-700 dark:text-rose-300",
              }
            : {
                label: "90+ gündür gelmeyen",
                value: String(summary.lapsed),
                href: qs(1, status, "lapsed"),
                tone: "text-amber-700 dark:text-amber-300",
              },
        ].map((c, i) => (
          <Link
            key={c.label}
            href={c.href}
            className={cn("card card-link animate-enter p-4", STAGGER[i])}
            data-testid="patient-summary"
          >
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{c.label}</p>
            <p className={cn("mt-1 text-2xl font-semibold tabular-nums", c.tone)}>{c.value}</p>
          </Link>
        ))}
      </div>

      <nav aria-label="Segmentler" className="mb-4 flex flex-wrap gap-2">
        {[{ key: undefined as string | undefined, label: "Tümü" }, ...segments].map((x) => (
          <Link
            key={x.key ?? "all"}
            href={qs(1, status, x.key)}
            aria-current={segment === x.key ? "page" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus",
              segment === x.key
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-line bg-white text-slate-600 hover:border-brand-300 hover:text-brand-700 dark:border-line-dark dark:bg-surface-dark dark:text-slate-300",
            )}
          >
            {x.label}
          </Link>
        ))}
      </nav>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form role="search" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {status !== "active" ? <input type="hidden" name="status" value={status} /> : null}
          {segment ? <input type="hidden" name="segment" value={segment} /> : null}
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <label htmlFor="q" className="sr-only">
              Ara
            </label>
            <input
              id="q"
              name="q"
              defaultValue={sp.q ?? ""}
              placeholder="Ad, soyad, hasta no, telefon veya e-posta"
              className="input h-10 pl-9"
              minLength={2}
              maxLength={100}
            />
          </div>
          {branches.length > 1 ? (
            <div className="w-44 shrink-0">
              <label htmlFor="branch" className="sr-only">
                Şube
              </label>
              <select id="branch" name="branch" defaultValue={sp.branch ?? ""} className="input h-10 py-0">
                <option value="">Tüm şubeler</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {sources.length ? (
            <div className="w-44 shrink-0">
              <label htmlFor="source" className="sr-only">
                Hasta kaynağı
              </label>
              <select id="source" name="source" defaultValue={sourceId ?? ""} className="input h-10 py-0">
                <option value="">Tüm kaynaklar</option>
                {sources.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <Button type="submit" variant="outline" className="h-10 min-h-10">
            Filtrele
          </Button>
        </form>
        <nav
          aria-label="Durum"
          className="inline-flex h-10 items-center gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-white/5"
        >
          {STATUS_TABS.map(([v, l]) => (
            <Link
              key={v}
              href={qs(1, v)}
              aria-current={status === v ? "page" : undefined}
              className={cn(
                "inline-flex h-9 items-center rounded-md px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus",
                status === v
                  ? "bg-white text-slate-900 shadow-[0_1px_2px_rgb(16_24_40/0.08)] dark:bg-raised-dark dark:text-white"
                  : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white",
              )}
            >
              {l}
            </Link>
          ))}
        </nav>
      </div>

      {searchError ? (
        <p role="alert" className="mb-4 text-sm text-red-700 dark:text-red-400">
          {searchError}
        </p>
      ) : null}

      {result.items.length === 0 ? (
        <EmptyState title={sp.q ? "Aramayla eşleşen hasta yok" : "Henüz hasta yok"} icon="patients">
          {hasPermission(ctx, "patient.create") ? (
            <Link href="/patients/new" className="font-medium text-brand-700 dark:text-brand-300">
              İlk hastayı kaydedin
            </Link>
          ) : null}
        </EmptyState>
      ) : (
        <div className="card overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Hasta</th>
                  <th scope="col">Telefon</th>
                  <th scope="col">Son ziyaret</th>
                  <th scope="col">Sonraki randevu</th>
                  {canBilling ? (
                    <th scope="col" className="text-right">
                      Bakiye
                    </th>
                  ) : null}
                  <th scope="col">KVKK</th>
                  <th scope="col">Durum</th>
                  <th scope="col" className="w-12">
                    <span className="sr-only">İşlemler</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((p) => {
                  const name = `${p.firstName} ${p.lastName}`;
                  return (
                    <tr key={p.id}>
                      <td className="align-middle">
                        <div className="flex min-w-48 items-center gap-3">
                          <Avatar name={name} size="sm" />
                          <div className="min-w-0">
                            <Link
                              href={`/patients/${p.id}`}
                              className="block truncate font-medium text-slate-900 hover:text-brand-700 dark:text-slate-100 dark:hover:text-brand-300"
                            >
                              {name}
                            </Link>
                            <p className="text-[11px] text-slate-400">
                              <span className="font-mono">{p.patientNumber}</span>
                              {p.sourceName ? ` · ${p.sourceName}` : ""}
                              {p.primaryBranchName && branches.length > 1 ? ` · ${p.primaryBranchName}` : ""}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap align-middle font-mono text-xs text-slate-600 dark:text-slate-300">
                        {p.phoneMasked}
                      </td>
                      <td className="whitespace-nowrap align-middle text-xs">
                        {p.lastVisitAt ? (
                          <>
                            <span className="font-medium text-slate-700 dark:text-slate-200">
                              {dateFmt.format(p.lastVisitAt)}
                            </span>
                            <span className="block text-slate-500">
                              {relDays(p.lastVisitAt)} · {p.visitCount} ziyaret
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-400">Ziyaret yok</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap align-middle text-xs">
                        {p.nextAppointmentAt ? (
                          <span className="font-medium text-brand-700 dark:text-brand-300">
                            {formatDateTime(p.nextAppointmentAt)}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      {canBilling ? (
                        <td
                          className={cn(
                            "whitespace-nowrap text-right align-middle text-sm font-semibold tabular-nums",
                            (p.balanceMinor ?? 0) > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-400",
                          )}
                        >
                          {(p.balanceMinor ?? 0) > 0 ? formatMoney(p.balanceMinor!) : "Borcu yok"}
                        </td>
                      ) : null}
                      <td className="align-middle">
                        <PrivacyBadge status={p.privacyStatus} />
                      </td>
                      <td className="align-middle">
                        <StatusBadge active={p.active} />
                      </td>
                      <td className="text-right align-middle">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`${name} işlemleri`}>
                              <Ellipsis />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem asChild>
                              <Link href={`/patients/${p.id}`}>
                                <UserRound />
                                Görüntüle
                              </Link>
                            </DropdownMenuItem>
                            {canEdit ? (
                              <DropdownMenuItem asChild>
                                <Link href={`/patients/${p.id}/edit`}>
                                  <Pencil />
                                  Düzenle
                                </Link>
                              </DropdownMenuItem>
                            ) : null}
                            {canDocs ? (
                              <DropdownMenuItem asChild>
                                <Link href={`/patients/${p.id}?tab=documents`}>
                                  <FileText />
                                  Belgeler
                                </Link>
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <nav
              aria-label="Sayfalama"
              className="flex items-center justify-between border-t border-line px-4 py-3 text-sm dark:border-line-dark"
            >
              <span className="text-slate-500">
                Sayfa {result.page} / {pages}
              </span>
              <div className="flex gap-2">
                {result.page > 1 ? (
                  <Link href={qs(result.page - 1)} className="btn-ghost btn-sm">
                    ← Önceki
                  </Link>
                ) : null}
                {result.page < pages ? (
                  <Link href={qs(result.page + 1)} className="btn-ghost btn-sm">
                    Sonraki →
                  </Link>
                ) : null}
              </div>
            </nav>
          ) : null}
        </div>
      )}
    </section>
  );
}
