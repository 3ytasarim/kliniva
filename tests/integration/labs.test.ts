import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditLogs, labResults } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant } from "@/server/tenant/tenant-query";
import { createPatient } from "@/server/services/patients";
import {
  addLabResult,
  createLabPanel,
  flagOf,
  listLabPanels,
  listLabResults,
  parseParametersText,
  updateLabPanel,
  voidLabResult,
} from "@/server/services/labs";
import { addDays, dateInZone } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Sprint 8.4 — tahliller: parametre ayrıştırma, referans dışı işaretleme, yetki (yönetim / sağlık yazma / okuma),
 * şifreli değerler (audit'te değer yok), girişteki aralığın sonuçta saklanması, geçersiz kılma, DB değişmezliği, RLS.
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let P: string;
let PANEL: string;
const today = () => dateInZone(new Date(), TZ);

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};
const nl = String.fromCharCode(10);

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION", branch: "A" },
    doc: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  P = (
    await createPatient(A.users.owner!.ctx, {
      firstName: "Tahlil",
      lastName: "Hasta",
      phone: "05391121001",
      branchId: A.branchA,
    })
  ).id;
}, 120_000);

afterAll(cleanupTenants);

describe("Tahliller", () => {
  it("parametre metni ayrıştırılır; hatalı satır satır numarasıyla reddedilir; işaretleme", () => {
    expect(
      parseParametersText(["Hemoglobin | g/dL | 12 | 16", "Ferritin|ng/mL|30", "Kültür"].join(nl)),
    ).toEqual([
      { key: "hemoglobin", name: "Hemoglobin", unit: "g/dL", low: 12, high: 16 },
      { key: "ferritin", name: "Ferritin", unit: "ng/mL", low: 30, high: null },
      { key: "kultur", name: "Kültür", unit: "", low: null, high: null },
    ]);
    const err = (t: string) => {
      try {
        parseParametersText(t);
        return "OK";
      } catch (e) {
        return (e as AppError).message;
      }
    };
    expect(err(["A | x | 5 | 1"].join(nl))).toMatch(/1\. satır: alt sınır/);
    expect(err(["A", "B | x | on | 3"].join(nl))).toMatch(/2\. satır: alt \/ üst/);
    expect(err(["A", "a"].join(nl))).toMatch(/aynı adla/);
    expect(err(Array.from({ length: 41 }, (_, i) => `P${i}`).join(nl))).toMatch(/En fazla 40/);
    expect(flagOf("11,5", { low: 12, high: 16 })).toBe("L");
    expect(flagOf("16.1", { low: 12, high: 16 })).toBe("H");
    expect(flagOf("14", { low: 12, high: 16 })).toBeNull();
    expect(flagOf("negatif", { low: 0, high: 1 })).toBeNull();
  });

  it("yetki: tip yönetimi clinic.manage; sonuç yazma patient.health.write; okuma patient.health.read", async () => {
    const owner = A.users.owner!.ctx;
    PANEL = (
      await createLabPanel(owner, {
        name: "Hemogram",
        parameters: ["Hemoglobin | g/dL | 12 | 16", "Lökosit | 10³/µL | 4 | 10", "Kültür"].join(nl),
      })
    ).id;
    expect(await code(createLabPanel(owner, { name: "Hemogram", parameters: "X" }))).toBe("CONFLICT");
    expect(await code(createLabPanel(A.users.doc!.ctx, { name: "Doktor", parameters: "X" }))).toBe(
      "FORBIDDEN",
    );
    expect((await listLabPanels(A.users.doc!.ctx)).map((p) => p.name)).toEqual(["Hemogram"]);
    expect(await code(listLabPanels(A.users.reception!.ctx))).toBe("FORBIDDEN");
    const rec = A.users.reception!.ctx;
    expect(
      await code(
        addLabResult(rec, { patientId: P, panelId: PANEL, sampleDate: today(), v_hemoglobin: "13" }),
      ),
    ).toBe("FORBIDDEN");
    expect(await code(listLabResults(rec, P))).toBe("FORBIDDEN");
    expect(
      await code(
        addLabResult(B.users.owner!.ctx, {
          patientId: P,
          panelId: PANEL,
          sampleDate: today(),
          v_hemoglobin: "1",
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("sonuç: işaretler, boş / ileri tarih reddi, şifreli değer, aralık sonuçta saklanır, geçersiz kılma", async () => {
    const doc = A.users.doc!.ctx;
    expect(await code(addLabResult(doc, { patientId: P, panelId: PANEL, sampleDate: today() }))).toBe(
      "VALIDATION",
    );
    expect(
      await code(
        addLabResult(doc, {
          patientId: P,
          panelId: PANEL,
          sampleDate: addDays(today(), 2),
          v_hemoglobin: "13",
        }),
      ),
    ).toBe("VALIDATION");
    const first = await addLabResult(doc, {
      patientId: P,
      panelId: PANEL,
      sampleDate: addDays(today(), -30),
      v_hemoglobin: "11,2",
      v_lokosit: "12",
      v_kultur: "Üreme yok",
    });
    // Tip değişir (aralık daralır); eski sonuç girildiği andaki aralığı korur
    await updateLabPanel(A.users.owner!.ctx, PANEL, {
      name: "Hemogram",
      parameters: ["Hemoglobin | g/dL | 13 | 17", "Lökosit | 10³/µL | 4 | 10"].join(nl),
      active: "true",
    });
    await addLabResult(doc, { patientId: P, panelId: PANEL, sampleDate: today(), v_hemoglobin: "12,5" });
    const list = await listLabResults(A.users.owner!.ctx, P);
    expect(list.map((r) => [r.sampleDate, r.abnormalCount])).toEqual([
      [today(), 1],
      [addDays(today(), -30), 2],
    ]);
    const old = list[1]!;
    expect(old.values.map((v) => [v.key, v.value, v.flag, v.low])).toEqual([
      ["hemoglobin", "11,2", "L", 12],
      ["lokosit", "12", "H", 4],
      ["kultur", "Üreme yok", null, null],
    ]);
    expect(list[0]!.values[0]).toMatchObject({ value: "12,5", flag: "L", low: 13 });

    const raw = await runInTenant(A.id, (s) => s.tx.select().from(labResults));
    expect(JSON.stringify(raw)).not.toMatch(/11,2|Üreme|12,5/);
    const audits = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(sql`${auditLogs.action} like 'LAB_%'`),
    );
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["LAB_RESULT_ADDED", "LAB_RESULTS_VIEWED"]),
    );
    expect(JSON.stringify(audits)).not.toMatch(/11,2|Üreme|12,5|Hemoglobin/);

    expect(await code(voidLabResult(A.users.reception!.ctx, first.id, { reason: "Yanlış hasta" }))).toBe(
      "FORBIDDEN",
    );
    await voidLabResult(doc, first.id, { reason: "Yanlış hasta" });
    expect(await code(voidLabResult(doc, first.id, { reason: "Tekrar" }))).toBe("CONFLICT");
    expect((await listLabResults(doc, P)).find((r) => r.id === first.id)).toMatchObject({
      status: "VOIDED",
      voidReason: "Yanlış hasta",
    });
  });

  it("DB: silinemez, değerler değiştirilemez, geçersiz kılma geri alınamaz; RLS", async () => {
    const [r] = await runInTenant(A.id, (s) =>
      s.tx.select().from(labResults).where(eq(labResults.status, "ACTIVE")),
    );
    expect(
      (await dbError(runInTenant(A.id, (s) => s.tx.delete(labResults).where(eq(labResults.id, r!.id))))).code,
    ).toBe("42501");
    const upd = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.update(labResults).set({ abnormalCount: 0 }).where(eq(labResults.id, r!.id)),
      ),
    );
    expect(upd.message).toMatch(/KLINIVA_IMMUTABLE/);
    const [v] = await runInTenant(A.id, (s) =>
      s.tx.select().from(labResults).where(eq(labResults.status, "VOIDED")),
    );
    const unvoid = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .update(labResults)
          .set({ status: "ACTIVE", voidedAt: null, voidedByUserId: null, voidReason: null })
          .where(eq(labResults.id, v!.id)),
      ),
    );
    expect(unvoid.message).toMatch(/KLINIVA_IMMUTABLE/);
    const fromB = await runInTenant(B.id, (s) =>
      s.tx.execute<{ n: number }>(
        sql`select (select count(*) from kliniva.lab_results where tenant_id = ${A.id})::int
               + (select count(*) from kliniva.lab_panels where tenant_id = ${A.id})::int as n`,
      ),
    );
    expect(fromB.rows[0]!.n).toBe(0);
  });
});
