import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getMigrationDb } from "@/server/db/migration-client";
import { auditLogs, patients } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant } from "@/server/tenant/tenant-query";
import { assignDoctorBranch, createDoctor } from "@/server/services/doctors";
import { addWorkingHour } from "@/server/services/schedule";
import {
  createPatient,
  getPatient,
  getPatientHealthAlerts,
  getPatientListSummary,
  getPatientSourceStats,
  listPatients,
  updatePatient,
  updatePatientHealthProfile,
} from "@/server/services/patients";
import {
  createPatientLookup,
  listPatientLookups,
  setPatientLookupActive,
} from "@/server/services/patient-lookups";
import { createClinicalService, setDoctorServices } from "@/server/services/clinical-services";
import { createAppointment, updateAppointmentStatus } from "@/server/services/appointments";
import { addDays, dateInZone, isoDayOfWeek, parseTime, zonedDateTimeToUtc } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Sprint 8.1 — hasta kartı: kaynak / sigorta tanımları (tür + etkinlik + kiracı), SMS izni, şifreli sağlık profili
 * (yetki, audit'te değer yok), muayene uyarıları ve liste segmentleri / özet.
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let D: string;
let S: string;
let GOOGLE: string;
let ALLIANZ: string;
let B_SOURCE: string;

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
const book = async (patientId: string, hhmm: string) =>
  (
    await createAppointment(A.users.owner!.ctx, {
      patientId,
      branchId: A.branchA,
      doctorId: D,
      serviceId: S,
      start: at(hhmm),
    })
  ).id;
async function complete(id: string) {
  const doc = A.users.doc!.ctx;
  await updateAppointmentStatus(doc, id, { status: "CHECKED_IN" });
  await updateAppointmentStatus(doc, id, { status: "IN_PROGRESS" });
  await updateAppointmentStatus(doc, id, { status: "COMPLETED" });
}
const newPatient = async (first: string, extra: Record<string, unknown> = {}) =>
  (
    await createPatient(A.users.owner!.ctx, {
      firstName: first,
      lastName: "Kart",
      phone: `0539${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      branchId: A.branchA,
      ...extra,
    })
  ).id;

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION", branch: "A" },
    doc: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  const owner = A.users.owner!.ctx;
  GOOGLE = (await createPatientLookup(owner, { kind: "SOURCE", name: "Google" })).id;
  ALLIANZ = (await createPatientLookup(owner, { kind: "INSURER", name: "Allianz Sigorta" })).id;
  B_SOURCE = (await createPatientLookup(B.users.owner!.ctx, { kind: "SOURCE", name: "Google" })).id;
  D = (await createDoctor(owner, { mode: "existing", userId: A.users.doc!.id, specialty: "Dermatoloji" })).id;
  S = (
    await createClinicalService(owner, {
      name: "Muayene",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
    })
  ).id;
  await assignDoctorBranch(owner, D, A.branchA);
  for (let dow = 1; dow <= 7; dow++) {
    await addWorkingHour(owner, {
      doctorId: D,
      branchId: A.branchA,
      dayOfWeek: dow,
      startTime: "08:00",
      endTime: "20:00",
    });
  }
  await setDoctorServices(owner, { doctorId: D, services: [{ serviceId: S }] });
}, 120_000);

afterAll(cleanupTenants);

describe("Hasta tanımları ve kart alanları", () => {
  it("kaynak / sigorta / sosyal güvence / SMS kaydedilir; tür, kiracı ve etkinlik doğrulanır", async () => {
    const owner = A.users.owner!.ctx;
    const id = await newPatient("Kaynak", {
      sourceId: GOOGLE,
      insurerId: ALLIANZ,
      socialSecurity: "SGK",
      referral: "Dr. Ayşe",
      smsAllowed: "true",
    });
    const p = await getPatient(owner, id);
    expect(p).toMatchObject({
      sourceName: "Google",
      insurerName: "Allianz Sigorta",
      socialSecurity: "SGK",
      referral: "Dr. Ayşe",
      smsAllowed: true,
    });
    // Yanlış tür / başka kiracının tanımı
    expect(await code(newPatient("Yanlis", { sourceId: ALLIANZ }))).toBe("VALIDATION");
    expect(await code(newPatient("Yabanci", { sourceId: B_SOURCE }))).toBe("VALIDATION");
    // DB tetikleyicisi: tür uyuşmazlığı
    const bad = await dbError(
      getMigrationDb().execute(sql`update kliniva.patients set source_id = ${ALLIANZ} where id = ${id}`),
    );
    expect(bad.message).toMatch(/KLINIVA_INVALID/);
    // Pasif tanım yeni seçilemez ama mevcut değer korunur; "" temizler; SMS kutusu false
    await setPatientLookupActive(owner, GOOGLE, false);
    expect(await code(newPatient("Pasif", { sourceId: GOOGLE }))).toBe("VALIDATION");
    await updatePatient(owner, id, { sourceId: GOOGLE, referral: "", smsAllowed: "false" });
    const p2 = await getPatient(owner, id);
    expect([p2.sourceName, p2.referral, p2.smsAllowed]).toEqual(["Google", null, false]);
    await setPatientLookupActive(owner, GOOGLE, true);
    // Yetki: resepsiyon tanım ekleyemez ama listeler
    expect(await code(createPatientLookup(A.users.reception!.ctx, { kind: "SOURCE", name: "TV" }))).toBe(
      "FORBIDDEN",
    );
    expect((await listPatientLookups(A.users.reception!.ctx)).map((l) => l.name)).toContain("Google");
    expect(await code(createPatientLookup(owner, { kind: "SOURCE", name: "Google" }))).toBe("CONFLICT");
  });

  it("sağlık profili: şifreli; doktor yazar, resepsiyon ne okur ne yazar; audit'te değer yok; muayene uyarısı", async () => {
    const id = await newPatient("Saglik");
    const doc = A.users.doc!.ctx;
    const rec = A.users.reception!.ctx;
    const input = {
      bloodType: "A Rh+",
      allergies: "Penisilin",
      chronicConditions: "Hipertansiyon",
      medications: "",
      smoking: "NEVER",
      alcohol: "",
    };
    expect(await code(updatePatientHealthProfile(rec, id, input))).toBe("FORBIDDEN");
    expect(await code(updatePatientHealthProfile(doc, id, { ...input, bloodType: "X+" }))).toBe("VALIDATION");
    await updatePatientHealthProfile(doc, id, input);
    const p = await getPatient(A.users.owner!.ctx, id);
    expect(p.health?.profile).toMatchObject({ bloodType: "A Rh+", allergies: "Penisilin", alcohol: null });
    expect((await getPatient(rec, id)).health).toBeUndefined();
    expect(await getPatientHealthAlerts(doc, id)).toEqual({
      allergies: "Penisilin",
      chronicConditions: "Hipertansiyon",
    });
    expect(await code(getPatientHealthAlerts(rec, id))).toBe("FORBIDDEN");
    // Aynı içerik → audit üretmez; ham satırda düz metin yok
    await updatePatientHealthProfile(doc, id, input);
    const raw = await runInTenant(A.id, (s) =>
      s.tx.select({ h: patients.healthProfileEncrypted }).from(patients).where(eq(patients.id, id)),
    );
    expect(raw[0]!.h).not.toMatch(/Penisilin/);
    const audits = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "PATIENT_HEALTH_PROFILE_UPDATED"))),
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toMatch(/Penisilin|Hipertansiyon|A Rh/);
    expect(JSON.stringify(audits[0]!.metadataSafe)).toMatch(/allergies/);
  });
});

describe("Liste segmentleri", () => {
  it("yaklaşan / tekrar gelen / hiç ziyareti yok / 90+ gün / bu ay; özet sayıları; finans segmenti yetkisi", async () => {
    const owner = A.users.owner!.ctx;
    const upcoming = await newPatient("Yaklasan");
    await book(upcoming, "09:00");
    const returning = await newPatient("Tekrar");
    for (const h of ["10:00", "11:00"]) await complete(await book(returning, h));
    const lapsed = await newPatient("Eski");
    const old = await book(lapsed, "12:00");
    // 120 gün geriye taşı (planlama aşamasında zaman değişebilir), sonra tamamla
    await getMigrationDb().execute(
      sql`update kliniva.appointments set scheduled_start = scheduled_start - interval '120 days',
            scheduled_end = scheduled_end - interval '120 days' where id = ${old}`,
    );
    await complete(old);

    const ids = async (segment: string) =>
      (await listPatients(owner, { segment: segment as never, limit: 100 })).items.map((i) => i.id);
    expect(await ids("upcoming")).toEqual([upcoming]);
    expect(await ids("returning")).toEqual([returning]);
    expect(await ids("lapsed")).toEqual([lapsed]);
    const none = await ids("no_visit");
    expect(none).toContain(upcoming);
    expect(none).not.toContain(returning);
    expect(await ids("new_month")).toEqual(expect.arrayContaining([upcoming, returning, lapsed]));

    const list = await listPatients(owner, { q: "Tekrar" });
    expect(list.items[0]).toMatchObject({ visitCount: 2, nextAppointmentAt: null, balanceMinor: 0 });
    expect(list.items[0]!.lastVisitAt).toBeInstanceOf(Date);

    const sum = await getPatientListSummary(owner);
    expect(sum.upcoming).toBe(1);
    expect(sum.lapsed).toBe(1);
    expect(sum.openBalance).toEqual({ patients: 0, totalMinor: 0 });
    // Doktor finans görmez: bakiye segmenti FORBIDDEN, özette bakiye yok, listede bakiye alanı yok
    const doc = A.users.doc!.ctx;
    expect(await code(listPatients(doc, { segment: "balance" }))).toBe("FORBIDDEN");
    expect((await getPatientListSummary(doc)).openBalance).toBeUndefined();
    expect((await listPatients(doc, { limit: 1 })).items[0]).not.toHaveProperty("balanceMinor");
    // Panel: son 90 gün tamamlanan ziyaret kaynakları (90 günden eski ziyaret sayılmaz)
    const stats = await getPatientSourceStats(owner);
    expect(stats).toEqual({ total: 2, items: [{ name: "Belirtilmedi", count: 2 }] });
    expect(await code(getPatientSourceStats(A.users.doc!.ctx))).toBe("FORBIDDEN");
    // Kaynak filtresi
    const withSource = await newPatient("Filtre", { sourceId: GOOGLE });
    expect((await listPatients(owner, { sourceId: GOOGLE, limit: 100 })).items.map((i) => i.id)).toContain(
      withSource,
    );
    expect(
      (await listPatients(owner, { sourceId: GOOGLE, limit: 100 })).items.map((i) => i.id),
    ).not.toContain(upcoming);
  });
});
