import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getMigrationDb } from "@/server/db/migration-client";
import { auditLogs, cashTransactions, patientCharges } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant, tenantQuery } from "@/server/tenant/tenant-query";
import { assignDoctorBranch, createDoctor } from "@/server/services/doctors";
import { addWorkingHour } from "@/server/services/schedule";
import { createPatient } from "@/server/services/patients";
import { createClinicalService, setDoctorServices } from "@/server/services/clinical-services";
import { createAppointment, getAppointment, updateAppointmentStatus } from "@/server/services/appointments";
import {
  addCharge,
  createAppointmentCharge,
  getPatientAccount,
  listOpenBalances,
  recordPayment,
  voidCashTransaction,
  voidCharge,
} from "@/server/services/billing";
import {
  createCashCategory,
  createCashEntry,
  getCashSummary,
  getFinanceDashboard,
  listCashTransactions,
} from "@/server/services/cash";
import { addDays, dateInZone, isoDayOfWeek, parseTime, zonedDateTimeToUtc } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Sprint 8 — hasta hesabı + kasa: otomatik hizmet bedeli (tek), elle bedel / tahsilat / bakiye, iptal (geri
 * alınamaz), RBAC, şube kapsamı, kiracı izolasyonu ve DB tetikleyicileri (değiştirilemez defter).
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let D: string;
let PRICED: string;
let FREE: string;
let P: string;
let PB: string;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};
function nextMonday(): string {
  let d = addDays(dateInZone(new Date(), TZ), 2);
  while (isoDayOfWeek(d) !== 1) d = addDays(d, 1);
  return d;
}
const at = (hhmm: string) => zonedDateTimeToUtc(nextMonday(), parseTime(hhmm)!, TZ).toISOString();
const book = async (serviceId: string, patientId: string, hhmm: string, branch?: string) =>
  (
    await createAppointment(A.users.owner!.ctx, {
      patientId,
      branchId: branch ?? A.branchA,
      doctorId: D,
      serviceId,
      start: at(hhmm),
    })
  ).id;
async function complete(id: string) {
  const doc = A.users.doc!.ctx;
  await updateAppointmentStatus(doc, id, { status: "CHECKED_IN" });
  await updateAppointmentStatus(doc, id, { status: "IN_PROGRESS" });
  await updateAppointmentStatus(doc, id, { status: "COMPLETED" });
}

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION", branch: "A" },
    managerB: { role: "BRANCH_MANAGER", branch: "B" },
    doc: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  const owner = A.users.owner!.ctx;
  D = (await createDoctor(owner, { mode: "existing", userId: A.users.doc!.id, specialty: "Dermatoloji" })).id;
  PRICED = (
    await createClinicalService(owner, {
      name: "Muayene",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
      price: "2.500",
      currency: "TRY",
    })
  ).id;
  FREE = (
    await createClinicalService(owner, {
      name: "Kontrol (ücretsiz)",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
    })
  ).id;
  for (const branch of [A.branchA, A.branchB]) {
    await assignDoctorBranch(owner, D, branch);
    for (let dow = 1; dow <= 7; dow++) {
      await addWorkingHour(owner, {
        doctorId: D,
        branchId: branch,
        dayOfWeek: dow,
        startTime: branch === A.branchA ? "08:00" : "14:00",
        endTime: branch === A.branchA ? "13:00" : "20:00",
      });
    }
  }
  await setDoctorServices(owner, { doctorId: D, services: [{ serviceId: PRICED }, { serviceId: FREE }] });
  P = (
    await createPatient(owner, {
      firstName: "Hesap",
      lastName: "Hasta",
      phone: "05391118001",
      branchId: A.branchA,
    })
  ).id;
  PB = (
    await createPatient(owner, {
      firstName: "Bşube",
      lastName: "Hasta",
      phone: "05391118002",
      branchId: A.branchB,
    })
  ).id;
}, 120_000);

afterAll(cleanupTenants);

describe("Hasta hesabı", () => {
  it("tamamlanan randevu fiyatlı hizmette TEK otomatik bedel üretir; fiyatsız hizmette bedel yok", async () => {
    const id = await book(PRICED, P, "09:00");
    await complete(id);
    const acc = await getPatientAccount(A.users.owner!.ctx, P, { appointmentId: id });
    expect(acc.charges).toHaveLength(1);
    expect(acc.charges[0]).toMatchObject({ source: "APPOINTMENT", totalMinor: 250_000, currency: "TRY" });
    expect(acc.balance).toEqual({ TRY: 250_000 });
    // Yeniden deneme (aynı randevu) çift borç üretmez — benzersiz indeks
    const a = await getAppointment(A.users.owner!.ctx, id);
    await tenantQuery(A.users.owner!.ctx, (scope) =>
      createAppointmentCharge(scope, A.users.owner!.ctx, {
        id,
        patientId: P,
        branchId: a.branch.id,
        serviceId: PRICED,
      }),
    );
    expect((await getPatientAccount(A.users.owner!.ctx, P, { appointmentId: id })).charges).toHaveLength(1);

    const free = await book(FREE, P, "10:00");
    await complete(free);
    expect((await getPatientAccount(A.users.owner!.ctx, P, { appointmentId: free })).charges).toHaveLength(0);
  });

  it("elle bedel (indirimli) + kısmi tahsilat → bakiye; iptal bakiyeyi düzeltir, ikinci iptal CONFLICT", async () => {
    const rec = A.users.reception!.ctx;
    const c = await addCharge(rec, {
      patientId: P,
      description: "Ek işlem",
      quantity: "2",
      unitPrice: "1.000,50",
      discount: "1,00",
    });
    expect(
      await code(addCharge(rec, { patientId: P, description: "x", unitPrice: "100", discount: "500" })),
    ).toBe("VALIDATION");
    const pay = await recordPayment(rec, { patientId: P, amount: "1.500", method: "CARD" });
    let acc = await getPatientAccount(A.users.owner!.ctx, P);
    // 2500 (oto) + 2*1000,50 − 1 = 4500 bedel; 1500 tahsilat
    expect(acc.charged).toEqual({ TRY: 450_000 });
    expect(acc.paid).toEqual({ TRY: 150_000 });
    expect(acc.balance).toEqual({ TRY: 300_000 });
    // Resepsiyon iptal edemez
    expect(await code(voidCharge(rec, c.id, { reason: "Hatalı giriş" }))).toBe("FORBIDDEN");
    const owner = A.users.owner!.ctx;
    expect(await code(voidCharge(owner, c.id, { reason: "x" }))).toBe("VALIDATION");
    await voidCharge(owner, c.id, { reason: "Hatalı giriş" });
    expect(await code(voidCharge(owner, c.id, { reason: "Tekrar" }))).toBe("CONFLICT");
    await voidCashTransaction(owner, pay.id, { reason: "Kart iadesi" });
    acc = await getPatientAccount(owner, P);
    expect(acc.balance).toEqual({ TRY: 250_000 });
    expect(acc.charges.find((x) => x.id === c.id)?.status).toBe("VOIDED");

    const ob = await listOpenBalances(owner);
    expect(ob.rows.find((r) => r.patientId === P)?.balance).toEqual({ TRY: 250_000 });
    expect(ob.rows[0]!.phoneMasked).not.toContain("1118001");

    // Audit: tutar var, serbest metin (açıklama / gerekçe) YOK
    const audits = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.tenantId, A.id),
            sql`${auditLogs.action} in ('PATIENT_CHARGE_CREATED','PATIENT_CHARGE_VOIDED','PAYMENT_RECORDED','CASH_ENTRY_VOIDED')`,
          ),
        ),
    );
    expect(audits.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(audits)).not.toMatch(/Ek işlem|Hatalı giriş|Kart iadesi/);
  });

  it("RBAC: doktor finansı görmez; resepsiyon kasayı görmez / gider giremez; diğer kiracı hastayı göremez", async () => {
    const doc = A.users.doc!.ctx;
    expect(await code(getPatientAccount(doc, P))).toBe("FORBIDDEN");
    expect(await code(recordPayment(doc, { patientId: P, amount: "10", method: "CASH" }))).toBe("FORBIDDEN");
    const rec = A.users.reception!.ctx;
    expect(await code(listCashTransactions(rec, {}))).toBe("FORBIDDEN");
    expect(
      await code(
        createCashEntry(rec, { kind: "EXPENSE", amount: "10", method: "CASH", branchId: A.branchA }),
      ),
    ).toBe("FORBIDDEN");
    expect(await code(getPatientAccount(B.users.owner!.ctx, P))).toBe("NOT_FOUND");
    expect(
      await code(recordPayment(B.users.owner!.ctx, { patientId: P, amount: "10", method: "CASH" })),
    ).toBe("NOT_FOUND");
  });

  it("şube kapsamı: A şubesi resepsiyonu B şubesi hastasına / şubesine işlem yapamaz; B müdürü A kayıtlarını görmez", async () => {
    const rec = A.users.reception!.ctx;
    expect(await code(recordPayment(rec, { patientId: PB, amount: "10", method: "CASH" }))).toBe("NOT_FOUND");
    expect(
      await code(recordPayment(rec, { patientId: P, amount: "10", method: "CASH", branchId: A.branchB })),
    ).toBe("FORBIDDEN");
    const mgr = A.users.managerB!.ctx;
    await recordPayment(mgr, { patientId: PB, amount: "300", method: "CASH" });
    const list = await listCashTransactions(mgr, {});
    expect(list.rows.every((r) => r.branchName === "Şube B")).toBe(true);
    expect(list.rows).toHaveLength(1);
    const summary = await getCashSummary(mgr);
    expect(summary.all.income).toEqual({ TRY: 30_000 });
  });
});

describe("Kasa", () => {
  it("gider + kategori; tür uyuşmazlığı / ileri tarih reddedilir; özet ve panel verisi", async () => {
    const owner = A.users.owner!.ctx;
    const rent = await createCashCategory(owner, { name: "Kira", kind: "EXPENSE" });
    const other = await createCashCategory(owner, { name: "Diğer gelir", kind: "INCOME" });
    expect(await code(createCashCategory(owner, { name: "Kira", kind: "EXPENSE" }))).toBe("CONFLICT");
    expect(
      await code(
        createCashEntry(owner, {
          kind: "EXPENSE",
          categoryId: other.id,
          amount: "100",
          method: "TRANSFER",
          branchId: A.branchA,
        }),
      ),
    ).toBe("VALIDATION");
    expect(
      await code(
        createCashEntry(owner, {
          kind: "EXPENSE",
          amount: "100",
          method: "TRANSFER",
          branchId: A.branchA,
          date: addDays(dateInZone(new Date(), TZ), 3),
        }),
      ),
    ).toBe("VALIDATION");
    await createCashEntry(owner, {
      kind: "EXPENSE",
      categoryId: rent.id,
      amount: "20.000",
      method: "TRANSFER",
      branchId: A.branchA,
      description: "Ekim kirası",
    });
    await createCashEntry(owner, {
      kind: "INCOME",
      amount: "100",
      currency: "EUR",
      method: "CASH",
      branchId: A.branchA,
    });
    const s = await getCashSummary(owner);
    expect(s.month.expense).toEqual({ TRY: 2_000_000 });
    expect(s.month.income.EUR).toBe(10_000);
    const expenses = await listCashTransactions(owner, { kind: "EXPENSE" });
    expect(expenses.rows[0]).toMatchObject({
      categoryName: "Kira",
      amountMinor: 2_000_000,
      patientName: null,
    });

    const f = await getFinanceDashboard(owner);
    // Bu ay hasta tahsilatı: B şubesi 300 TL (A'daki 1500 iptal edildi)
    expect(f.monthCollectedMinor).toBe(30_000);
    expect(f.months).toHaveLength(6);
    expect(f.months.at(-1)!.expenseMinor).toBe(2_000_000);
    expect(f.topServices[0]).toMatchObject({ name: "Muayene", totalMinor: 250_000, count: 1 });
    expect(f.openBalanceMinor).toBe(250_000);
    expect(f.openBalancePatients).toBe(1);
    // Resepsiyon panel finans verisini alamaz
    expect(await code(getFinanceDashboard(A.users.reception!.ctx))).toBe("FORBIDDEN");
  });

  it("DB: defter değiştirilemez (DELETE yok, iptal dışı UPDATE yok, iptal geri alınamaz); tutarlılık; RLS", async () => {
    const owner = A.users.owner!.ctx;
    const pay = await recordPayment(owner, { patientId: P, amount: "50", method: "CASH" });
    // Uygulama rolü: DELETE yetkisi yok
    expect(
      (
        await dbError(
          runInTenant(A.id, (s) => s.tx.delete(cashTransactions).where(eq(cashTransactions.id, pay.id))),
        )
      ).code,
    ).toBe("42501");
    // Tutar değiştirme → tetikleyici
    const upd = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.update(cashTransactions).set({ amountMinor: 1 }).where(eq(cashTransactions.id, pay.id)),
      ),
    );
    expect(upd.message).toMatch(/KLINIVA_IMMUTABLE/);
    await voidCashTransaction(owner, pay.id, { reason: "Deneme" });
    const unvoid = await dbError(
      getMigrationDb().execute(
        sql`update kliniva.cash_transactions set status = 'ACTIVE', voided_at = null, voided_by_user_id = null, void_reason = null where id = ${pay.id}`,
      ),
    );
    expect(unvoid.message).toMatch(/KLINIVA_IMMUTABLE/);
    const del = await dbError(
      getMigrationDb().execute(sql`delete from kliniva.cash_transactions where id = ${pay.id}`),
    );
    expect(del.message).toMatch(/KLINIVA_IMMUTABLE/);
    // Randevu hastasıyla uyuşmayan kayıt
    const appt = await book(PRICED, P, "11:00");
    const bad = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.insert(patientCharges).values({
          tenantId: A.id,
          branchId: A.branchA,
          patientId: PB,
          appointmentId: appt,
          description: "x",
          unitPriceMinor: 1,
          totalMinor: 1,
          createdByUserId: A.users.owner!.id,
        }),
      ),
    );
    expect(bad.message).toMatch(/KLINIVA_INVALID/);
    // Gider hastaya bağlanamaz (CHECK)
    const exp = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.insert(cashTransactions).values({
          tenantId: A.id,
          branchId: A.branchA,
          kind: "EXPENSE",
          method: "CASH",
          amountMinor: 1,
          occurredAt: new Date(),
          patientId: P,
          createdByUserId: A.users.owner!.id,
        }),
      ),
    );
    expect(exp.code).toBe("23514");
    // Toplam ≠ adet × fiyat − indirim (CHECK)
    const tot = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.insert(patientCharges).values({
          tenantId: A.id,
          branchId: A.branchA,
          patientId: P,
          description: "x",
          quantity: 2,
          unitPriceMinor: 100,
          totalMinor: 100,
          createdByUserId: A.users.owner!.id,
        }),
      ),
    );
    expect(tot.code).toBe("23514");
    // RLS: B bağlamında A kayıtları görünmez
    const fromB = await runInTenant(B.id, (s) =>
      s.tx.execute<{ n: number }>(
        sql`select (select count(*) from kliniva.cash_transactions where tenant_id = ${A.id})::int
               + (select count(*) from kliniva.patient_charges where tenant_id = ${A.id})::int as n`,
      ),
    );
    expect(fromB.rows[0]!.n).toBe(0);
  });
});
