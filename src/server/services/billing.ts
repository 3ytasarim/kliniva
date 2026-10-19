import "server-only";
import { z } from "zod";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { branches, cashTransactions, clinicalServices, patientCharges } from "@/server/db/schema";
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
import { loadAccessibleAppointment } from "@/server/services/appointments";
import { loadVisiblePatient, patientScopeFilter } from "@/server/services/patients";
import { uuidSchema } from "@/server/validation";
import { addMoney, parseMoneyInput } from "@/lib/money";
import { maskPhoneNumber } from "@/lib/phone";
import {
  CURRENCIES,
  PAYMENT_METHODS,
  type ChargeItem,
  type Currency,
  type MoneyByCurrency,
  type OpenBalanceRow,
  type PatientAccount,
  type PaymentItem,
} from "@/types/finance";

/**
 * HASTA HESABI — hizmet bedelleri (borç) ve tahsilatlar (kasaya gelir).
 *
 *  - Randevu TAMAMLANINCA hizmetin liste fiyatıyla otomatik hizmet bedeli oluşur (randevu başına tek; DB benzersiz
 *    indeksi çift kaydı engeller). Fiyatı olmayan / 0 olan hizmette bedel oluşmaz.
 *  - Elle bedel (ek işlem, paket, indirim) ve tahsilat: billing.charge / billing.payment.
 *  - Hiçbir kayıt silinmez / düzeltilmez: gerekçeyle İPTAL edilir (billing.void; DB tetikleyicisi zorlar).
 *  - Şube kapsamı: kayıt şubesi kullanıcının kapsamında olmalı; listelerde yalnızca kapsamdaki şubeler.
 *  - Audit: tutar / para birimi / yöntem — açıklama ve iptal gerekçesi (serbest metin) YAZILMAZ.
 */
const money = z.preprocess(
  (v) => parseMoneyInput(v),
  z.number({ message: "Geçerli bir tutar girin." }).int().min(0).max(1_000_000_000, "Tutar çok büyük."),
);
const positiveMoney = money.refine((v) => v > 0, "Tutar sıfırdan büyük olmalı.");
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );
const optionalUuid = z.preprocess((v) => (v === "" || v === null ? undefined : v), uuidSchema.optional());

const chargeInput = z.object({
  patientId: uuidSchema,
  appointmentId: optionalUuid,
  branchId: optionalUuid,
  serviceId: optionalUuid,
  description: optionalText(200),
  quantity: z.coerce.number().int().min(1).max(1000).default(1),
  /** Boş → hizmetin liste fiyatı. */
  unitPrice: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    money.optional(),
  ),
  discount: z.preprocess((v) => (v === "" || v === undefined || v === null ? 0 : v), money),
  currency: z.enum(CURRENCIES).optional(),
});

const paymentInput = z.object({
  patientId: uuidSchema,
  appointmentId: optionalUuid,
  branchId: optionalUuid,
  amount: positiveMoney,
  currency: z.enum(CURRENCIES).default("TRY"),
  method: z.enum(PAYMENT_METHODS),
  description: optionalText(300),
});

const voidInput = z.object({
  reason: z.string().trim().min(3, "İptal gerekçesi en az 3 karakter olmalı.").max(300),
});

function parseId(raw: unknown): string {
  const id = uuidSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND");
  return id.data;
}

const creator = sql<string>`(select u.first_name || ' ' || u.last_name from kliniva.users u
  where u.tenant_id = ${patientCharges.tenantId} and u.id = ${patientCharges.createdByUserId})`;

/**
 * Kayıt şubesini belirler: randevu varsa randevunun şubesi; yoksa istekteki şube; o da yoksa hastanın ana şubesi
 * (kapsamdaysa) ya da kullanıcının TEK şubesi. Belirsizse VALIDATION.
 */
async function resolveTarget(
  scope: TenantScope,
  ctx: AuthContext,
  input: { patientId: string; appointmentId?: string; branchId?: string },
) {
  const patient = await loadVisiblePatient(scope, ctx, input.patientId);
  if (input.appointmentId) {
    const a = await loadAccessibleAppointment(scope, ctx, input.appointmentId);
    if (a.patientId !== patient.id) throw new AppError("NOT_FOUND");
    requireBranchAccess(ctx, a.branchId);
    return { patient, appointment: a, branchId: a.branchId };
  }
  let branchId = input.branchId;
  if (!branchId) {
    if (
      patient.primaryBranchId &&
      (ctx.branchScope.all || ctx.branchScope.branchIds.has(patient.primaryBranchId))
    ) {
      branchId = patient.primaryBranchId;
    } else if (!ctx.branchScope.all && ctx.branchScope.branchIds.size === 1) {
      branchId = [...ctx.branchScope.branchIds][0];
    }
  }
  if (!branchId) throw new AppError("VALIDATION", { fields: ["branchId"], message: "Şube seçin." });
  requireBranchAccess(ctx, branchId);
  const [b] = await scope.tx
    .select({ id: branches.id })
    .from(branches)
    .where(tenantWhere(branches, scope, eq(branches.id, branchId)));
  if (!b) throw new AppError("VALIDATION", { fields: ["branchId"], message: "Şube bulunamadı." });
  return { patient, appointment: null, branchId };
}

// ---------------------------------------------------------------- otomatik hizmet bedeli

/**
 * Randevu tamamlandığında AYNI işlemde çağrılır (updateAppointmentStatus). Hizmetin fiyatı yoksa / 0 ise hiçbir şey
 * yapmaz. Aynı randevu için aktif otomatik bedel zaten varsa (yeniden deneme) benzersiz indeks sayesinde atlanır.
 * Yetki: tamamlama yetkisi yeterlidir (bedel bir yan etkidir; kullanıcı finans ekranını görmeyebilir).
 */
export async function createAppointmentCharge(
  scope: TenantScope,
  ctx: AuthContext,
  a: { id: string; patientId: string; branchId: string; serviceId: string | null },
): Promise<void> {
  if (!a.serviceId) return;
  const [svc] = await scope.tx
    .select({
      name: clinicalServices.name,
      price: clinicalServices.priceMinor,
      currency: clinicalServices.currency,
    })
    .from(clinicalServices)
    .where(tenantWhere(clinicalServices, scope, eq(clinicalServices.id, a.serviceId)));
  if (!svc || !svc.price) return;
  const [row] = await scope.tx
    .insert(patientCharges)
    .values({
      tenantId: scope.tenantId,
      branchId: a.branchId,
      patientId: a.patientId,
      appointmentId: a.id,
      serviceId: a.serviceId,
      source: "APPOINTMENT",
      description: svc.name,
      quantity: 1,
      unitPriceMinor: svc.price,
      discountMinor: 0,
      totalMinor: svc.price,
      currency: svc.currency,
      createdByUserId: ctx.userId,
    })
    .onConflictDoNothing()
    .returning({ id: patientCharges.id });
  if (!row) return;
  await writeAudit(scope, actorOf(ctx), {
    action: "PATIENT_CHARGE_CREATED",
    entityType: "patient_charge",
    entityId: row.id,
    branchId: a.branchId,
    metadata: { source: "APPOINTMENT", amountMinor: svc.price, currency: svc.currency },
  });
}

// ---------------------------------------------------------------- elle bedel / tahsilat / iptal

export async function addCharge(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "billing.charge");
  const data = parseInput(chargeInput, input);
  return tenantQuery(ctx, async (scope) => {
    const t = await resolveTarget(scope, ctx, data);
    let description = data.description;
    let unit = data.unitPrice;
    let currency: Currency = data.currency ?? "TRY";
    if (data.serviceId) {
      const [svc] = await scope.tx
        .select({
          name: clinicalServices.name,
          price: clinicalServices.priceMinor,
          currency: clinicalServices.currency,
        })
        .from(clinicalServices)
        .where(tenantWhere(clinicalServices, scope, eq(clinicalServices.id, data.serviceId)));
      if (!svc) throw new AppError("VALIDATION", { fields: ["serviceId"], message: "Hizmet bulunamadı." });
      description ??= svc.name;
      unit ??= svc.price ?? undefined;
      if (!data.currency) currency = svc.currency as Currency;
    }
    if (!description) {
      throw new AppError("VALIDATION", {
        fields: ["description"],
        message: "Hizmet seçin ya da açıklama yazın.",
      });
    }
    if (unit === undefined) {
      throw new AppError("VALIDATION", {
        fields: ["unitPrice"],
        message: "Bu hizmetin fiyatı yok; tutar girin.",
      });
    }
    const gross = data.quantity * unit;
    if (data.discount > gross) {
      throw new AppError("VALIDATION", { fields: ["discount"], message: "İndirim tutarı toplamı aşamaz." });
    }
    if (gross - data.discount > 1_000_000_000) {
      throw new AppError("VALIDATION", { fields: ["quantity"], message: "Toplam tutar çok büyük." });
    }
    const [row] = await scope.tx
      .insert(patientCharges)
      .values({
        tenantId: scope.tenantId,
        branchId: t.branchId,
        patientId: t.patient.id,
        appointmentId: t.appointment?.id ?? null,
        serviceId: data.serviceId ?? null,
        source: "MANUAL",
        description,
        quantity: data.quantity,
        unitPriceMinor: unit,
        discountMinor: data.discount,
        totalMinor: gross - data.discount,
        currency,
        createdByUserId: ctx.userId,
      })
      .returning({ id: patientCharges.id });
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_CHARGE_CREATED",
      entityType: "patient_charge",
      entityId: row!.id,
      branchId: t.branchId,
      metadata: { source: "MANUAL", amountMinor: gross - data.discount, currency },
    });
    return { id: row!.id };
  });
}

export async function recordPayment(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "billing.payment");
  const data = parseInput(paymentInput, input);
  return tenantQuery(ctx, async (scope) => {
    const t = await resolveTarget(scope, ctx, data);
    const [row] = await scope.tx
      .insert(cashTransactions)
      .values({
        tenantId: scope.tenantId,
        branchId: t.branchId,
        kind: "INCOME",
        method: data.method,
        amountMinor: data.amount,
        currency: data.currency,
        occurredAt: sql`now()`,
        patientId: t.patient.id,
        appointmentId: t.appointment?.id ?? null,
        description: data.description ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: cashTransactions.id });
    await writeAudit(scope, actorOf(ctx), {
      action: "PAYMENT_RECORDED",
      entityType: "cash_transaction",
      entityId: row!.id,
      branchId: t.branchId,
      metadata: { amountMinor: data.amount, currency: data.currency, method: data.method },
    });
    return { id: row!.id };
  });
}

export async function voidCharge(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "billing.void");
  const id = parseId(rawId);
  const data = parseInput(voidInput, input);
  await tenantQuery(ctx, async (scope) => {
    const [c] = await scope.tx
      .select()
      .from(patientCharges)
      .where(
        tenantWhere(
          patientCharges,
          scope,
          eq(patientCharges.id, id),
          branchFilter(ctx, patientCharges.branchId),
        ),
      )
      .for("update");
    if (!c) throw new AppError("NOT_FOUND");
    if (c.status !== "ACTIVE") throw new AppError("CONFLICT", { message: "Bu kayıt zaten iptal edilmiş." });
    await scope.tx
      .update(patientCharges)
      .set({ status: "VOIDED", voidedAt: sql`now()`, voidedByUserId: ctx.userId, voidReason: data.reason })
      .where(tenantWhere(patientCharges, scope, eq(patientCharges.id, id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PATIENT_CHARGE_VOIDED",
      entityType: "patient_charge",
      entityId: id,
      branchId: c.branchId,
      metadata: { amountMinor: c.totalMinor, currency: c.currency },
    });
  });
}

/**
 * Kasa hareketini iptal eder. Hasta tahsilatı → billing.void; hastasız gelir / gider → cash.manage.
 */
export async function voidCashTransaction(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  if (!hasPermission(ctx, "billing.void") && !hasPermission(ctx, "cash.manage")) {
    throw new AppError("FORBIDDEN");
  }
  const id = parseId(rawId);
  const data = parseInput(voidInput, input);
  await tenantQuery(ctx, async (scope) => {
    const [t] = await scope.tx
      .select()
      .from(cashTransactions)
      .where(
        tenantWhere(
          cashTransactions,
          scope,
          eq(cashTransactions.id, id),
          branchFilter(ctx, cashTransactions.branchId),
        ),
      )
      .for("update");
    if (!t) throw new AppError("NOT_FOUND");
    requirePermission(ctx, t.patientId ? "billing.void" : "cash.manage");
    if (t.status !== "ACTIVE") throw new AppError("CONFLICT", { message: "Bu kayıt zaten iptal edilmiş." });
    await scope.tx
      .update(cashTransactions)
      .set({ status: "VOIDED", voidedAt: sql`now()`, voidedByUserId: ctx.userId, voidReason: data.reason })
      .where(tenantWhere(cashTransactions, scope, eq(cashTransactions.id, id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "CASH_ENTRY_VOIDED",
      entityType: "cash_transaction",
      entityId: id,
      branchId: t.branchId,
      metadata: {
        kind: t.kind,
        amountMinor: t.amountMinor,
        currency: t.currency,
        patientLinked: Boolean(t.patientId),
      },
    });
  });
}

// ---------------------------------------------------------------- okuma

/** Hastanın hesabı (isteğe bağlı: yalnızca bir randevuya ait kayıtlar). Kapsam dışı şubelerin kayıtları görünmez. */
export async function getPatientAccount(
  ctx: AuthContext,
  rawPatientId: unknown,
  opts: { appointmentId?: string } = {},
): Promise<PatientAccount> {
  requirePermission(ctx, "billing.read");
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, rawPatientId);
    const chargeConds: (SQL | undefined)[] = [
      eq(patientCharges.patientId, patient.id),
      branchFilter(ctx, patientCharges.branchId),
      opts.appointmentId ? eq(patientCharges.appointmentId, opts.appointmentId) : undefined,
    ];
    const charges = await scope.tx
      .select({
        id: patientCharges.id,
        createdAt: patientCharges.createdAt,
        description: patientCharges.description,
        quantity: patientCharges.quantity,
        unitPriceMinor: patientCharges.unitPriceMinor,
        discountMinor: patientCharges.discountMinor,
        totalMinor: patientCharges.totalMinor,
        currency: patientCharges.currency,
        status: patientCharges.status,
        source: patientCharges.source,
        appointmentId: patientCharges.appointmentId,
        branchName: branches.name,
        createdByName: creator,
        voidReason: patientCharges.voidReason,
        voidedAt: patientCharges.voidedAt,
      })
      .from(patientCharges)
      .innerJoin(
        branches,
        and(eq(branches.tenantId, patientCharges.tenantId), eq(branches.id, patientCharges.branchId)),
      )
      .where(tenantWhere(patientCharges, scope, ...chargeConds))
      .orderBy(desc(patientCharges.createdAt));
    const payConds: (SQL | undefined)[] = [
      eq(cashTransactions.patientId, patient.id),
      eq(cashTransactions.kind, "INCOME"),
      branchFilter(ctx, cashTransactions.branchId),
      opts.appointmentId ? eq(cashTransactions.appointmentId, opts.appointmentId) : undefined,
    ];
    const payments = await scope.tx
      .select({
        id: cashTransactions.id,
        occurredAt: cashTransactions.occurredAt,
        amountMinor: cashTransactions.amountMinor,
        currency: cashTransactions.currency,
        method: cashTransactions.method,
        description: cashTransactions.description,
        status: cashTransactions.status,
        appointmentId: cashTransactions.appointmentId,
        branchName: branches.name,
        createdByName: sql<string>`(select u.first_name || ' ' || u.last_name from kliniva.users u
          where u.tenant_id = ${cashTransactions.tenantId} and u.id = ${cashTransactions.createdByUserId})`,
        voidReason: cashTransactions.voidReason,
        voidedAt: cashTransactions.voidedAt,
      })
      .from(cashTransactions)
      .innerJoin(
        branches,
        and(eq(branches.tenantId, cashTransactions.tenantId), eq(branches.id, cashTransactions.branchId)),
      )
      .where(tenantWhere(cashTransactions, scope, ...payConds))
      .orderBy(desc(cashTransactions.occurredAt));

    const charged: MoneyByCurrency = {};
    const paid: MoneyByCurrency = {};
    const balance: MoneyByCurrency = {};
    for (const c of charges) {
      if (c.status !== "ACTIVE") continue;
      addMoney(charged, c.currency as Currency, c.totalMinor);
      addMoney(balance, c.currency as Currency, c.totalMinor);
    }
    for (const p of payments) {
      if (p.status !== "ACTIVE") continue;
      addMoney(paid, p.currency as Currency, p.amountMinor);
      addMoney(balance, p.currency as Currency, -p.amountMinor);
    }
    return {
      charges: charges.map((c): ChargeItem => ({
        ...c,
        currency: c.currency as Currency,
        createdAt: c.createdAt.toISOString(),
        voidedAt: c.voidedAt?.toISOString() ?? null,
      })),
      payments: payments.map((p): PaymentItem => ({
        ...p,
        currency: p.currency as Currency,
        occurredAt: p.occurredAt.toISOString(),
        voidedAt: p.voidedAt?.toISOString() ?? null,
      })),
      charged,
      paid,
      balance,
    };
  });
}

/**
 * Açık bakiyeli hastalar (en az bir para biriminde borç > 0), TRY borcuna göre azalan. Tek sorgu; kapsam dışı şube
 * kayıtları ve kapsam dışı hastalar hesaba katılmaz.
 */
export async function listOpenBalances(
  ctx: AuthContext,
  opts: { limit?: number } = {},
): Promise<{ rows: OpenBalanceRow[]; patients: number; total: MoneyByCurrency }> {
  requirePermission(ctx, "billing.read", "patient.read");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return tenantQuery(ctx, async (scope) => {
    const chargeScope = branchFilter(ctx, patientCharges.branchId) ?? sql`true`;
    const payScope = branchFilter(ctx, cashTransactions.branchId) ?? sql`true`;
    const patientScope = patientScopeFilter(ctx) ?? sql`true`;
    const res = await scope.tx.execute<{
      patient_id: string;
      currency: Currency;
      balance: string;
      last_ms: string | null;
    }>(sql`
      with ledger as (
        select patient_id, currency, total_minor::bigint as amount, created_at as at
          from kliniva.patient_charges
         where tenant_id = ${scope.tenantId}::uuid and status = 'ACTIVE' and ${chargeScope}
        union all
        select patient_id, currency, -amount_minor::bigint, occurred_at
          from kliniva.cash_transactions
         where tenant_id = ${scope.tenantId}::uuid and status = 'ACTIVE' and kind = 'INCOME'
           and patient_id is not null and ${payScope}
      )
      select l.patient_id, l.currency, sum(l.amount)::text as balance,
             (extract(epoch from max(l.at)) * 1000)::bigint::text as last_ms
        from ledger l
        join kliniva.patients on kliniva.patients.tenant_id = ${scope.tenantId}::uuid
         and kliniva.patients.id = l.patient_id and ${patientScope}
       group by l.patient_id, l.currency
      having sum(l.amount) > 0`);
    const byPatient = new Map<string, { balance: MoneyByCurrency; last: Date | null }>();
    const total: MoneyByCurrency = {};
    for (const r of res.rows) {
      const e = byPatient.get(r.patient_id) ?? { balance: {}, last: null };
      const v = Number(r.balance);
      addMoney(e.balance, r.currency, v);
      addMoney(total, r.currency, v);
      // Zaman damgası sürücü / ortamdan bağımsız olsun diye epoch ms olarak okunur.
      const at = r.last_ms ? new Date(Number(r.last_ms)) : null;
      if (at && (!e.last || at > e.last)) e.last = at;
      byPatient.set(r.patient_id, e);
    }
    const ids = [...byPatient.entries()]
      .sort((a, b) => (b[1].balance.TRY ?? 0) - (a[1].balance.TRY ?? 0))
      .slice(0, limit)
      .map(([id]) => id);
    const info = ids.length
      ? await scope.tx.execute<{
          id: string;
          first_name: string;
          last_name: string;
          patient_number: string;
          phone: string;
        }>(
          sql`select id, first_name, last_name, patient_number, phone from kliniva.patients
               where tenant_id = ${scope.tenantId}::uuid and id in (${sql.join(
                 ids.map((i) => sql`${i}::uuid`),
                 sql`, `,
               )})`,
        )
      : { rows: [] };
    const byId = new Map(info.rows.map((r) => [r.id, r]));
    return {
      patients: byPatient.size,
      total,
      rows: ids.map((id) => {
        const p = byId.get(id)!;
        const e = byPatient.get(id)!;
        return {
          patientId: id,
          patientName: `${p.first_name} ${p.last_name}`,
          patientNumber: p.patient_number,
          phoneMasked: maskPhoneNumber(p.phone),
          balance: e.balance,
          lastActivityAt: e.last?.toISOString() ?? null,
        };
      }),
    };
  });
}

/** Randevu sayfası için hizmet listesi (fiyatlı) — bedel eklerken seçilir. */
export async function listBillableServices(ctx: AuthContext) {
  requirePermission(ctx, "billing.charge");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({
        id: clinicalServices.id,
        name: clinicalServices.name,
        priceMinor: clinicalServices.priceMinor,
        currency: clinicalServices.currency,
      })
      .from(clinicalServices)
      .where(tenantWhere(clinicalServices, scope, eq(clinicalServices.active, true)))
      .orderBy(asc(clinicalServices.name)),
  );
}
