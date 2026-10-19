import "server-only";
import { z } from "zod";
import { and, asc, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { branches, cashCategories, cashTransactions, clinicProfiles, patients } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import {
  actorOf,
  branchFilter,
  hasPermission,
  requireBranchAccess,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { uuidSchema } from "@/server/validation";
import { listOpenBalances } from "@/server/services/billing";
import { addMoney, parseMoneyInput } from "@/lib/money";
import { DEFAULT_TIMEZONE, addDays, dateInZone, isValidDate, zonedDateTimeToUtc } from "@/lib/time";
import {
  CURRENCIES,
  PAYMENT_METHODS,
  type CashCategory,
  type CashKind,
  type CashPeriodTotals,
  type CashTransactionRow,
  type Currency,
  type FinanceDashboard,
  type MoneyByCurrency,
} from "@/types/finance";

/**
 * KASA — gelir / gider hareketleri ve kategoriler. Hasta tahsilatları billing.ts'den gelir (INCOME + hasta);
 * burada hastasız gelir / gider girilir (kira, personel, malzeme alımı…). İptal billing.voidCashTransaction ile.
 * Dönemler klinik saat diliminde hesaplanır. Para birimleri arasında kur çevrimi YAPILMAZ (ayrı toplanır).
 */
const kindSchema = z.enum(["INCOME", "EXPENSE"]);

const categoryInput = z.object({
  name: z.string().trim().min(2, "En az 2 karakter.").max(60),
  kind: kindSchema,
  active: z.preprocess(
    (v) => (v === undefined ? true : v === true || v === "on" || v === "true"),
    z.boolean(),
  ),
});

const entryInput = z.object({
  kind: kindSchema,
  branchId: z.preprocess((v) => (v === "" ? undefined : v), uuidSchema.optional()),
  categoryId: z.preprocess((v) => (v === "" || v === null ? undefined : v), uuidSchema.optional()),
  method: z.enum(PAYMENT_METHODS),
  amount: z.preprocess(
    (v) => parseMoneyInput(v),
    z
      .number({ message: "Geçerli bir tutar girin." })
      .int()
      .min(1, "Tutar sıfırdan büyük olmalı.")
      .max(1_000_000_000),
  ),
  currency: z.enum(CURRENCIES).default("TRY"),
  /** YYYY-MM-DD (klinik saat dilimi); boş → şimdi. */
  date: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().refine(isValidDate, "Geçerli bir tarih girin.").optional(),
  ),
  description: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(300).optional(),
  ),
});

const listInput = z.object({
  kind: z.preprocess((v) => (v === "" ? undefined : v), kindSchema.optional()),
  from: z.preprocess((v) => (v === "" ? undefined : v), z.string().refine(isValidDate).optional()),
  to: z.preprocess((v) => (v === "" ? undefined : v), z.string().refine(isValidDate).optional()),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export const CASH_PAGE_SIZE = 25;

async function clinicTz(scope: TenantScope): Promise<string> {
  const [p] = await scope.tx
    .select({ tz: clinicProfiles.timezone })
    .from(clinicProfiles)
    .where(tenantWhere(clinicProfiles, scope));
  return p?.tz ?? DEFAULT_TIMEZONE;
}

const dayStart = (date: string, tz: string) => zonedDateTimeToUtc(date, 0, tz);

// ---------------------------------------------------------------- kategoriler

export async function listCashCategories(ctx: AuthContext): Promise<CashCategory[]> {
  requirePermission(ctx, "cash.read");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({
        id: cashCategories.id,
        name: cashCategories.name,
        kind: cashCategories.kind,
        active: cashCategories.active,
      })
      .from(cashCategories)
      .where(tenantWhere(cashCategories, scope))
      .orderBy(asc(cashCategories.kind), asc(cashCategories.name)),
  );
}

const mapUnique = (e: unknown): never => {
  if (pgErrorInfo(e).code === PG_UNIQUE_VIOLATION) {
    throw new AppError("CONFLICT", { message: "Bu adla bir kategori zaten var." });
  }
  throw e;
};

export async function createCashCategory(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "cash.manage");
  const data = parseInput(categoryInput, input);
  return tenantQuery(ctx, async (scope) => {
    const [row] = await scope.tx
      .insert(cashCategories)
      .values({ tenantId: scope.tenantId, name: data.name, kind: data.kind, active: data.active })
      .returning({ id: cashCategories.id })
      .catch(mapUnique);
    await writeAudit(scope, actorOf(ctx), {
      action: "CASH_CATEGORY_CREATED",
      entityType: "cash_category",
      entityId: row!.id,
      metadata: { kind: data.kind },
    });
    return { id: row!.id };
  });
}

export async function setCashCategoryActive(
  ctx: AuthContext,
  rawId: unknown,
  active: boolean,
): Promise<void> {
  requirePermission(ctx, "cash.manage");
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  await tenantQuery(ctx, async (scope) => {
    const res = await scope.tx
      .update(cashCategories)
      .set({ active, updatedAt: new Date() })
      .where(tenantWhere(cashCategories, scope, eq(cashCategories.id, id.data)))
      .returning({ id: cashCategories.id });
    if (!res.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "CASH_CATEGORY_UPDATED",
      entityType: "cash_category",
      entityId: id.data,
      metadata: { active },
    });
  });
}

// ---------------------------------------------------------------- hareketler

/** Hastasız gelir / gider. Hasta tahsilatı için billing.recordPayment kullanılır. */
export async function createCashEntry(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "cash.manage");
  const data = parseInput(entryInput, input);
  return tenantQuery(ctx, async (scope) => {
    let branchId = data.branchId;
    if (!branchId && !ctx.branchScope.all && ctx.branchScope.branchIds.size === 1) {
      branchId = [...ctx.branchScope.branchIds][0];
    }
    if (!branchId) throw new AppError("VALIDATION", { fields: ["branchId"], message: "Şube seçin." });
    requireBranchAccess(ctx, branchId);
    const [b] = await scope.tx
      .select({ id: branches.id })
      .from(branches)
      .where(tenantWhere(branches, scope, eq(branches.id, branchId)));
    if (!b) throw new AppError("VALIDATION", { fields: ["branchId"], message: "Şube bulunamadı." });
    if (data.categoryId) {
      const [c] = await scope.tx
        .select({ kind: cashCategories.kind, active: cashCategories.active })
        .from(cashCategories)
        .where(tenantWhere(cashCategories, scope, eq(cashCategories.id, data.categoryId)));
      if (!c || !c.active)
        throw new AppError("VALIDATION", { fields: ["categoryId"], message: "Kategori bulunamadı." });
      if (c.kind !== data.kind) {
        throw new AppError("VALIDATION", {
          fields: ["categoryId"],
          message: "Kategori türü işlem türüyle uyuşmuyor.",
        });
      }
    }
    let occurredAt: Date | SQL = sql`now()`;
    if (data.date) {
      const tz = await clinicTz(scope);
      const today = dateInZone(new Date(), tz);
      if (data.date > today) {
        throw new AppError("VALIDATION", {
          fields: ["date"],
          message: "İleri tarihli kasa kaydı girilemez.",
        });
      }
      // Bugün → şimdiki an; geçmiş gün → o günün 12:00'si (klinik saatiyle).
      if (data.date !== today) occurredAt = zonedDateTimeToUtc(data.date, 12 * 60, tz);
    }
    const [row] = await scope.tx
      .insert(cashTransactions)
      .values({
        tenantId: scope.tenantId,
        branchId,
        kind: data.kind,
        categoryId: data.categoryId ?? null,
        method: data.method,
        amountMinor: data.amount,
        currency: data.currency,
        occurredAt,
        description: data.description ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: cashTransactions.id });
    await writeAudit(scope, actorOf(ctx), {
      action: "CASH_ENTRY_CREATED",
      entityType: "cash_transaction",
      entityId: row!.id,
      branchId,
      metadata: { kind: data.kind, amountMinor: data.amount, currency: data.currency, method: data.method },
    });
    return { id: row!.id };
  });
}

export async function listCashTransactions(
  ctx: AuthContext,
  input: unknown,
): Promise<{ rows: CashTransactionRow[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, "cash.read");
  const data = parseInput(listInput, input);
  return tenantQuery(ctx, async (scope) => {
    const tz = await clinicTz(scope);
    const conds: (SQL | undefined)[] = [
      branchFilter(ctx, cashTransactions.branchId),
      data.kind ? eq(cashTransactions.kind, data.kind) : undefined,
      data.from ? gte(cashTransactions.occurredAt, dayStart(data.from, tz)) : undefined,
      data.to ? lt(cashTransactions.occurredAt, dayStart(addDays(data.to, 1), tz)) : undefined,
    ];
    const where = tenantWhere(cashTransactions, scope, ...conds);
    const [countRow] = await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(cashTransactions)
      .where(where);
    const canSeePatients = hasPermission(ctx, "patient.read");
    const rows = await scope.tx
      .select({
        id: cashTransactions.id,
        occurredAt: cashTransactions.occurredAt,
        kind: cashTransactions.kind,
        categoryName: cashCategories.name,
        method: cashTransactions.method,
        amountMinor: cashTransactions.amountMinor,
        currency: cashTransactions.currency,
        description: cashTransactions.description,
        patientId: cashTransactions.patientId,
        firstName: patients.firstName,
        lastName: patients.lastName,
        branchName: branches.name,
        status: cashTransactions.status,
        createdByName: sql<string>`(select u.first_name || ' ' || u.last_name from kliniva.users u
          where u.tenant_id = ${cashTransactions.tenantId} and u.id = ${cashTransactions.createdByUserId})`,
        voidReason: cashTransactions.voidReason,
      })
      .from(cashTransactions)
      .innerJoin(
        branches,
        and(eq(branches.tenantId, cashTransactions.tenantId), eq(branches.id, cashTransactions.branchId)),
      )
      .leftJoin(
        cashCategories,
        and(
          eq(cashCategories.tenantId, cashTransactions.tenantId),
          eq(cashCategories.id, cashTransactions.categoryId),
        ),
      )
      .leftJoin(
        patients,
        and(eq(patients.tenantId, cashTransactions.tenantId), eq(patients.id, cashTransactions.patientId)),
      )
      .where(where)
      .orderBy(desc(cashTransactions.occurredAt), desc(cashTransactions.createdAt))
      .limit(CASH_PAGE_SIZE)
      .offset((data.page - 1) * CASH_PAGE_SIZE);
    return {
      total: countRow?.n ?? 0,
      page: data.page,
      pageSize: CASH_PAGE_SIZE,
      rows: rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        kind: r.kind as CashKind,
        categoryName: r.categoryName,
        method: r.method,
        amountMinor: r.amountMinor,
        currency: r.currency as Currency,
        description: r.description,
        // Hasta adı yalnızca hasta görme yetkisi olana (kasa görüntüleyen her rol hasta göremeyebilir).
        patientId: canSeePatients ? r.patientId : null,
        patientName: r.patientId
          ? canSeePatients
            ? `${r.firstName} ${r.lastName}`
            : "Hasta tahsilatı"
          : null,
        branchName: r.branchName,
        status: r.status,
        createdByName: r.createdByName,
        voidReason: r.voidReason,
      })),
    };
  });
}

/** Kasa özet kutuları: son 7 gün / bu ay / bu yıl / tümü — gelir ve gider, para birimi bazında (aktif kayıtlar). */
export async function getCashSummary(ctx: AuthContext): Promise<{
  week: CashPeriodTotals;
  month: CashPeriodTotals;
  year: CashPeriodTotals;
  all: CashPeriodTotals;
}> {
  requirePermission(ctx, "cash.read");
  return tenantQuery(ctx, async (scope) => {
    const tz = await clinicTz(scope);
    const today = dateInZone(new Date(), tz);
    const weekFrom = dayStart(addDays(today, -6), tz);
    const monthFrom = dayStart(`${today.slice(0, 8)}01`, tz);
    const yearFrom = dayStart(`${today.slice(0, 4)}-01-01`, tz);
    const bf = branchFilter(ctx, cashTransactions.branchId) ?? sql`true`;
    const res = await scope.tx.execute<{
      kind: CashKind;
      currency: Currency;
      week: string;
      month: string;
      year: string;
      total: string;
    }>(sql`
      select kind, currency,
             coalesce(sum(amount_minor) filter (where occurred_at >= ${weekFrom.toISOString()}::timestamptz), 0)::text as week,
             coalesce(sum(amount_minor) filter (where occurred_at >= ${monthFrom.toISOString()}::timestamptz), 0)::text as month,
             coalesce(sum(amount_minor) filter (where occurred_at >= ${yearFrom.toISOString()}::timestamptz), 0)::text as year,
             sum(amount_minor)::text as total
        from kliniva.cash_transactions
       where tenant_id = ${scope.tenantId}::uuid and status = 'ACTIVE' and ${bf}
       group by kind, currency`);
    const empty = (): CashPeriodTotals => ({ income: {}, expense: {} });
    const out = { week: empty(), month: empty(), year: empty(), all: empty() };
    for (const r of res.rows) {
      const side = r.kind === "INCOME" ? "income" : "expense";
      addMoney(out.week[side], r.currency, Number(r.week));
      addMoney(out.month[side], r.currency, Number(r.month));
      addMoney(out.year[side], r.currency, Number(r.year));
      addMoney(out.all[side], r.currency, Number(r.total));
    }
    return out;
  });
}

const MONTH_LABELS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

/**
 * Dashboard finans verisi (cash.read). Tahsilat = hasta tahsilatı (INCOME + hasta); gelir-gider = tüm kasa.
 * Açık bakiye ayrıca billing.read ister (yoksa 0 / boş döner). TRY ana para birimidir; diğerleri ayrı listelenir.
 */
export async function getFinanceDashboard(ctx: AuthContext): Promise<FinanceDashboard> {
  requirePermission(ctx, "cash.read");
  const base = await tenantQuery(ctx, async (scope) => {
    const tz = await clinicTz(scope);
    const today = dateInZone(new Date(), tz);
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    const monthFrom = dayStart(`${today.slice(0, 8)}01`, tz);
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    const prevMonthDays = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
    const prevKey = `${prevY}-${String(prevM).padStart(2, "0")}`;
    const prevFrom = dayStart(`${prevKey}-01`, tz);
    const prevTo = dayStart(
      addDays(`${prevKey}-${String(Math.min(d, prevMonthDays)).padStart(2, "0")}`, 1),
      tz,
    );
    // 6 ay: bu ay dahil geriye 5 ay
    const months: { key: string; label: string; from: Date }[] = [];
    for (let i = 5; i >= 0; i--) {
      const mm = ((m - 1 - i + 120) % 12) + 1;
      const yy = y + Math.floor((m - 1 - i) / 12);
      const key = `${yy}-${String(mm).padStart(2, "0")}`;
      months.push({ key, label: MONTH_LABELS[mm - 1]!, from: dayStart(`${key}-01`, tz) });
    }
    const bf = branchFilter(ctx, cashTransactions.branchId) ?? sql`true`;
    const collected = await scope.tx.execute<{ currency: Currency; cur: string; prev: string }>(sql`
      select currency,
             coalesce(sum(amount_minor) filter (where occurred_at >= ${monthFrom.toISOString()}::timestamptz), 0)::text as cur,
             coalesce(sum(amount_minor) filter (where occurred_at >= ${prevFrom.toISOString()}::timestamptz
                                                and occurred_at < ${prevTo.toISOString()}::timestamptz), 0)::text as prev
        from kliniva.cash_transactions
       where tenant_id = ${scope.tenantId}::uuid and status = 'ACTIVE' and kind = 'INCOME' and patient_id is not null
         and occurred_at >= ${prevFrom.toISOString()}::timestamptz and ${bf}
       group by currency`);
    let monthCollectedMinor = 0;
    let prevMonthSamePeriodMinor = 0;
    const monthCollectedOther: MoneyByCurrency = {};
    for (const r of collected.rows) {
      if (r.currency === "TRY") {
        monthCollectedMinor = Number(r.cur);
        prevMonthSamePeriodMinor = Number(r.prev);
      } else addMoney(monthCollectedOther, r.currency, Number(r.cur));
    }
    const series = await scope.tx.execute<{ month: string; kind: CashKind; total: string }>(sql`
      select to_char(occurred_at at time zone ${tz}, 'YYYY-MM') as month, kind, sum(amount_minor)::text as total
        from kliniva.cash_transactions
       where tenant_id = ${scope.tenantId}::uuid and status = 'ACTIVE' and currency = 'TRY'
         and occurred_at >= ${months[0]!.from.toISOString()}::timestamptz and ${bf}
       group by 1, 2`);
    const byMonth = new Map(months.map((x) => [x.key, { incomeMinor: 0, expenseMinor: 0 }]));
    for (const r of series.rows) {
      const e = byMonth.get(r.month);
      if (!e) continue;
      if (r.kind === "INCOME") e.incomeMinor = Number(r.total);
      else e.expenseMinor = Number(r.total);
    }
    const chargeBranch = ctx.branchScope.all
      ? sql`true`
      : ctx.branchScope.branchIds.size
        ? sql`c.branch_id in (${sql.join(
            [...ctx.branchScope.branchIds].map((i) => sql`${i}::uuid`),
            sql`, `,
          )})`
        : sql`false`;
    const top = await scope.tx.execute<{ name: string; total: string; n: number }>(sql`
      select coalesce(s.name, c.description) as name, sum(c.total_minor)::text as total, count(*)::int as n
        from kliniva.patient_charges c
        left join kliniva.clinical_services s on s.tenant_id = c.tenant_id and s.id = c.service_id
       where c.tenant_id = ${scope.tenantId}::uuid and c.status = 'ACTIVE' and c.currency = 'TRY'
         and c.created_at >= ${dayStart(addDays(today, -89), tz).toISOString()}::timestamptz and ${chargeBranch}
       group by 1
       order by sum(c.total_minor) desc
       limit 6`);
    return {
      monthCollectedMinor,
      prevMonthSamePeriodMinor,
      monthCollectedOther,
      months: months.map((x) => ({ key: x.key, label: x.label, ...byMonth.get(x.key)! })),
      topServices: top.rows.map((r) => ({ name: r.name, totalMinor: Number(r.total), count: r.n })),
    };
  });
  // Açık bakiye ayrı işlemde (iç içe işlem açılmaz); hasta hesabı görme yetkisi yoksa boş kalır.
  let openBalanceMinor = 0;
  const openBalanceOther: MoneyByCurrency = {};
  let openBalancePatients = 0;
  if (hasPermission(ctx, "billing.read") && hasPermission(ctx, "patient.read")) {
    const ob = await listOpenBalances(ctx, { limit: 1 });
    openBalanceMinor = ob.total.TRY ?? 0;
    for (const c of CURRENCIES) if (c !== "TRY" && ob.total[c]) openBalanceOther[c] = ob.total[c];
    openBalancePatients = ob.patients;
  }
  return { ...base, openBalanceMinor, openBalanceOther, openBalancePatients };
}
