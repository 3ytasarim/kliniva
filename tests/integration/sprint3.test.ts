import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { appointments, auditLogs } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant, tenantQuery } from "@/server/tenant/tenant-query";
import { createBranchClosure, createRoom } from "@/server/services/org";
import { assignDoctorBranch, createDoctor } from "@/server/services/doctors";
import { addRoomAssignment, addScheduleException, addWorkingHour } from "@/server/services/schedule";
import { createPatient } from "@/server/services/patients";
import {
  createClinicalService,
  listBookableDoctors,
  listDoctorServices,
  setDoctorServices,
} from "@/server/services/clinical-services";
import {
  cancelAppointment,
  createAppointment,
  getAppointment,
  getAppointmentStats,
  getAvailableSlots,
  getDoctorAvailability,
  getTodayAppointments,
  listAppointments,
  listPatientAppointments,
  rescheduleAppointment,
  updateAppointmentNotes,
  updateAppointmentStatus,
} from "@/server/services/appointments";
import { addDays, dateInZone, isoDayOfWeek, parseTime, zonedDateTimeToUtc } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, TEST_PASSWORD, type TestTenant } from "../support/fixtures";

/**
 * Sprint 3 — klinik hizmetleri, uygunluk motoru, oda tahsisi, çakışma motoru (servis + DB), eşzamanlı rezervasyon,
 * taşıma, durum makinesi, doktor/şube/kiracı kapsamı, RLS, audit. Her şey uygulama rolüyle (kliniva_app);
 * migration rolü yalnızca fikstür ve "geçmişe taşıma" simülasyonu için.
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let D1: string; // docA kullanıcısı (DOCTOR) — Şube A + Şube B
let D2: string; // docB kullanıcısı (DOCTOR) — Şube A
let D3: string; // yönetici tarafından oluşturulan doktor — Şube A
let DB1: string; // Kiracı B doktoru
let R1: string; // EXAMINATION
let R2: string; // PROCEDURE
let R3: string; // PROCEDURE
let S_EXAM: string; // Muayene 30 dk — EXAMINATION
let S_PRP: string; // PRP 45 dk — PROCEDURE
let S_CONS: string; // Danışma 30 dk — oda gerekmez
let S_SURG: string; // Cerrahi 60 dk — SURGERY (şubede yok)
const P: string[] = [];
let PB: string; // Kiracı B hastası

const owner = () => A.users.owner!.ctx;
const reception = () => A.users.reception!.ctx;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};

/** Bugünden en az 7 gün sonraki Pazartesi + n hafta (rezervasyon ufku içinde, geçmiş etkisi yok). */
function monday(weeks: number): string {
  let d = addDays(dateInZone(new Date(), TZ), 7);
  while (isoDayOfWeek(d) !== 1) d = addDays(d, 1);
  return addDays(d, weeks * 7);
}
const at = (date: string, hhmm: string) => zonedDateTimeToUtc(date, parseTime(hhmm)!, TZ).toISOString();

const book = (
  ctx: ReturnType<typeof owner>,
  o: {
    patient: string;
    doctor: string;
    date: string;
    time: string;
    service?: string;
    room?: string;
    branch?: string;
  },
) =>
  createAppointment(ctx, {
    patientId: o.patient,
    branchId: o.branch ?? A.branchA,
    doctorId: o.doctor,
    serviceId: o.service,
    start: at(o.date, o.time),
    roomId: o.room,
  });

const slotTimes = async (o: {
  doctor: string;
  date: string;
  service?: string;
  patient?: string;
  ctx?: ReturnType<typeof owner>;
}) =>
  (
    await getAvailableSlots(o.ctx ?? reception(), {
      branchId: A.branchA,
      doctorId: o.doctor,
      serviceId: o.service,
      date: o.date,
      patientId: o.patient,
    })
  ).slots.map((s) => s.start);

const countActive = (doctorId: string, startIso: string) =>
  runInTenant(A.id, async (s) => {
    const r = await s.tx.execute<{ n: number }>(
      sql`select count(*)::int n from kliniva.appointments where doctor_id = ${doctorId} and scheduled_start = ${startIso}::timestamptz and status <> 'CANCELLED'`,
    );
    return r.rows[0]!.n;
  });

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    admin: { role: "CLINIC_ADMIN" },
    managerA: { role: "BRANCH_MANAGER", branch: "A" },
    reception: { role: "RECEPTION" },
    receptionB: { role: "RECEPTION", branch: "B" },
    readonly: { role: "READ_ONLY" },
    docA: { role: "DOCTOR" },
    docB: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });

  R1 = (await createRoom(owner(), { branchId: A.branchA, name: "Oda 1", type: "EXAMINATION" })).id;
  R2 = (await createRoom(owner(), { branchId: A.branchA, name: "Oda 2", type: "PROCEDURE" })).id;
  R3 = (await createRoom(owner(), { branchId: A.branchA, name: "Oda 3", type: "PROCEDURE" })).id;
  await createRoom(owner(), { branchId: A.branchB, name: "Oda B1", type: "EXAMINATION" });

  D1 = (await createDoctor(owner(), { mode: "existing", userId: A.users.docA!.id, specialty: "Dermatoloji" }))
    .id;
  D2 = (await createDoctor(owner(), { mode: "existing", userId: A.users.docB!.id, specialty: "Estetik" })).id;
  D3 = (
    await createDoctor(owner(), {
      mode: "new",
      email: `d3@${A.slug}.test`,
      firstName: "Deniz",
      lastName: "Üç",
      password: TEST_PASSWORD,
      specialty: "Genel",
    })
  ).id;
  DB1 = (
    await createDoctor(B.users.owner!.ctx, {
      mode: "new",
      email: `b@${B.slug}.test`,
      firstName: "Bora",
      lastName: "B",
      password: TEST_PASSWORD,
      specialty: "Genel",
    })
  ).id;
  for (const d of [D1, D2, D3]) await assignDoctorBranch(owner(), d, A.branchA);
  await assignDoctorBranch(owner(), D1, A.branchB);
  await assignDoctorBranch(B.users.owner!.ctx, DB1, B.branchA);
  for (const d of [D1, D2, D3]) {
    await addWorkingHour(owner(), {
      doctorId: d,
      branchId: A.branchA,
      dayOfWeek: 1,
      startTime: "09:00",
      endTime: "17:00",
    });
  }
  await addWorkingHour(owner(), {
    doctorId: D1,
    branchId: A.branchB,
    dayOfWeek: 2,
    startTime: "09:00",
    endTime: "12:00",
  });
  await addWorkingHour(B.users.owner!.ctx, {
    doctorId: DB1,
    branchId: B.branchA,
    dayOfWeek: 1,
    startTime: "09:00",
    endTime: "17:00",
  });

  const svc = (name: string, d: number, requiresRoom: boolean, types: string[]) =>
    createClinicalService(owner(), {
      name,
      defaultDurationMinutes: d,
      requiresRoom,
      allowedRoomTypes: types,
    });
  S_EXAM = (await svc("Muayene", 30, true, ["EXAMINATION"])).id;
  S_PRP = (await svc("PRP", 45, true, ["PROCEDURE"])).id;
  S_CONS = (await svc("Danışma", 30, false, [])).id;
  S_SURG = (await svc("Cerrahi", 60, true, ["SURGERY"])).id;
  await setDoctorServices(owner(), {
    doctorId: D1,
    services: [{ serviceId: S_EXAM }, { serviceId: S_PRP }, { serviceId: S_CONS }, { serviceId: S_SURG }],
  });
  await setDoctorServices(owner(), {
    doctorId: D2,
    services: [{ serviceId: S_EXAM }, { serviceId: S_PRP }, { serviceId: S_CONS }],
  });
  await setDoctorServices(owner(), { doctorId: D3, services: [{ serviceId: S_PRP }] });

  for (let i = 0; i < 45; i++) {
    P.push(
      (
        await createPatient(owner(), {
          firstName: `Hasta${i}`,
          lastName: "Randevu",
          phone: `0536${String(1000000 + i)}`,
          branchId: A.branchA,
        })
      ).id,
    );
  }
  PB = (
    await createPatient(B.users.owner!.ctx, {
      firstName: "B",
      lastName: "Hasta",
      phone: "05369990000",
      branchId: B.branchA,
    })
  ).id;
}, 240_000);

afterAll(cleanupTenants);

// ================================================================ hizmetler
describe("Klinik hizmetleri ve doktor-hizmet eşleşmesi", () => {
  it("doktorun verdiği hizmetler listelenir; doktor seçiminde hizmete göre filtre", async () => {
    expect((await listDoctorServices(reception(), D3)).map((s) => s.name)).toEqual(["PRP"]);
    const prp = await listBookableDoctors(reception(), { branchId: A.branchA, serviceId: S_PRP });
    expect(prp.map((d) => d.id).sort()).toEqual([D1, D2, D3].sort());
    const exam = await listBookableDoctors(reception(), { branchId: A.branchA, serviceId: S_EXAM });
    expect(exam.map((d) => d.id)).not.toContain(D3);
  });

  it("hizmet yönetimi yalnızca service.manage; aynı ad iki kez eklenemez", async () => {
    expect(
      await code(
        createClinicalService(reception(), { name: "X", defaultDurationMinutes: 30, requiresRoom: false }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(
        createClinicalService(owner(), { name: "Muayene", defaultDurationMinutes: 30, requiresRoom: true }),
      ),
    ).toBe("CONFLICT");
  });

  it("doktorun vermediği hizmet için slot yok, randevu VALIDATION", async () => {
    const r = await getAvailableSlots(reception(), {
      branchId: A.branchA,
      doctorId: D3,
      serviceId: S_EXAM,
      date: monday(0),
    });
    expect([r.reason, r.slots.length]).toEqual(["SERVICE_NOT_OFFERED", 0]);
    expect(
      await code(
        book(reception(), { patient: P[0]!, doctor: D3, date: monday(0), time: "09:00", service: S_EXAM }),
      ),
    ).toBe("VALIDATION");
  });
});

// ================================================================ 35. uygunluk
describe("Uygunluk motoru", () => {
  it("çalışma saatleri dışında slot yok; içinde 09:00–16:30 (30 dk, 15 dk adım)", async () => {
    const times = await slotTimes({ doctor: D2, date: monday(0), service: S_CONS });
    expect(times[0]).toBe("09:00");
    expect(times.at(-1)).toBe("16:30");
    expect(times.every((t) => t >= "09:00" && t <= "16:30")).toBe(true);
    const tue = await getAvailableSlots(reception(), {
      branchId: A.branchA,
      doctorId: D2,
      date: addDays(monday(0), 1),
    });
    expect([tue.reason, tue.slots.length]).toEqual(["NOT_WORKING", 0]);
  });

  it("şube kapalı günü slot yok", async () => {
    const date = monday(3);
    await createBranchClosure(owner(), { branchId: A.branchA, date, allDay: true, reason: "Bayram" });
    const r = await getAvailableSlots(reception(), {
      branchId: A.branchA,
      doctorId: D2,
      date,
      serviceId: S_CONS,
    });
    expect([r.reason, r.slots.length]).toEqual(["BRANCH_CLOSED", 0]);
  });

  it("tüm gün izin → slot yok; kısmi izin (12–15) → slotlar bölünür", async () => {
    await addScheduleException(owner(), { doctorId: D2, date: monday(2), type: "ALL_DAY" });
    const allDay = await getAvailableSlots(reception(), {
      branchId: A.branchA,
      doctorId: D2,
      date: monday(2),
      serviceId: S_CONS,
    });
    expect([allDay.reason, allDay.slots.length]).toEqual(["DOCTOR_EXCEPTION", 0]);

    await addScheduleException(owner(), {
      doctorId: D2,
      date: monday(1),
      type: "TIME_RANGE",
      startTime: "12:00",
      endTime: "15:00",
    });
    const t = await slotTimes({ doctor: D2, date: monday(1), service: S_CONS });
    expect(t).toContain("11:30");
    expect(t).not.toContain("11:45"); // 11:45–12:15 izne taşar
    expect(t.filter((x) => x >= "12:00" && x < "15:00")).toEqual([]);
    expect(t).toContain("15:00");
  });

  it("mevcut randevu ilgili slotu düşürür; iptal edilince slot geri gelir", async () => {
    const date = monday(0);
    const { id } = await book(reception(), {
      patient: P[1]!,
      doctor: D2,
      date,
      time: "13:00",
      service: S_CONS,
    });
    let t = await slotTimes({ doctor: D2, date, service: S_CONS });
    expect(t).not.toContain("13:00");
    expect(t).not.toContain("12:45");
    expect(t).toContain("13:30");
    await cancelAppointment(reception(), id, { reason: "Hasta aradı" });
    t = await slotTimes({ doctor: D2, date, service: S_CONS });
    expect(t).toContain("13:00");
  });

  it("oda dolu → başka uygun oda varsa slot kalır ve o oda atanır; tüm uygun odalar dolu → slot yok", async () => {
    const date = monday(4);
    const a1 = await book(reception(), {
      patient: P[2]!,
      doctor: D1,
      date,
      time: "10:00",
      service: S_PRP,
      room: R2,
    });
    expect((await getAppointment(owner(), a1.id)).room?.id).toBe(R2);
    expect(await slotTimes({ doctor: D3, date, service: S_PRP })).toContain("10:00");
    const a2 = await book(reception(), { patient: P[3]!, doctor: D2, date, time: "10:00", service: S_PRP });
    expect((await getAppointment(owner(), a2.id)).room?.id).toBe(R3);
    expect(await slotTimes({ doctor: D3, date, service: S_PRP })).not.toContain("10:00");
    expect(
      await code(book(reception(), { patient: P[4]!, doctor: D3, date, time: "10:00", service: S_PRP })),
    ).toBe("ROOM_APPOINTMENT_CONFLICT");
  });

  it("hizmetin oda tipi şubede yoksa slot yok (NO_ROOM)", async () => {
    const r = await getAvailableSlots(reception(), {
      branchId: A.branchA,
      doctorId: D1,
      serviceId: S_SURG,
      date: monday(0),
    });
    expect([r.reason, r.slots.length]).toEqual(["NO_ROOM", 0]);
  });

  it("çok günlük uygunluk özeti (tarih seçici)", async () => {
    const r = await getDoctorAvailability(reception(), {
      branchId: A.branchA,
      doctorId: D2,
      serviceId: S_CONS,
      fromDate: monday(0),
      days: 3,
    });
    expect(r.days.map((d) => d.reason)).toEqual(["OK", "NOT_WORKING", "NOT_WORKING"]);
    expect(r.days[0]!.firstSlot).toBe("09:00");
  });
});

// ================================================================ 9 / 41. doktor izni + oda (Sprint 1 düzeltmesi)
describe("Doktor izni → haftalık oda ataması odayı tutmaz", () => {
  it("D2'nin Oda 1 ataması 09–17; D2 12–15 izinli → D1 Muayene yalnızca 12:00–15:00 arasında Oda 1'de", async () => {
    const date = monday(5);
    await addRoomAssignment(owner(), {
      doctorId: D2,
      branchId: A.branchA,
      roomId: R1,
      dayOfWeek: 1,
      startTime: "09:00",
      endTime: "17:00",
    });
    await addScheduleException(owner(), {
      doctorId: D2,
      date,
      type: "TIME_RANGE",
      startTime: "12:00",
      endTime: "15:00",
    });
    const t = await slotTimes({ doctor: D1, date, service: S_EXAM });
    expect(t.length).toBeGreaterThan(0);
    expect(t.every((x) => x >= "12:00" && x <= "14:30")).toBe(true);
    expect(t).toContain("12:00");
    expect(t).toContain("14:30");
    // İzinsiz bir pazartesi: Oda 1 tüm gün D2'de → D1 için Muayene slotu yok.
    const busy = await getAvailableSlots(reception(), {
      branchId: A.branchA,
      doctorId: D1,
      serviceId: S_EXAM,
      date: monday(6),
    });
    expect([busy.reason, busy.slots.length]).toEqual(["NO_ROOM", 0]);
  });

  it("D2 tüm gün izinli → Oda 1 o gün tamamen boş; tarihli oda ataması da artık çakışma vermez", async () => {
    const date = monday(7);
    await addScheduleException(owner(), { doctorId: D2, date, type: "ALL_DAY" });
    const t = await slotTimes({ doctor: D1, date, service: S_EXAM });
    expect(t[0]).toBe("09:00");
    expect(t.at(-1)).toBe("16:30");
    // Sprint 1'de ROOM_SCHEDULE_CONFLICT veriyordu:
    expect(
      await code(
        addRoomAssignment(owner(), {
          doctorId: D1,
          branchId: A.branchA,
          roomId: R1,
          effectiveDate: date,
          startTime: "09:00",
          endTime: "12:00",
        }),
      ),
    ).toBe("OK");
    // İzinsiz günde aynı istek hâlâ çakışmadır.
    expect(
      await code(
        addRoomAssignment(owner(), {
          doctorId: D1,
          branchId: A.branchA,
          roomId: R1,
          effectiveDate: monday(8),
          startTime: "09:00",
          endTime: "12:00",
        }),
      ),
    ).toBe("ROOM_SCHEDULE_CONFLICT");
  });
});

// ================================================================ 36. çakışma
describe("Çakışma motoru", () => {
  const date = () => monday(9);

  it("doktor çakışması red; bitişik randevu serbest", async () => {
    await book(reception(), { patient: P[5]!, doctor: D2, date: date(), time: "09:00", service: S_CONS });
    expect(
      await code(
        book(reception(), { patient: P[6]!, doctor: D2, date: date(), time: "09:15", service: S_CONS }),
      ),
    ).toBe("APPOINTMENT_CONFLICT");
    expect(
      await code(
        book(reception(), { patient: P[6]!, doctor: D2, date: date(), time: "09:30", service: S_CONS }),
      ),
    ).toBe("OK");
  });

  it("hasta çakışması red (farklı doktor bile olsa): PATIENT_APPOINTMENT_CONFLICT", async () => {
    await book(reception(), { patient: P[7]!, doctor: D2, date: date(), time: "10:00", service: S_CONS });
    expect(
      await code(
        book(reception(), { patient: P[7]!, doctor: D1, date: date(), time: "10:15", service: S_CONS }),
      ),
    ).toBe("PATIENT_APPOINTMENT_CONFLICT");
  });

  it("oda çakışması red (seçilen oda dolu); farklı doktor + farklı oda serbest", async () => {
    await book(reception(), {
      patient: P[8]!,
      doctor: D1,
      date: date(),
      time: "11:00",
      service: S_PRP,
      room: R2,
    });
    expect(
      await code(
        book(reception(), {
          patient: P[9]!,
          doctor: D3,
          date: date(),
          time: "11:00",
          service: S_PRP,
          room: R2,
        }),
      ),
    ).toBe("ROOM_APPOINTMENT_CONFLICT");
    expect(
      await code(
        book(reception(), {
          patient: P[9]!,
          doctor: D3,
          date: date(),
          time: "11:00",
          service: S_PRP,
          room: R3,
        }),
      ),
    ).toBe("OK");
  });

  it("DB son savunma: servis atlanırsa da doktor / oda / hasta örtüşmesi exclusion constraint ile reddedilir", async () => {
    const start = at(date(), "15:00");
    const end = at(date(), "15:30");
    const ins = (doctor: string, patient: string, room: string | null) =>
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.appointments (tenant_id, branch_id, patient_id, doctor_id, room_id, scheduled_start, scheduled_end, timezone, duration_minutes, created_by_user_id)
          values (${A.id}, ${A.branchA}, ${patient}, ${doctor}, ${room}, ${start}::timestamptz, ${end}::timestamptz, ${TZ}, 30, ${A.users.owner!.id})`),
      );
    await ins(D3, P[10]!, R2);
    expect((await dbError(ins(D3, P[11]!, null))).code).toBe("23P01"); // doktor
    expect((await dbError(ins(D2, P[11]!, R2))).code).toBe("23P01"); // oda
    expect((await dbError(ins(D2, P[10]!, null))).code).toBe("23P01"); // hasta
  });

  it("geçmişe randevu: APPOINTMENT_IN_PAST; ufuk dışı: BOOKING_OUT_OF_RANGE; ızgara dışı saat: SLOT_NOT_AVAILABLE", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    expect(
      await code(
        createAppointment(reception(), {
          patientId: P[12]!,
          branchId: A.branchA,
          doctorId: D2,
          serviceId: S_CONS,
          start: past,
        }),
      ),
    ).toBe("APPOINTMENT_IN_PAST");
    const far = new Date(Date.now() + 400 * 24 * 3600_000).toISOString();
    expect(
      await code(
        createAppointment(reception(), {
          patientId: P[12]!,
          branchId: A.branchA,
          doctorId: D2,
          serviceId: S_CONS,
          start: far,
        }),
      ),
    ).toBe("BOOKING_OUT_OF_RANGE");
    expect(
      await code(
        book(reception(), { patient: P[12]!, doctor: D2, date: date(), time: "12:07", service: S_CONS }),
      ),
    ).toBe("SLOT_NOT_AVAILABLE");
    expect(
      await code(
        book(reception(), { patient: P[12]!, doctor: D2, date: date(), time: "18:00", service: S_CONS }),
      ),
    ).toBe("SLOT_NOT_AVAILABLE");
  });

  it("çakışma reddi audit'lenir (APPOINTMENT_CONFLICT, yalnızca kimlik + kod)", async () => {
    const rows = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.tenantId, A.id), eq(auditLogs.action, "APPOINTMENT_CONFLICT"))),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => (r.metadataSafe as Record<string, unknown>).code)).toEqual(
      expect.arrayContaining([
        "APPOINTMENT_CONFLICT",
        "PATIENT_APPOINTMENT_CONFLICT",
        "ROOM_APPOINTMENT_CONFLICT",
      ]),
    );
  });
});

// ================================================================ 8 / 40. eşzamanlı rezervasyon
describe("Eşzamanlı rezervasyon (Concurrent Booking Test)", () => {
  it("aynı doktor + aynı slot için 40 eşzamanlı istek → tam 1 başarılı, 39 APPOINTMENT_CONFLICT, DB'de 1 kayıt", async () => {
    const date = monday(10);
    const results = await Promise.all(
      P.slice(0, 40).map((p) =>
        code(book(reception(), { patient: p, doctor: D2, date, time: "10:00", service: S_CONS })),
      ),
    );
    const tally = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});
    expect(tally).toEqual({ OK: 1, APPOINTMENT_CONFLICT: 39 });
    expect(await countActive(D2, at(date, "10:00"))).toBe(1);
  }, 180_000);

  it("aynı oda için iki farklı doktor eşzamanlı → 1 başarılı, 1 ROOM_APPOINTMENT_CONFLICT", async () => {
    const date = monday(10);
    const r = await Promise.all([
      code(book(reception(), { patient: P[41]!, doctor: D1, date, time: "14:00", service: S_PRP, room: R2 })),
      code(book(reception(), { patient: P[42]!, doctor: D3, date, time: "14:00", service: S_PRP, room: R2 })),
    ]);
    expect(r.sort()).toEqual(["OK", "ROOM_APPOINTMENT_CONFLICT"]);
  });

  it("servis kilitleri olmadan bile: 20 eşzamanlı ham INSERT (ayrı bağlantılar) → 1 başarılı, 19 × 23P01", async () => {
    const date = monday(11);
    const start = at(date, "09:00");
    const end = at(date, "09:30");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
    try {
      const outcomes = await Promise.all(
        P.slice(0, 20).map(async (p) => {
          const c = await pool.connect();
          try {
            await c.query("begin");
            await c.query("select set_config('app.tenant_id', $1, true)", [A.id]);
            await c.query(
              `insert into kliniva.appointments (tenant_id, branch_id, patient_id, doctor_id, scheduled_start, scheduled_end, timezone, duration_minutes, created_by_user_id)
               values ($1, $2, $3, $4, $5, $6, $7, 30, $8)`,
              [A.id, A.branchA, p, D3, start, end, TZ, A.users.owner!.id],
            );
            await c.query("commit");
            return "OK";
          } catch (e) {
            await c.query("rollback");
            return (e as { code?: string }).code ?? "ERR";
          } finally {
            c.release();
          }
        }),
      );
      expect(outcomes.filter((o) => o === "OK")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "23P01")).toHaveLength(19);
    } finally {
      await pool.end();
    }
    expect(await countActive(D3, start)).toBe(1);
  }, 120_000);
});

// ================================================================ 11. taşıma
describe("Randevu taşıma (atomik)", () => {
  it("dolu slota taşıma reddedilir ve hiçbir şey değişmez; başarılı taşımada eski slot boşalır, yeni dolar", async () => {
    const date = monday(12);
    const a = await book(reception(), { patient: P[13]!, doctor: D2, date, time: "09:00", service: S_CONS });
    await book(reception(), { patient: P[14]!, doctor: D2, date, time: "10:00", service: S_CONS });
    expect(await code(rescheduleAppointment(reception(), a.id, { start: at(date, "10:00") }))).toBe(
      "APPOINTMENT_CONFLICT",
    );
    expect((await getAppointment(owner(), a.id)).localStart).toBe("09:00");

    await rescheduleAppointment(reception(), a.id, { start: at(date, "11:00") });
    const t = await slotTimes({ doctor: D2, date, service: S_CONS });
    expect(t).toContain("09:00");
    expect(t).not.toContain("11:00");
    const d = await getAppointment(owner(), a.id);
    expect(d.localStart).toBe("11:00");
    const ev = d.history.find((h) => h.type === "RESCHEDULED")!;
    expect([ev.metadata.oldStart, ev.metadata.newStart]).toEqual([at(date, "09:00"), at(date, "11:00")]);
  });

  it("kendi eski aralığıyla örtüşen taşıma serbest (09:00 → 09:15)", async () => {
    const date = monday(12);
    const a = await book(reception(), { patient: P[15]!, doctor: D2, date, time: "13:00", service: S_CONS });
    expect(await code(rescheduleAppointment(reception(), a.id, { start: at(date, "13:15") }))).toBe("OK");
  });

  it("tamamlanmış / iptal randevu taşınamaz", async () => {
    const date = monday(12);
    const a = await book(reception(), { patient: P[16]!, doctor: D2, date, time: "15:00", service: S_CONS });
    await cancelAppointment(reception(), a.id, { reason: "Hasta erteledi" });
    expect(await code(rescheduleAppointment(reception(), a.id, { start: at(date, "16:00") }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
  });
});

// ================================================================ 10 / 37. durum makinesi
describe("Durum makinesi", () => {
  it("BOOKED → CONFIRMED → CHECKED_IN → IN_PROGRESS → COMPLETED; geçmiş ve audit kaydı", async () => {
    const a = await book(reception(), {
      patient: P[17]!,
      doctor: D1,
      date: monday(13),
      time: "09:00",
      service: S_CONS,
    });
    await updateAppointmentStatus(reception(), a.id, { status: "CONFIRMED" });
    await updateAppointmentStatus(reception(), a.id, { status: "CHECKED_IN" });
    await updateAppointmentStatus(A.users.docA!.ctx, a.id, { status: "IN_PROGRESS" });
    await updateAppointmentStatus(A.users.docA!.ctx, a.id, { status: "COMPLETED" });
    const d = await getAppointment(owner(), a.id);
    expect(d.status).toBe("COMPLETED");
    expect(d.history.map((h) => h.type)).toEqual([
      "CREATED",
      "CONFIRMED",
      "CHECKED_IN",
      "STARTED",
      "COMPLETED",
    ]);
    expect(d.actions).toEqual([]);
    // COMPLETED → BOOKED / CANCELLED reddedilir (servis + DB)
    expect(await code(cancelAppointment(owner(), a.id, { reason: "geri al" }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.execute(sql`update kliniva.appointments set status = 'BOOKED' where id = ${a.id}`),
      ),
    );
    expect(err.message).toMatch(/KLINIVA_IMMUTABLE/);
  });

  it("geçersiz atlama (BOOKED → COMPLETED) servis ve DB tarafından reddedilir", async () => {
    const a = await book(reception(), {
      patient: P[18]!,
      doctor: D1,
      date: monday(13),
      time: "10:00",
      service: S_CONS,
    });
    expect(await code(updateAppointmentStatus(owner(), a.id, { status: "COMPLETED" }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.execute(
          sql`update kliniva.appointments set status = 'COMPLETED', completed_at = now() where id = ${a.id}`,
        ),
      ),
    );
    expect(err.message).toMatch(/KLINIVA_INVALID_TRANSITION/);
  });

  it("CANCELLED → CONFIRMED reddedilir; iptal gerekçesi zorunlu; fiziksel silme yok", async () => {
    const a = await book(reception(), {
      patient: P[19]!,
      doctor: D1,
      date: monday(13),
      time: "11:00",
      service: S_CONS,
    });
    expect(await code(cancelAppointment(reception(), a.id, {}))).toBe("VALIDATION");
    await cancelAppointment(reception(), a.id, { reason: "Hasta gelemeyecek" });
    expect(await code(updateAppointmentStatus(reception(), a.id, { status: "CONFIRMED" }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    const del = await dbError(
      runInTenant(A.id, (s) => s.tx.execute(sql`delete from kliniva.appointments where id = ${a.id}`)),
    );
    expect(del.code).toBe("42501");
  });

  it("CONFIRMED → NO_SHOW: randevu saati geçmeden reddedilir, geçtikten sonra kabul edilir", async () => {
    const a = await book(reception(), {
      patient: P[20]!,
      doctor: D1,
      date: monday(13),
      time: "12:00",
      service: S_CONS,
    });
    await updateAppointmentStatus(reception(), a.id, { status: "CONFIRMED" });
    expect(await code(updateAppointmentStatus(owner(), a.id, { status: "NO_SHOW" }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    // Zaman geçişi simülasyonu: migration rolüyle randevuyu geçmişe al (tetikleyici CONFIRMED'da zaman değişimine izin verir).
    await getMigrationDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${A.id}, true)`);
      await tx.execute(
        sql`update kliniva.appointments set scheduled_start = now() - interval '2 hours' - interval '7 minutes',
              scheduled_end = now() - interval '90 minutes' - interval '7 minutes' where id = ${a.id}`,
      );
    });
    await updateAppointmentStatus(owner(), a.id, { status: "NO_SHOW" });
    expect((await getAppointment(owner(), a.id)).status).toBe("NO_SHOW");
  });

  it("izin matrisi: resepsiyon başlatamaz; doktor check-in yapamaz", async () => {
    const a = await book(reception(), {
      patient: P[21]!,
      doctor: D1,
      date: monday(13),
      time: "13:00",
      service: S_CONS,
    });
    await updateAppointmentStatus(reception(), a.id, { status: "CHECKED_IN" });
    expect(await code(updateAppointmentStatus(reception(), a.id, { status: "IN_PROGRESS" }))).toBe(
      "FORBIDDEN",
    );
    const b = await book(reception(), {
      patient: P[22]!,
      doctor: D1,
      date: monday(13),
      time: "14:00",
      service: S_CONS,
    });
    expect(await code(updateAppointmentStatus(A.users.docA!.ctx, b.id, { status: "CHECKED_IN" }))).toBe(
      "FORBIDDEN",
    );
  });
});

// ================================================================ 27 / 28 / 38. kapsam ve güvenlik
describe("Kapsam: kiracı, şube, doktor", () => {
  let apptD2: string;
  let apptD1: string;
  let apptBranchB: string;
  let apptTenantB: string;
  const date = () => monday(14);

  beforeAll(async () => {
    apptD2 = (
      await book(reception(), { patient: P[23]!, doctor: D2, date: date(), time: "09:00", service: S_CONS })
    ).id;
    apptD1 = (
      await book(reception(), { patient: P[24]!, doctor: D1, date: date(), time: "09:00", service: S_CONS })
    ).id;
    apptBranchB = (
      await createAppointment(owner(), {
        patientId: P[25]!,
        branchId: A.branchB,
        doctorId: D1,
        start: at(addDays(date(), 1), "09:00"),
      })
    ).id;
    apptTenantB = (
      await createAppointment(B.users.owner!.ctx, {
        patientId: PB,
        branchId: B.branchA,
        doctorId: DB1,
        start: at(date(), "09:00"),
      })
    ).id;
  });

  it("Kiracı A, Kiracı B randevusunu okuyamaz / güncelleyemez (NOT_FOUND)", async () => {
    expect(await code(getAppointment(owner(), apptTenantB))).toBe("NOT_FOUND");
    expect(await code(updateAppointmentStatus(owner(), apptTenantB, { status: "CONFIRMED" }))).toBe(
      "NOT_FOUND",
    );
    expect(await code(cancelAppointment(owner(), apptTenantB, { reason: "deneme" }))).toBe("NOT_FOUND");
    expect(await code(rescheduleAppointment(owner(), apptTenantB, { start: at(date(), "10:00") }))).toBe(
      "NOT_FOUND",
    );
    const list = await listAppointments(B.users.owner!.ctx, { from: date(), to: date() });
    expect(list.map((x) => x.id)).toEqual([apptTenantB]);
  });

  it("çapraz kiracı uygunluk / rezervasyon sızıntısı yok", async () => {
    expect(
      await code(getAvailableSlots(B.users.owner!.ctx, { branchId: A.branchA, doctorId: D2, date: date() })),
    ).toBe("NOT_FOUND");
    expect(
      await code(
        createAppointment(B.users.owner!.ctx, {
          patientId: P[26]!,
          branchId: B.branchA,
          doctorId: DB1,
          start: at(date(), "11:00"),
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("Doktor A, Doktor B'nin randevusunu göremez ve değiştiremez; kendi listesinde yalnızca kendi randevuları", async () => {
    const doc = A.users.docA!.ctx;
    expect(await code(getAppointment(doc, apptD2))).toBe("NOT_FOUND");
    expect(await code(updateAppointmentStatus(doc, apptD2, { status: "IN_PROGRESS" }))).toBe("NOT_FOUND");
    expect((await getAppointment(doc, apptD1)).doctor.id).toBe(D1);
    const mine = await listAppointments(doc, { from: date(), to: addDays(date(), 1) });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.doctor.id === D1)).toBe(true);
    expect(await code(getAvailableSlots(doc, { branchId: A.branchA, doctorId: D2, date: date() }))).toBe(
      "NOT_FOUND",
    );
  });

  it("Şube müdürü A, Şube B randevusunu göremez (IDOR → NOT_FOUND); resepsiyon B, Şube A uygunluğunu göremez", async () => {
    const mgr = A.users.managerA!.ctx;
    expect(await code(getAppointment(mgr, apptBranchB))).toBe("NOT_FOUND");
    expect((await getAppointment(mgr, apptD2)).branch.id).toBe(A.branchA);
    const list = await listAppointments(mgr, { from: date(), to: addDays(date(), 1) });
    expect(list.every((x) => x.branch.id === A.branchA)).toBe(true);
    expect(
      await code(
        getAvailableSlots(A.users.receptionB!.ctx, { branchId: A.branchA, doctorId: D2, date: date() }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await listAppointments(A.users.receptionB!.ctx, { from: date(), to: date(), branchId: A.branchA }),
    ).toEqual([]);
  });

  it("salt okunur rol okur ama oluşturamaz / iptal edemez", async () => {
    const ro = A.users.readonly!.ctx;
    expect((await getAppointment(ro, apptD2)).id).toBe(apptD2);
    expect(
      await code(book(ro, { patient: P[27]!, doctor: D2, date: date(), time: "13:00", service: S_CONS })),
    ).toBe("FORBIDDEN");
    expect(await code(cancelAppointment(ro, apptD2, { reason: "deneme" }))).toBe("FORBIDDEN");
  });

  it("hasta dosyası: yaklaşan randevular; şube kapsamlı kullanıcı yalnızca kendi şubesinin randevularını görür", async () => {
    const own = await listPatientAppointments(owner(), P[25]!);
    expect(own.upcoming.map((x) => x.id)).toContain(apptBranchB);
    // P[25] Şube A kaydı; Şube B randevusu müdür A'ya görünmez.
    const mgr = await listPatientAppointments(A.users.managerA!.ctx, P[25]!);
    expect([...mgr.upcoming, ...mgr.past].map((x) => x.id)).not.toContain(apptBranchB);
  });
});

describe("Notlar, audit ve günlük görünümler", () => {
  it("operasyon notu şifreli saklanır; audit / geçmiş içerik içermez", async () => {
    const a = await createAppointment(reception(), {
      patientId: P[28]!,
      branchId: A.branchA,
      doctorId: D2,
      serviceId: S_CONS,
      start: at(monday(15), "09:00"),
      notes: "Gizli operasyon notu: refakatçi gelecek",
    });
    await updateAppointmentNotes(reception(), a.id, { notes: "İkinci gizli not" });
    expect((await getAppointment(reception(), a.id)).notes).toBe("İkinci gizli not");
    const raw = await runInTenant(A.id, (s) =>
      s.tx.select({ n: appointments.notesEncrypted }).from(appointments).where(eq(appointments.id, a.id)),
    );
    expect(raw[0]!.n).not.toContain("gizli");
    await cancelAppointment(reception(), a.id, { reason: "Özel gerekçe metni" });
    const dump = JSON.stringify(
      await runInTenant(A.id, (s) => s.tx.select().from(auditLogs).where(eq(auditLogs.tenantId, A.id))),
    );
    for (const secret of ["gizli", "refakatçi", "Özel gerekçe", "Hasta28", "Randevu", "05361000028"]) {
      expect(dump, secret).not.toContain(secret);
    }
    const events = JSON.stringify(
      await runInTenant(A.id, (s) =>
        s.tx.execute(
          sql`select metadata_safe from kliniva.appointment_events where appointment_id = ${a.id}`,
        ),
      ),
    );
    expect(events).not.toContain("gizli");
    expect(events).not.toContain("Özel gerekçe");
  });

  it("gerekli audit olayları yazılır", async () => {
    const actions = new Set(
      (
        await runInTenant(A.id, (s) =>
          s.tx.select({ a: auditLogs.action }).from(auditLogs).where(eq(auditLogs.tenantId, A.id)),
        )
      ).map((r) => r.a),
    );
    for (const a of [
      "APPOINTMENT_CREATED",
      "APPOINTMENT_VIEWED",
      "APPOINTMENT_RESCHEDULED",
      "APPOINTMENT_CONFIRMED",
      "APPOINTMENT_CHECKED_IN",
      "APPOINTMENT_STARTED",
      "APPOINTMENT_COMPLETED",
      "APPOINTMENT_CANCELLED",
      "APPOINTMENT_NO_SHOW",
      "APPOINTMENT_CONFLICT",
      "DOCTOR_AVAILABILITY_VIEWED",
    ]) {
      expect(actions.has(a as never), a).toBe(true);
    }
  });

  it("geçmiş (appointment_events) yalnızca ekleme: UPDATE yetkisi yok", async () => {
    const err = await dbError(
      runInTenant(A.id, (s) => s.tx.execute(sql`update kliniva.appointment_events set type = 'CREATED'`)),
    );
    expect(err.code).toBe("42501");
  });

  it("bugünün listesi ve panel sayıları (kapsam içi)", async () => {
    const t = await getTodayAppointments(owner());
    expect(t.today).toBe(dateInZone(new Date(), TZ));
    const s = await getAppointmentStats(owner());
    expect(s.date).toBe(t.today);
    expect(s.total).toBeGreaterThanOrEqual(0);
    const docToday = await getTodayAppointments(A.users.docA!.ctx);
    expect(docToday.items.every((x) => x.doctor.id === D1)).toBe(true);
  });
});

// ================================================================ 29. RLS + pooled leak
describe("RLS — yeni randevu tabloları", () => {
  const NEW = ["clinical_services", "doctor_services", "appointments", "appointment_events"];

  it("RLS ENABLE + FORCE; kiracı bağlamı yok → 0 satır", async () => {
    const r = await getPool().query(
      `select c.relname, c.relrowsecurity e, c.relforcerowsecurity f from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'kliniva' and c.relname = any($1)`,
      [NEW],
    );
    expect(r.rowCount).toBe(NEW.length);
    for (const row of r.rows) expect([row.relname, row.e, row.f]).toEqual([row.relname, true, true]);
    for (const t of NEW)
      expect((await getPool().query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
  });

  it("B bağlamında A satırları görünmez; A kiracı kimliğiyle yazılamaz (42501)", async () => {
    const c = await getPool().connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.tenant_id', $1, true)", [B.id]);
      for (const t of NEW) {
        expect((await c.query(`select 1 from kliniva.${t} where tenant_id = $1`, [A.id])).rowCount, t).toBe(
          0,
        );
      }
      const upd = await c.query(
        "update kliniva.appointments set notes_encrypted = 'x' where tenant_id = $1",
        [A.id],
      );
      expect(upd.rowCount).toBe(0);
      await expect(
        c.query("insert into kliniva.clinical_services (tenant_id, name) values ($1, 'Sızma')", [A.id]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });

  it("POOLED_CONNECTION_TENANT_CONTEXT_LEAK_TEST (randevu tabloları): A sonrası aynı bağlantıda B, A'yı görmez", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const c1: PoolClient = await pool.connect();
      await c1.query("begin");
      await c1.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      expect((await c1.query("select count(*)::int n from kliniva.appointments")).rows[0].n).toBeGreaterThan(
        0,
      );
      await c1.query("commit");
      c1.release();
      const c2 = await pool.connect();
      expect(c2).toBe(c1);
      expect((await c2.query("select current_setting('app.tenant_id', true) as v")).rows[0]?.v ?? "").toBe(
        "",
      );
      for (const t of NEW) expect((await c2.query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
      await c2.query("begin");
      await c2.query("select set_config('app.tenant_id', $1, true)", [B.id]);
      for (const t of NEW) {
        const r = await c2.query(`select count(*)::int n from kliniva.${t} where tenant_id = $1`, [A.id]);
        expect(r.rows[0].n, t).toBe(0);
      }
      await c2.query("rollback");
      c2.release();
    } finally {
      await pool.end();
    }
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const ctx = i % 2 ? B.users.owner!.ctx : A.users.owner!.ctx;
        return tenantQuery(ctx, async (scope) => ({
          expected: ctx.tenantId,
          rows: (
            await scope.tx.execute<{ tenant_id: string }>(sql`select tenant_id from kliniva.appointments`)
          ).rows,
        }));
      }),
    );
    for (const s of seen) expect(s.rows.every((r) => r.tenant_id === s.expected)).toBe(true);
  });
});
