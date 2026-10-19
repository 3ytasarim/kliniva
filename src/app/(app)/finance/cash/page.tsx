import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { isAppError } from "@/server/errors";
import { getCashSummary, listCashCategories, listCashTransactions } from "@/server/services/cash";
import { listBranches } from "@/server/services/org";
import {
  createCashCategoryAction,
  createCashEntryAction,
  toggleCashCategoryAction,
  voidCashAction,
} from "@/app/actions/finance";
import { ActionForm, Field, InlineAction, SelectField } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { EmptyState, Icon, PageHeader, SectionCard } from "@/components/ui";
import { formatDateTime } from "@/components/patient-ui";
import { formatMoney, formatMoneyMap } from "@/lib/money";
import { cn } from "@/lib/cn";
import {
  CURRENCIES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type CashPeriodTotals,
  type MoneyByCurrency,
} from "@/types/finance";

export const metadata: Metadata = { title: "Kasa" };

const PERIODS = [
  { key: "week", label: "Son 7 gün" },
  { key: "month", label: "Bu ay" },
  { key: "year", label: "Bu yıl" },
  { key: "all", label: "Toplam" },
] as const;

function net(t: CashPeriodTotals): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const c of CURRENCIES) {
    const v = (t.income[c] ?? 0) - (t.expense[c] ?? 0);
    if (v) out[c] = v;
  }
  return out;
}

/**
 * Kasa: gelir / gider hareketleri (hasta tahsilatları dahil), dönem özetleri ve kategoriler. Kayıtlar silinmez;
 * yanlış kayıt gerekçeyle iptal edilir. Para birimleri ayrı toplanır (kur çevrimi yok).
 */
export default async function CashPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; from?: string; to?: string; page?: string }>;
}) {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "cash.read")) return <Forbidden />;
  const sp = await searchParams;
  const canManage = hasPermission(ctx, "cash.manage");
  const canVoidPayment = hasPermission(ctx, "billing.void");
  const filter = { kind: sp.kind ?? "", from: sp.from ?? "", to: sp.to ?? "", page: sp.page ?? "1" };
  let list: Awaited<ReturnType<typeof listCashTransactions>>;
  try {
    list = await listCashTransactions(ctx, filter);
  } catch (e) {
    if (!isAppError(e) || e.code !== "VALIDATION") throw e;
    list = await listCashTransactions(ctx, {});
  }
  const [summary, categories, branchList] = await Promise.all([
    getCashSummary(ctx),
    listCashCategories(ctx),
    canManage && hasPermission(ctx, "branch.read") ? listBranches(ctx) : Promise.resolve([]),
  ]);
  const activeBranches = branchList.filter((b) => b.active);
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const qs = (page: number) => {
    const p = new URLSearchParams();
    if (filter.kind) p.set("kind", filter.kind);
    if (filter.from) p.set("from", filter.from);
    if (filter.to) p.set("to", filter.to);
    if (page > 1) p.set("page", String(page));
    const s = p.toString();
    return s ? `/finance/cash?${s}` : "/finance/cash";
  };

  return (
    <section className="grid gap-6">
      <PageHeader
        eyebrow="Finans"
        title="Kasa"
        description="Hasta tahsilatları, diğer gelirler ve giderler. Kayıtlar silinmez; yanlış kayıt gerekçeyle iptal edilir."
        actions={
          hasPermission(ctx, "billing.read") ? (
            <Link href="/finance/balances" className="btn-ghost btn-sm">
              Açık bakiyeler
            </Link>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {PERIODS.map((p, i) => {
          const t = summary[p.key];
          const n = net(t);
          return (
            <div
              key={p.key}
              className="card animate-enter p-4"

              data-testid={`cash-period-${p.key}`}
            >
              <p className={cn("eyebrow", i === 0 && "text-brand-700 dark:text-brand-300")}>{p.label}</p>
              <dl className="mt-3 grid gap-1.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <dt className="flex items-center gap-1.5 text-slate-500">
                    <Icon name="trendUp" className="size-3.5 text-emerald-600" /> Gelir
                  </dt>
                  <dd className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {formatMoneyMap(t.income)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="flex items-center gap-1.5 text-slate-500">
                    <Icon name="trendDown" className="size-3.5 text-red-600" /> Gider
                  </dt>
                  <dd className="font-semibold tabular-nums text-red-700 dark:text-red-400">
                    {formatMoneyMap(t.expense)}
                  </dd>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 border-t border-line pt-2 dark:border-line-dark">
                  <dt className="font-medium">Net</dt>
                  <dd className="text-base font-semibold tabular-nums">{formatMoneyMap(n)}</dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>

      {canManage ? (
        <SectionCard
          title="Gelir / gider kaydı"
          description="Kira, personel, malzeme alımı gibi hastasız hareketler. Hasta tahsilatı hasta hesabından alınır."
        >
          <ActionForm
            action={createCashEntryAction}
            submitLabel="Kaydet"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <SelectField
              label="Tür"
              name="kind"
              required
              defaultValue="EXPENSE"
              options={[
                { value: "EXPENSE", label: "Gider" },
                { value: "INCOME", label: "Gelir" },
              ]}
              idPrefix="ce"
            />
            <Field
              label="Tutar"
              name="amount"
              required
              inputMode="decimal"
              placeholder="örn. 3.500"
              idPrefix="ce"
            />
            <SelectField
              label="Para birimi"
              name="currency"
              defaultValue="TRY"
              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
              idPrefix="ce"
            />
            <SelectField
              label="Ödeme yöntemi"
              name="method"
              required
              defaultValue="TRANSFER"
              options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))}
              idPrefix="ce"
            />
            <SelectField
              label="Kategori"
              name="categoryId"
              placeholder="— Kategorisiz —"
              options={categories
                .filter((c) => c.active)
                .map((c) => ({
                  value: c.id,
                  label: `${c.kind === "INCOME" ? "Gelir" : "Gider"} · ${c.name}`,
                }))}
              idPrefix="ce"
            />
            {activeBranches.length > 1 ? (
              <SelectField
                label="Şube"
                name="branchId"
                required
                options={activeBranches.map((b) => ({ value: b.id, label: b.name }))}
                idPrefix="ce"
              />
            ) : activeBranches[0] ? (
              <input type="hidden" name="branchId" value={activeBranches[0].id} />
            ) : null}
            <Field label="Tarih" name="date" type="date" hint="Boşsa bugün." idPrefix="ce" />
            <Field
              label="Açıklama"
              name="description"
              maxLength={300}
              idPrefix="ce"
              className="lg:col-span-2"
            />
          </ActionForm>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Hareketler"
        description={`${list.total} kayıt`}
        flush
        action={
          <form className="flex flex-wrap items-end gap-2" aria-label="Kasa filtresi">
            <div>
              <label htmlFor="cf-kind" className="sr-only">
                Tür
              </label>
              <select id="cf-kind" name="kind" defaultValue={filter.kind} className="input min-h-9 py-1.5">
                <option value="">Tümü</option>
                <option value="INCOME">Gelir</option>
                <option value="EXPENSE">Gider</option>
              </select>
            </div>
            <div>
              <label htmlFor="cf-from" className="sr-only">
                Başlangıç tarihi
              </label>
              <input
                id="cf-from"
                name="from"
                type="date"
                defaultValue={filter.from}
                className="input min-h-9 py-1.5"
              />
            </div>
            <div>
              <label htmlFor="cf-to" className="sr-only">
                Bitiş tarihi
              </label>
              <input
                id="cf-to"
                name="to"
                type="date"
                defaultValue={filter.to}
                className="input min-h-9 py-1.5"
              />
            </div>
            <button type="submit" className="btn-ghost btn-sm">
              Filtrele
            </button>
          </form>
        }
      >
        {list.rows.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyState title="Kayıt yok" icon="cash">
              Seçili filtrede kasa hareketi bulunmuyor.
            </EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Tür</th>
                  <th>Açıklama</th>
                  <th>Yöntem</th>
                  <th>Şube</th>
                  <th className="text-right">Tutar</th>
                  <th>
                    <span className="sr-only">İşlem</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => {
                  const canVoid = r.status === "ACTIVE" && (r.patientName ? canVoidPayment : canManage);
                  return (
                    <tr
                      key={r.id}
                      className={cn(r.status === "VOIDED" && "opacity-60")}
                      data-testid="cash-row"
                    >
                      <td className="whitespace-nowrap">{formatDateTime(r.occurredAt)}</td>
                      <td>
                        {r.kind === "INCOME" ? (
                          <span className="badge badge-green">Gelir</span>
                        ) : (
                          <span className="badge badge-red">Gider</span>
                        )}
                        {r.status === "VOIDED" ? <span className="badge badge-gray ml-1">İptal</span> : null}
                      </td>
                      <td className="min-w-48">
                        <span className="font-medium">
                          {r.patientName ? (
                            r.patientId ? (
                              <Link
                                href={`/patients/${r.patientId}?tab=account`}
                                className="hover:text-brand-700"
                              >
                                {r.patientName}
                              </Link>
                            ) : (
                              r.patientName
                            )
                          ) : (
                            (r.categoryName ?? "Kategorisiz")
                          )}
                        </span>
                        <span className="block text-xs text-slate-500">
                          {r.patientName ? "Hasta tahsilatı" : null}
                          {r.description ? `${r.patientName ? " · " : ""}${r.description}` : null}
                          {` · ${r.createdByName}`}
                        </span>
                        {r.voidReason ? (
                          <span className="block text-xs text-red-600">İptal: {r.voidReason}</span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap">{PAYMENT_METHOD_LABELS[r.method]}</td>
                      <td className="whitespace-nowrap">{r.branchName}</td>
                      <td
                        className={cn(
                          "whitespace-nowrap text-right font-semibold tabular-nums",
                          r.kind === "INCOME"
                            ? "text-emerald-700 dark:text-emerald-400"
                            : "text-red-700 dark:text-red-400",
                          r.status === "VOIDED" && "line-through",
                        )}
                      >
                        {r.kind === "INCOME" ? "+" : "−"}
                        {formatMoney(r.amountMinor, r.currency)}
                      </td>
                      <td>
                        {canVoid ? (
                          <details className="relative">
                            <summary className="cursor-pointer whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10">
                              İptal et
                            </summary>
                            <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-line bg-white p-3 shadow-raised dark:border-line-dark dark:bg-surface-dark">
                              <ActionForm
                                action={voidCashAction}
                                submitLabel="İptali onayla"
                                className="grid gap-2"
                              >
                                <input type="hidden" name="id" value={r.id} />
                                <Field
                                  label="İptal gerekçesi"
                                  name="reason"
                                  required
                                  minLength={3}
                                  maxLength={300}
                                  hint="Kayıt silinmez; gerekçesiyle iptal görünür."
                                  idPrefix={`cv-${r.id.slice(0, 8)}`}
                                />
                              </ActionForm>
                            </div>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 ? (
          <nav aria-label="Sayfalar" className="flex items-center justify-between gap-2 px-5 py-3 text-sm">
            <span className="text-slate-500">
              Sayfa {list.page} / {pages}
            </span>
            <span className="flex gap-2">
              {list.page > 1 ? (
                <Link href={qs(list.page - 1)} className="btn-ghost btn-sm">
                  Önceki
                </Link>
              ) : null}
              {list.page < pages ? (
                <Link href={qs(list.page + 1)} className="btn-ghost btn-sm">
                  Sonraki
                </Link>
              ) : null}
            </span>
          </nav>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Kasa kategorileri"
        description="Gelir ve gider kalemlerini gruplar (ör. Kira, Personel)."
      >
        {categories.length === 0 ? (
          <p className="hint mb-3">Henüz kategori yok.</p>
        ) : (
          <ul className="mb-4 flex flex-wrap gap-2">
            {categories.map((c) => (
              <li
                key={c.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm dark:border-line-dark",
                  !c.active && "opacity-60",
                )}
              >
                <span className={cn("badge", c.kind === "INCOME" ? "badge-green" : "badge-red")}>
                  {c.kind === "INCOME" ? "Gelir" : "Gider"}
                </span>
                {c.name}
                {canManage ? (
                  <InlineAction
                    action={toggleCashCategoryAction}
                    fields={{ id: c.id, active: String(!c.active) }}
                    label={c.active ? "Pasifleştir" : "Etkinleştir"}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <ActionForm
            action={createCashCategoryAction}
            submitLabel="Kategori ekle"
            className="flex flex-wrap items-end gap-3"
          >
            <Field label="Kategori adı" name="name" required maxLength={60} idPrefix="cc" />
            <SelectField
              label="Tür"
              name="kind"
              defaultValue="EXPENSE"
              options={[
                { value: "EXPENSE", label: "Gider" },
                { value: "INCOME", label: "Gelir" },
              ]}
              idPrefix="cc"
            />
          </ActionForm>
        ) : null}
      </SectionCard>
    </section>
  );
}
