import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getMigrationDb } from "@/server/db/migration-client";
import { createDoctor, assignDoctorBranch } from "@/server/services/doctors";
import { addWorkingHour } from "@/server/services/schedule";
import { createPatient } from "@/server/services/patients";
import { createClinicalService, setDoctorServices } from "@/server/services/clinical-services";
import { AppError } from "@/server/errors";
import { getAppointment, startExamination, updateAppointmentStatus } from "@/server/services/appointments";
import { GET as remindersRoute } from "@/app/api/v1/appointments/reminders/route";
import type { AppointmentReminder } from "@/types/reminders";
import { apiRequest, cleanupTenants, createTenant, type TestTenant } from "../support/fixtures";

/**
 * Saati gelen randevu kartı (GET /api/v1/appointments/reminders) + tek tıkla muayene başlatma.
 *  - Doktor: YALNIZCA kendi randevusu; işlemler: Muayeneyi başlat / Hasta geldi / Gelmedi (saat geçtiyse).
 *  - Başka doktor: görmez. Resepsiyon: Hasta geldi / Gelmedi (başlatamaz). Oturumsuz: 401.
 *  - Muayenede ve bitiş saati geçmiş randevu: "overdue" → Muayeneyi tamamla.
 */
let A: TestTenant;
let D1: string;
let P: string;
let S: string;

/** Bugün, şimdiden göreli zamanda başlayan randevu (fikstür; geçmiş saatli randevu servisle oluşturulamaz). */
async function seedAt(offsetMin: number, durationMin = 30, status = "BOOKED"): Promise<string> {
  const start = new Date(Date.now() + offsetMin * 60_000);
  const end = new Date(start.getTime() + durationMin * 60_000);
  const r = await getMigrationDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${A.id}, true)`);
    return tx.execute<{
      id: string;
    }>(sql`insert into kliniva.appointments (tenant_id, branch_id, patient_id, doctor_id,
      service_id, status, scheduled_start, scheduled_end, timezone, duration_minutes, source, created_by_user_id)
      values (${A.id}, ${A.branchA}, ${P}, ${D1}, ${S}, ${status}, ${start.toISOString()}::timestamptz,
        ${end.toISOString()}::timestamptz, 'Europe/Istanbul', ${durationMin}, 'STAFF', ${A.users.owner!.id})
      returning id`);
  });
  return r.rows[0]!.id;
}

async function reminders(token: string): Promise<{ status: number; data: AppointmentReminder[] }> {
  const res = await remindersRoute(apiRequest("/api/v1/appointments/reminders", { token }));
  const body = (await res.json()) as { data?: AppointmentReminder[] };
  return { status: res.status, data: body.data ?? [] };
}

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION", branch: "A" },
    docA: { role: "DOCTOR" },
    docB: { role: "DOCTOR" },
  });
  const owner = A.users.owner!.ctx;
  D1 = (await createDoctor(owner, { mode: "existing", userId: A.users.docA!.id, specialty: "Dermatoloji" }))
    .id;
  await createDoctor(owner, { mode: "existing", userId: A.users.docB!.id, specialty: "Estetik" });
  S = (
    await createClinicalService(owner, {
      name: "Muayene",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
    })
  ).id;
  await assignDoctorBranch(owner, D1, A.branchA);
  for (let dow = 1; dow <= 7; dow++) {
    await addWorkingHour(owner, {
      doctorId: D1,
      branchId: A.branchA,
      dayOfWeek: dow,
      startTime: "00:00",
      endTime: "23:45",
    });
  }
  await setDoctorServices(owner, { doctorId: D1, services: [{ serviceId: S }] });
  P = (
    await createPatient(owner, {
      firstName: "Saat",
      lastName: "Geldi",
      phone: "05391118001",
      branchId: A.branchA,
    })
  ).id;
}, 120_000);

afterAll(cleanupTenants);

describe("Saati gelen randevu kartı", () => {
  it("doktor kendi randevusunu görür (başlat / geldi / gelmedi); diğer doktor görmez; resepsiyon başlatamaz; oturumsuz 401", async () => {
    const due = await seedAt(-2);
    const future = await seedAt(120);
    const doc = await reminders(A.users.docA!.token);
    expect(doc.status).toBe(200);
    const mine = doc.data.find((r) => r.id === due);
    expect(mine?.kind).toBe("due");
    expect(mine?.patient).toBe("Saat Geldi");
    expect(mine?.actions.map((a) => a.key)).toEqual(["start-exam", "checkin", "no-show"]);
    expect(doc.data.some((r) => r.id === future)).toBe(false); // saati gelmeyen randevu kartta yok
    expect((await reminders(A.users.docB!.token)).data).toEqual([]);
    const rec = await reminders(A.users.reception!.token);
    expect(rec.data.find((r) => r.id === due)?.actions.map((a) => a.key)).toEqual(["checkin", "no-show"]);
    const anon = await remindersRoute(apiRequest("/api/v1/appointments/reminders"));
    expect(anon.status).toBe(401);
    // Resepsiyon, saati geçen ve gelmeyen hastayı "gelmedi" işaretler → kart kapanır (slot da serbest kalır)
    await updateAppointmentStatus(A.users.reception!.ctx, due, { status: "NO_SHOW" });
    expect((await reminders(A.users.docA!.token)).data.some((r) => r.id === due)).toBe(false);
  });

  it("tek tıkla 'Muayeneyi başlat': GELDİ + BAŞLAT (iki geçiş); başka doktor yapamaz; süre aşımında 'tamamla' hatırlatması", async () => {
    const id = await seedAt(-1);
    // Başka doktor: görünmez → işlem yapılmaz; resepsiyon: başlatma yetkisi yok → hiçbir geçiş yapılmaz
    expect(await code(startExamination(A.users.docB!.ctx, id))).toBe("NOT_FOUND");
    expect(await code(startExamination(A.users.reception!.ctx, id))).toBe("FORBIDDEN");
    expect((await getAppointment(A.users.owner!.ctx, id)).status).toBe("BOOKED");
    await startExamination(A.users.docA!.ctx, id);
    const after = await getAppointment(A.users.owner!.ctx, id);
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.history.map((e) => e.type)).toEqual(expect.arrayContaining(["CHECKED_IN", "STARTED"]));

    // Süresi geçmiş muayene → "overdue" + Tamamla
    const overdue = await seedAt(-40, 30);
    await updateAppointmentStatus(A.users.docA!.ctx, overdue, { status: "CHECKED_IN" });
    await updateAppointmentStatus(A.users.docA!.ctx, overdue, { status: "IN_PROGRESS" });
    const doc = await reminders(A.users.docA!.token);
    const o = doc.data.find((x) => x.id === overdue);
    expect([o?.kind, o?.actions.map((a) => a.key)]).toEqual(["overdue", ["complete"]]);
  });
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};
