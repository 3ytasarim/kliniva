import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getMigrationDb } from "@/server/db/migration-client";
import { auditLogs, clinicalNotes } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant } from "@/server/tenant/tenant-query";
import { assignDoctorBranch, createDoctor } from "@/server/services/doctors";
import { addWorkingHour } from "@/server/services/schedule";
import { createPatient } from "@/server/services/patients";
import { createClinicalService, setDoctorServices } from "@/server/services/clinical-services";
import { createAppointment, updateAppointmentStatus } from "@/server/services/appointments";
import { getClinicalNote, saveClinicalNote } from "@/server/services/clinical-notes";
import { addDays, dateInZone, isoDayOfWeek, parseTime, zonedDateTimeToUtc } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Muayene kaydı (sağlık verisi): yazma yalnızca randevunun doktoru + hasta geldikten sonra; okuma patient.health.read
 * + randevu kapsamı; sürümlü / yalnızca ekleme (DB tetikleyicisi + yetki); şifreli içerik; audit'te içerik yok; RLS.
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let D1: string;
let D2: string;
let S: string;
let P: string;
let P2: string;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};
function nextMonday(weeks = 0): string {
  let d = addDays(dateInZone(new Date(), TZ), 2);
  while (isoDayOfWeek(d) !== 1) d = addDays(d, 1);
  return addDays(d, weeks * 7);
}
const at = (date: string, hhmm: string) => zonedDateTimeToUtc(date, parseTime(hhmm)!, TZ).toISOString();
const book = async (doctorId: string, patientId: string, hhmm: string) =>
  (
    await createAppointment(A.users.reception!.ctx, {
      patientId,
      branchId: A.branchA,
      doctorId,
      serviceId: S,
      start: at(nextMonday(), hhmm),
    })
  ).id;

const SECRET = "Sol diz ağrısı, 3 gündür";

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION", branch: "A" },
    docA: { role: "DOCTOR" },
    docB: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  const owner = A.users.owner!.ctx;
  D1 = (await createDoctor(owner, { mode: "existing", userId: A.users.docA!.id, specialty: "Ortopedi" })).id;
  D2 = (await createDoctor(owner, { mode: "existing", userId: A.users.docB!.id, specialty: "Dahiliye" })).id;
  S = (
    await createClinicalService(owner, {
      name: "Muayene",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
    })
  ).id;
  for (const d of [D1, D2]) {
    await assignDoctorBranch(owner, d, A.branchA);
    for (let dow = 1; dow <= 7; dow++) {
      await addWorkingHour(owner, {
        doctorId: d,
        branchId: A.branchA,
        dayOfWeek: dow,
        startTime: "08:00",
        endTime: "20:00",
      });
    }
    await setDoctorServices(owner, { doctorId: d, services: [{ serviceId: S }] });
  }
  P = (
    await createPatient(owner, {
      firstName: "Kayıt",
      lastName: "Hasta",
      phone: "05391117001",
      branchId: A.branchA,
    })
  ).id;
  P2 = (
    await createPatient(owner, {
      firstName: "Diğer",
      lastName: "Hasta",
      phone: "05391117002",
      branchId: A.branchA,
    })
  ).id;
}, 120_000);

afterAll(cleanupTenants);

describe("Muayene kaydı", () => {
  it("doktor kendi hastası geldikten sonra yazar; aynı içerik sürüm üretmez; değişiklik yeni sürüm; okuma şifre çözer", async () => {
    const doc = A.users.docA!.ctx;
    const id = await book(D1, P, "09:00");
    // Hasta gelmeden yazılamaz
    expect(await code(saveClinicalNote(doc, id, { complaint: SECRET }))).toBe("VALIDATION");
    await updateAppointmentStatus(doc, id, { status: "CHECKED_IN" });
    expect(await saveClinicalNote(doc, id, { complaint: SECRET, procedures: "Fizik muayene" })).toEqual({
      version: 1,
      unchanged: false,
    });
    expect(await saveClinicalNote(doc, id, { complaint: SECRET, procedures: "Fizik muayene" })).toEqual({
      version: 1,
      unchanged: true,
    });
    await updateAppointmentStatus(doc, id, { status: "IN_PROGRESS" });
    expect(
      (await saveClinicalNote(doc, id, { complaint: SECRET, procedures: "Fizik muayene, röntgen istendi" }))
        .version,
    ).toBe(2);
    const v = await getClinicalNote(doc, id);
    expect(v.latest?.version).toBe(2);
    expect(v.latest?.content).toEqual({
      complaint: SECRET,
      history: "",
      findings: "",
      procedures: "Fizik muayene, röntgen istendi",
      plan: "",
      advice: "",
    });
    // Yeni alanlar (öykü / tavsiye) kaydedilir; aynı içerik tekrar sürüm üretmez
    expect(
      (
        await saveClinicalNote(doc, id, {
          complaint: SECRET,
          procedures: "Fizik muayene, röntgen istendi",
          history: "Geçen yıl menisküs",
          advice: "Soğuk uygulama",
        })
      ).version,
    ).toBe(3);
    const v3 = await getClinicalNote(doc, id);
    expect([v3.latest?.content.history, v3.latest?.content.advice]).toEqual([
      "Geçen yıl menisküs",
      "Soğuk uygulama",
    ]);
    expect(v.versions.map((x) => x.version)).toEqual([2, 1]);
    expect([v.canWrite, v.integrityError]).toEqual([true, false]);
    // Boş kayıt reddedilir
    expect(await code(saveClinicalNote(doc, id, {}))).toBe("VALIDATION");

    // Şifreli: ham satırda düz metin yok; audit'te içerik yok
    const raw = await runInTenant(A.id, (s) =>
      s.tx.select().from(clinicalNotes).where(eq(clinicalNotes.appointmentId, id)),
    );
    expect(raw).toHaveLength(3);
    expect(JSON.stringify(raw)).not.toContain("diz");
    const audits = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, id), sql`${auditLogs.action} like 'CLINICAL_NOTE_%'`)),
    );
    expect(audits.map((x) => x.action).sort()).toEqual([
      "CLINICAL_NOTE_SAVED",
      "CLINICAL_NOTE_SAVED",
      "CLINICAL_NOTE_SAVED",
      "CLINICAL_NOTE_VIEWED",
      "CLINICAL_NOTE_VIEWED",
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/diz|röntgen|Fizik|menisküs|Soğuk/);
  });

  it("yetki ve kapsam: başka doktor görmez; sahip okur ama yazamaz; resepsiyon (sağlık izni yok) okuyamaz; diğer kiracı görmez", async () => {
    const id = await book(D1, P2, "10:00");
    await updateAppointmentStatus(A.users.docA!.ctx, id, { status: "CHECKED_IN" });
    await saveClinicalNote(A.users.docA!.ctx, id, { findings: "Normal" });
    expect(await code(getClinicalNote(A.users.docB!.ctx, id))).toBe("NOT_FOUND");
    expect(await code(saveClinicalNote(A.users.docB!.ctx, id, { findings: "x" }))).toBe("NOT_FOUND");
    const ownerView = await getClinicalNote(A.users.owner!.ctx, id);
    expect(ownerView.latest?.content.findings).toBe("Normal");
    expect([ownerView.canWrite, ownerView.writeBlockedReason]).toEqual([
      false,
      "Muayene kaydını yalnızca randevunun doktoru yazar.",
    ]);
    expect(await code(saveClinicalNote(A.users.owner!.ctx, id, { findings: "x" }))).toBe("FORBIDDEN");
    expect(await code(getClinicalNote(A.users.reception!.ctx, id))).toBe("FORBIDDEN");
    expect(await code(saveClinicalNote(A.users.reception!.ctx, id, { findings: "x" }))).toBe("FORBIDDEN");
    expect(await code(getClinicalNote(B.users.owner!.ctx, id))).toBe("NOT_FOUND");
  });

  it("DB: yalnızca ekleme (uygulama rolü UPDATE/DELETE yok; sahip rolü tetikleyiciye takılır); hasta/doktor tutarlılığı; sürüm sırası; RLS", async () => {
    const id = await book(D1, P, "11:00");
    await updateAppointmentStatus(A.users.docA!.ctx, id, { status: "CHECKED_IN" });
    await saveClinicalNote(A.users.docA!.ctx, id, { plan: "Kontrol 1 hafta" });
    for (const stmt of [
      sql`update kliniva.clinical_notes set content_encrypted = 'x' where appointment_id = ${id}`,
      sql`delete from kliniva.clinical_notes where appointment_id = ${id}`,
    ]) {
      expect((await dbError(runInTenant(A.id, (s) => s.tx.execute(stmt)))).code).toBe("42501");
    }
    const ownerDb = getMigrationDb();
    const upd = await dbError(
      ownerDb.execute(
        sql`update kliniva.clinical_notes set content_encrypted = 'x' where appointment_id = ${id}`,
      ),
    );
    expect(upd.message).toMatch(/KLINIVA_IMMUTABLE/);
    const del = await dbError(
      ownerDb.execute(sql`delete from kliniva.clinical_notes where appointment_id = ${id}`),
    );
    expect(del.message).toMatch(/KLINIVA_IMMUTABLE/);
    const insert = (patientId: string, doctorId: string, version: number) =>
      ownerDb.execute(sql`insert into kliniva.clinical_notes (tenant_id, appointment_id, patient_id, doctor_id, version,
        content_encrypted, content_hash, created_by_user_id)
        values (${A.id}, ${id}, ${patientId}, ${doctorId}, ${version}, 'x', ${"a".repeat(64)}, ${A.users.docA!.id})`);
    expect((await dbError(insert(P2, D1, 2))).message).toMatch(/KLINIVA_INVALID/); // yanlış hasta
    expect((await dbError(insert(P, D2, 2))).message).toMatch(/KLINIVA_INVALID/); // yanlış doktor
    expect((await dbError(insert(P, D1, 5))).message).toMatch(/KLINIVA_INVALID/); // sürüm atlama
    // RLS: B bağlamında A satırı görünmez
    const fromB = await runInTenant(B.id, (s) =>
      s.tx.execute<{ n: number }>(
        sql`select count(*)::int n from kliniva.clinical_notes where tenant_id = ${A.id}`,
      ),
    );
    expect(fromB.rows[0]!.n).toBe(0);
  });
});
