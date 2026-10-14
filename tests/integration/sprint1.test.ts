import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { AppError } from "@/server/errors";
import { tenantQuery } from "@/server/tenant/tenant-query";
import {
  getClinicProfile,
  readClinicLogo,
  upsertClinicProfile,
  uploadClinicLogo,
} from "@/server/services/clinic";
import {
  createRoom,
  listRooms,
  setBranchWorkingHours,
  createBranchClosure,
  getBranch,
} from "@/server/services/org";
import { assignDoctorBranch, createDoctor, getDoctor, listDoctors } from "@/server/services/doctors";
import {
  addRoomAssignment,
  addScheduleException,
  addWorkingHour,
  deleteWorkingHour,
  getMyDoctorOverview,
  resolveDoctorAvailabilityBase,
  updateWorkingHour,
} from "@/server/services/schedule";
import { GET as logoRoute } from "@/app/api/v1/clinic/logo/route";
import {
  apiRequest,
  cleanupTenants,
  createTenant,
  dbError,
  TEST_PASSWORD,
  type TestTenant,
} from "../support/fixtures";
import { makePng } from "../support/png";

/**
 * Sprint 1 — klinik profili, logo, şube/oda, doktor, planlama, çakışma motoru, müsaitlik, yetki, RLS.
 * Tüm servis ve ham SQL çağrıları uygulama rolüyle (kliniva_app, pooled DATABASE_URL); yalnızca fikstür
 * kurulumu/temizliği migration rolüyle.
 */
const NEW_TABLES = [
  "branch_closures",
  "branch_working_hours",
  "clinic_profiles",
  "doctor_branches",
  "doctor_profiles",
  "doctor_room_assignments",
  "doctor_schedule_exceptions",
  "doctor_working_hours",
];

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};
const errOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected AppError");
};

/** Belirli ISO günün ileri tarihli bir örneği (2030 → geçmiş/bugün etkisi yok). */
function futureDate(isoDay: number, weeksAhead = 0): string {
  const d = new Date(Date.UTC(2030, 0, 7 + weeksAhead * 7)); // 2030-01-07 Pazartesi
  d.setUTCDate(d.getUTCDate() + (isoDay - 1));
  return d.toISOString().slice(0, 10);
}
const MON = 1;
const TUE = 2;

let A: TestTenant;
let B: TestTenant;
let doctorA1: string; // Dr. Ahmet
let doctorA2: string; // Dr. Mehmet
let doctorB1: string;
let roomA1: string; // Şube A · Oda 1
let roomA2: string; // Şube A · Oda 2
let roomAB1: string; // Şube B · Oda 1
let roomB1: string; // Kiracı B
const owner = () => A.users.owner!.ctx;

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    admin: { role: "CLINIC_ADMIN" },
    managerA: { role: "BRANCH_MANAGER", branch: "A" },
    reception: { role: "RECEPTION" },
    docuser: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });

  roomA1 = (await createRoom(owner(), { branchId: A.branchA, name: "Oda 1", type: "EXAMINATION" })).id;
  roomA2 = (await createRoom(owner(), { branchId: A.branchA, name: "Oda 2", type: "PROCEDURE" })).id;
  roomAB1 = (await createRoom(owner(), { branchId: A.branchB, name: "Oda 1", type: "EXAMINATION" })).id;
  roomB1 = (await createRoom(B.users.owner!.ctx, { branchId: B.branchA, name: "Oda 1" })).id;

  doctorA1 = (
    await createDoctor(owner(), {
      mode: "new",
      email: `ahmet@${A.slug}.test`,
      firstName: "Ahmet",
      lastName: "Yılmaz",
      password: TEST_PASSWORD,
      title: "Dr.",
      specialty: "Dermatoloji",
    })
  ).id;
  doctorA2 = (
    await createDoctor(owner(), {
      mode: "new",
      email: `mehmet@${A.slug}.test`,
      firstName: "Mehmet",
      lastName: "Kaya",
      password: TEST_PASSWORD,
      title: "Dr.",
      specialty: "Estetik",
    })
  ).id;
  doctorB1 = (
    await createDoctor(B.users.owner!.ctx, {
      mode: "new",
      email: `b@${B.slug}.test`,
      firstName: "Bora",
      lastName: "B",
      password: TEST_PASSWORD,
      specialty: "Genel",
    })
  ).id;
  for (const d of [doctorA1, doctorA2]) {
    await assignDoctorBranch(owner(), d, A.branchA);
    await assignDoctorBranch(owner(), d, A.branchB);
  }
  await assignDoctorBranch(B.users.owner!.ctx, doctorB1, B.branchA);
});

afterAll(cleanupTenants);

// ================================================================ klinik profili + logo
describe("Klinik profili ve logo — kiracı izolasyonu", () => {
  it("profil kaydedilir ve yalnızca kendi kiracısında okunur", async () => {
    await upsertClinicProfile(owner(), {
      displayName: "ABC Clinic",
      legalName: "ABC Sağlık Hiz. A.Ş.",
      timezone: "Europe/Istanbul",
    });
    expect((await getClinicProfile(owner())).displayName).toBe("ABC Clinic");
    expect((await getClinicProfile(B.users.owner!.ctx)).displayName).not.toBe("ABC Clinic");
  });

  it("Tenant B, Tenant A'nın klinik profilini DB seviyesinde de okuyamaz (RLS)", async () => {
    const c = await getPool().connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.tenant_id', $1, true)", [B.id]);
      const r = await c.query("select display_name from kliniva.clinic_profiles where tenant_id = $1", [
        A.id,
      ]);
      expect(r.rowCount).toBe(0);
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("logo yüklenir; Tenant B A'nın logosunu alamaz (servis + API)", async () => {
    await uploadClinicLogo(owner(), makePng(200, 80));
    const mine = await readClinicLogo(owner());
    expect(mine.subarray(1, 4).toString()).toBe("PNG");
    expect(await code(readClinicLogo(B.users.owner!.ctx))).toBe("NOT_FOUND");
    const res = await logoRoute(apiRequest("/api/v1/clinic/logo", { token: B.users.owner!.token }));
    expect(res.status).toBe(404);
    const ok = await logoRoute(apiRequest("/api/v1/clinic/logo", { token: A.users.owner!.token }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("no-store");
  });

  it("logo doğrulaması: SVG / sahte PNG / geçersiz MIME / büyük dosya reddedilir", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("x"),
    ]);
    const text = Buffer.from("this is a .png file, trust me");
    const big = Buffer.concat([makePng(100, 100), Buffer.alloc(5 * 1024 * 1024)]);
    for (const f of [svg, fakePng, text, big])
      expect(await code(uploadClinicLogo(owner(), f))).toBe("VALIDATION");
  });

  it("logo yönetimi yalnızca clinic.manage (RECEPTION / BRANCH_MANAGER reddedilir)", async () => {
    expect(await code(uploadClinicLogo(A.users.reception!.ctx, makePng()))).toBe("FORBIDDEN");
    expect(await code(upsertClinicProfile(A.users.managerA!.ctx, { displayName: "X Klinik" }))).toBe(
      "FORBIDDEN",
    );
  });
});

// ================================================================ çapraz kiracı ilişkiler
describe("Kiracı güvenli bileşik FK'ler", () => {
  it("Doktor A, Tenant B'nin şubesine atanamaz (servis NOT_FOUND + DB FK)", async () => {
    expect(await code(assignDoctorBranch(owner(), doctorA1, B.branchA))).toBe("NOT_FOUND");
    const err = await dbError(
      getMigrationDb().transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${A.id}, true)`);
        await tx.execute(
          sql`insert into kliniva.doctor_branches (tenant_id, doctor_id, branch_id) values (${A.id}, ${doctorA1}, ${B.branchA})`,
        );
      }),
    );
    expect(err.code).toBe("23503");
  });

  it("Oda (Tenant A) Tenant B şubesiyle eşleşemez; başka şubenin odası atamada kullanılamaz", async () => {
    expect(await code(createRoom(owner(), { branchId: B.branchA, name: "Sızma" }))).toBe("NOT_FOUND");
    const err = await dbError(
      getMigrationDb().transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${A.id}, true)`);
        await tx.execute(sql`
          insert into kliniva.doctor_room_assignments (tenant_id, doctor_id, branch_id, room_id, day_of_week, start_time, end_time)
          values (${A.id}, ${doctorA1}, ${A.branchA}, ${roomB1}, 3, '09:00', '10:00')`);
      }),
    );
    expect(err.code).toBe("23503");
  });

  it("Tenant A kullanıcısı Tenant B doktorunu göremez / planını isteyemez", async () => {
    expect(await code(getDoctor(owner(), doctorB1))).toBe("NOT_FOUND");
    expect((await listDoctors(owner())).map((d) => d.id)).not.toContain(doctorB1);
    expect(
      await code(
        resolveDoctorAvailabilityBase(owner(), {
          doctorId: doctorB1,
          branchId: B.branchA,
          date: futureDate(MON),
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});

// ================================================================ çakışma motoru
describe("Çakışma motoru", () => {
  it("aynı doktor 09:00–12:00 ve 11:00–13:00 → DOCTOR_SCHEDULE_CONFLICT", async () => {
    await addWorkingHour(owner(), {
      doctorId: doctorA1,
      branchId: A.branchA,
      dayOfWeek: MON,
      startTime: "09:00",
      endTime: "12:00",
    });
    const e = await errOf(
      addWorkingHour(owner(), {
        doctorId: doctorA1,
        branchId: A.branchA,
        dayOfWeek: MON,
        startTime: "11:00",
        endTime: "13:00",
      }),
    );
    expect(e.code).toBe("DOCTOR_SCHEDULE_CONFLICT");
  });

  it("bitişik 09:00–12:00 ve 12:00–15:00 → İZİN", async () => {
    expect(
      await code(
        addWorkingHour(owner(), {
          doctorId: doctorA1,
          branchId: A.branchA,
          dayOfWeek: MON,
          startTime: "12:00",
          endTime: "15:00",
        }),
      ),
    ).toBe("OK");
  });

  it("farklı şube ama aynı doktor ve aynı saat → REJECT (mesaj diğer şubeyi söyler)", async () => {
    const e = await errOf(
      addWorkingHour(owner(), {
        doctorId: doctorA1,
        branchId: A.branchB,
        dayOfWeek: MON,
        startTime: "10:00",
        endTime: "11:00",
      }),
    );
    expect(e.code).toBe("DOCTOR_SCHEDULE_CONFLICT");
    expect(e.message).toContain("Şube A");
    expect(e.message).toContain("Ahmet");
  });

  it("aynı oda: Dr A 09:00–12:00, Dr B 11:00–13:00 → ROOM_SCHEDULE_CONFLICT (mesajda yalnızca aynı kiracı)", async () => {
    await addWorkingHour(owner(), {
      doctorId: doctorA2,
      branchId: A.branchA,
      dayOfWeek: MON,
      startTime: "09:00",
      endTime: "17:00",
    });
    await addRoomAssignment(owner(), {
      doctorId: doctorA1,
      branchId: A.branchA,
      roomId: roomA1,
      dayOfWeek: MON,
      startTime: "09:00",
      endTime: "12:00",
    });
    const e = await errOf(
      addRoomAssignment(owner(), {
        doctorId: doctorA2,
        branchId: A.branchA,
        roomId: roomA1,
        dayOfWeek: MON,
        startTime: "11:00",
        endTime: "13:00",
      }),
    );
    expect(e.code).toBe("ROOM_SCHEDULE_CONFLICT");
    expect(e.message).toBe("Bu oda 09:00–12:00 arasında Dr. Ahmet Yılmaz tarafından kullanılıyor.");
    expect(e.message).not.toContain(B.slug);
  });

  it("farklı oda aynı saat → İZİN; bitişik oda kullanımı → İZİN", async () => {
    expect(
      await code(
        addRoomAssignment(owner(), {
          doctorId: doctorA2,
          branchId: A.branchA,
          roomId: roomA2,
          dayOfWeek: MON,
          startTime: "11:00",
          endTime: "13:00",
        }),
      ),
    ).toBe("OK");
    expect(
      await code(
        addRoomAssignment(owner(), {
          doctorId: doctorA2,
          branchId: A.branchA,
          roomId: roomA1,
          dayOfWeek: MON,
          startTime: "13:00",
          endTime: "15:00",
        }),
      ),
    ).toBe("OK");
  });

  it("aynı doktor aynı anda iki odada olamaz", async () => {
    const e = await errOf(
      addRoomAssignment(owner(), {
        doctorId: doctorA1,
        branchId: A.branchA,
        roomId: roomA2,
        dayOfWeek: MON,
        startTime: "10:00",
        endTime: "11:00",
      }),
    );
    expect(e.code).toBe("DOCTOR_SCHEDULE_CONFLICT");
  });

  it("tarihli override: diğer doktorun haftalık odası o tarihte doluysa REJECT; kendi odasını değiştirmek İZİN", async () => {
    const monday = futureDate(MON);
    const e = await errOf(
      addRoomAssignment(owner(), {
        doctorId: doctorA2,
        branchId: A.branchA,
        roomId: roomA1,
        effectiveDate: monday,
        startTime: "10:00",
        endTime: "11:00",
      }),
    );
    expect(e.code).toBe("ROOM_SCHEDULE_CONFLICT");
    // Dr Ahmet o pazartesi 10–11 Oda 2'ye geçer (override; kendi haftalık Oda 1 atamasının yerine geçer).
    // Oda 2'de Mehmet 11–13 → yalnızca bitişik, çakışma yok.
    expect(
      await code(
        addRoomAssignment(owner(), {
          doctorId: doctorA1,
          branchId: A.branchA,
          roomId: roomA2,
          effectiveDate: monday,
          startTime: "10:00",
          endTime: "11:00",
        }),
      ),
    ).toBe("OK");
    // Override sonrası Ahmet'in o tarihte boşalttığı Oda 1 (10–11) başka doktora tarihli olarak verilebilir.
    expect(
      await code(
        addRoomAssignment(owner(), {
          doctorId: doctorA2,
          branchId: A.branchA,
          roomId: roomA1,
          effectiveDate: monday,
          startTime: "10:00",
          endTime: "11:00",
        }),
      ),
    ).toBe("OK");
    // Ama Ahmet'in o tarihte hâlâ Oda 1'de olduğu 11–12 aralığı verilemez.
    const busy = await errOf(
      addRoomAssignment(owner(), {
        doctorId: doctorA2,
        branchId: A.branchA,
        roomId: roomA1,
        effectiveDate: monday,
        startTime: "11:00",
        endTime: "11:30",
      }),
    );
    expect(busy.code).toBe("ROOM_SCHEDULE_CONFLICT");
  });

  it("oda ataması çalışma saatleri dışında olamaz; doktor atanmadığı şubede plan alamaz", async () => {
    expect(
      await code(
        addRoomAssignment(owner(), {
          doctorId: doctorA1,
          branchId: A.branchA,
          roomId: roomA2,
          dayOfWeek: MON,
          startTime: "16:00",
          endTime: "18:00",
        }),
      ),
    ).toBe("VALIDATION");
    expect(
      await code(
        addWorkingHour(owner(), {
          doctorId: doctorB1,
          branchId: A.branchA,
          dayOfWeek: TUE,
          startTime: "09:00",
          endTime: "10:00",
        }),
      ),
    ).not.toBe("OK");
  });

  it("eşzamanlı iki istek (race): aynı oda / aynı saat → yalnızca biri başarılı", async () => {
    await addWorkingHour(owner(), {
      doctorId: doctorA1,
      branchId: A.branchB,
      dayOfWeek: TUE,
      startTime: "09:00",
      endTime: "17:00",
    });
    await addWorkingHour(owner(), {
      doctorId: doctorA2,
      branchId: A.branchB,
      dayOfWeek: TUE,
      startTime: "09:00",
      endTime: "17:00",
    });
    const results = await Promise.all(
      [doctorA1, doctorA2].map((d) =>
        code(
          addRoomAssignment(owner(), {
            doctorId: d,
            branchId: A.branchB,
            roomId: roomAB1,
            dayOfWeek: TUE,
            startTime: "10:00",
            endTime: "12:00",
          }),
        ),
      ),
    );
    expect(results.sort()).toEqual(["OK", "ROOM_SCHEDULE_CONFLICT"]);
  });

  it("DB son savunma hattı: servis atlansa bile exclusion constraint örtüşmeyi reddeder (23P01)", async () => {
    const c = await getPool().connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      await expect(
        c.query(
          `insert into kliniva.doctor_working_hours (tenant_id, doctor_id, branch_id, day_of_week, start_time, end_time)
           values ($1, $2, $3, 1, '10:00', '10:30')`,
          [A.id, doctorA1, A.branchB],
        ),
      ).rejects.toMatchObject({ code: "23P01" });
      await c.query("rollback");
    } finally {
      c.release();
    }
  });

  it("blok güncellemesi oda atamasını dışarıda bırakamaz; blok silinince içindeki atamalar da silinir", async () => {
    const block = await addWorkingHour(owner(), {
      doctorId: doctorA2,
      branchId: A.branchA,
      dayOfWeek: 3,
      startTime: "09:00",
      endTime: "12:00",
      roomId: roomA2,
    });
    expect(await code(updateWorkingHour(owner(), block.id, { startTime: "10:00", endTime: "12:00" }))).toBe(
      "CONFLICT",
    );
    expect(await code(deleteWorkingHour(owner(), block.id))).toBe("OK");
  });
});

// ================================================================ müsaitlik
describe("Müsaitlik temeli (resolveDoctorAvailabilityBase)", () => {
  it("çalışma saatleri + oda atamaları → pencereler (UTC dahil)", async () => {
    const monday = futureDate(MON, 1);
    const r = await resolveDoctorAvailabilityBase(owner(), {
      doctorId: doctorA1,
      branchId: A.branchA,
      date: monday,
    });
    expect(r.reason).toBe("OK");
    expect(r.windows.map((w) => `${w.start}-${w.end}@${w.roomName ?? "-"}`)).toEqual([
      "09:00-12:00@Oda 1",
      "12:00-15:00@-",
    ]);
    expect(r.windows[0]!.startUtc).toBe(`${monday}T06:00:00.000Z`); // İstanbul 09:00 = 06:00Z
  });

  it("ALL_DAY izin → boş; TIME_RANGE izin → ilgili pencere çıkarılır", async () => {
    const d1 = futureDate(MON, 2);
    const d2 = futureDate(MON, 3);
    await addScheduleException(owner(), {
      doctorId: doctorA1,
      date: d1,
      type: "ALL_DAY",
      reason: "Yıllık izin",
    });
    await addScheduleException(owner(), {
      doctorId: doctorA1,
      date: d2,
      type: "TIME_RANGE",
      startTime: "10:00",
      endTime: "11:00",
    });
    const off = await resolveDoctorAvailabilityBase(owner(), {
      doctorId: doctorA1,
      branchId: A.branchA,
      date: d1,
    });
    expect(off.windows).toEqual([]);
    expect(off.reason).toBe("DOCTOR_EXCEPTION");
    const part = await resolveDoctorAvailabilityBase(owner(), {
      doctorId: doctorA1,
      branchId: A.branchA,
      date: d2,
    });
    expect(part.windows.map((w) => `${w.start}-${w.end}`)).toEqual([
      "09:00-10:00",
      "11:00-12:00",
      "12:00-15:00",
    ]);
  });

  it("şube kapalı → boş; şube saatleri etkin → kesişim", async () => {
    const d = futureDate(MON, 4);
    await createBranchClosure(owner(), { branchId: A.branchA, date: d, allDay: true, reason: "Resmi tatil" });
    const closed = await resolveDoctorAvailabilityBase(owner(), {
      doctorId: doctorA1,
      branchId: A.branchA,
      date: d,
    });
    expect(closed.windows).toEqual([]);
    expect(closed.reason).toBe("BRANCH_CLOSED");

    await setBranchWorkingHours(owner(), A.branchA, {
      enabled: true,
      days: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
        dayOfWeek: day,
        enabled: day <= 5,
        startTime: "10:00",
        endTime: "14:00",
      })),
    });
    expect((await getBranch(owner(), A.branchA)).workingHoursEnabled).toBe(true);
    const narrowed = await resolveDoctorAvailabilityBase(owner(), {
      doctorId: doctorA1,
      branchId: A.branchA,
      date: futureDate(MON, 5),
    });
    expect(narrowed.windows.map((w) => `${w.start}-${w.end}`)).toEqual(["10:00-12:00", "12:00-14:00"]);
  });
});

// ================================================================ yetki
describe("Planlama yetkileri", () => {
  const block = (doctorId: string, branchId: string) => ({
    doctorId,
    branchId,
    dayOfWeek: 5,
    startTime: "09:00",
    endTime: "10:00",
  });

  it("RECEPTION doktor planını değiştiremez (görebilir)", async () => {
    expect(await code(addWorkingHour(A.users.reception!.ctx, block(doctorA1, A.branchA)))).toBe("FORBIDDEN");
    expect(
      await code(
        resolveDoctorAvailabilityBase(A.users.reception!.ctx, {
          doctorId: doctorA1,
          branchId: A.branchA,
          date: futureDate(MON),
        }),
      ),
    ).toBe("OK");
  });

  it("DOCTOR başka doktorun planını değiştiremez ve göremez", async () => {
    const doc = A.users.docuser!.ctx;
    expect(await code(addWorkingHour(doc, block(doctorA1, A.branchA)))).toBe("FORBIDDEN");
    expect(
      await code(
        resolveDoctorAvailabilityBase(doc, {
          doctorId: doctorA1,
          branchId: A.branchA,
          date: futureDate(MON),
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("BRANCH_MANAGER kendi şubesini yönetir; başka şubeyi yönetemez / göremez (cross-branch IDOR)", async () => {
    const m = A.users.managerA!.ctx;
    expect(await code(addWorkingHour(m, { ...block(doctorA1, A.branchA), dayOfWeek: 4 }))).toBe("OK");
    expect(await code(addWorkingHour(m, { ...block(doctorA1, A.branchB), dayOfWeek: 6 }))).toBe("NOT_FOUND");
    expect(await code(getBranch(m, A.branchB))).toBe("NOT_FOUND");
    expect((await listRooms(m)).map((r) => r.id)).not.toContain(roomAB1);
    expect(
      await code(
        resolveDoctorAvailabilityBase(m, { doctorId: doctorA1, branchId: A.branchB, date: futureDate(TUE) }),
      ),
    ).toBe("NOT_FOUND");
    expect(await code(createRoom(m, { branchId: A.branchB, name: "Gizli" }))).toBe("FORBIDDEN");
  });

  it("CLINIC_ADMIN planı yönetebilir; ama sağlık yetkisi olmadığı için yeni DOCTOR kullanıcısı açamaz", async () => {
    const admin = A.users.admin!.ctx;
    expect(await code(addWorkingHour(admin, { ...block(doctorA2, A.branchB), dayOfWeek: 6 }))).toBe("OK");
    expect(
      await code(
        createDoctor(admin, {
          mode: "new",
          email: `x@${A.slug}.test`,
          firstName: "Xavi",
          lastName: "Yurt",
          password: TEST_PASSWORD,
          specialty: "Genel Cerrahi",
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("doktor portalı: doktor yalnızca kendi planını görür", async () => {
    const docUser = A.users.docuser!;
    expect(await code(getMyDoctorOverview(docUser.ctx))).toBe("NOT_FOUND"); // profili yok
    const { id } = await createDoctor(owner(), { mode: "existing", userId: docUser.id, specialty: "Genel" });
    await assignDoctorBranch(owner(), id, A.branchA);
    const overview = await getMyDoctorOverview(docUser.ctx);
    expect(overview.doctor.id).toBe(id);
    expect(await code(getMyDoctorOverview(A.users.reception!.ctx))).toBe("FORBIDDEN");
  });
});

// ================================================================ RLS + pool
describe("RLS — yeni tablolar", () => {
  it(`${NEW_TABLES.length} yeni tablonun tamamında RLS ENABLE + FORCE`, async () => {
    const r = await getPool().query(
      `select c.relname, c.relrowsecurity as e, c.relforcerowsecurity as f from pg_class c
         join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'kliniva' and c.relname = any($1)`,
      [NEW_TABLES],
    );
    expect(r.rowCount).toBe(NEW_TABLES.length);
    for (const row of r.rows) expect([row.relname, row.e, row.f]).toEqual([row.relname, true, true]);
  });

  it("kiracı bağlamı yok → yeni tablolarda 0 satır", async () => {
    for (const t of NEW_TABLES) {
      expect((await getPool().query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
    }
  });

  it("POOLED_CONNECTION_TENANT_CONTEXT_LEAK_TEST (planlama tabloları): A sonrası aynı bağlantıda B, A'yı görmez", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const c1: PoolClient = await pool.connect();
      await c1.query("begin");
      await c1.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      const seenA = await c1.query("select count(*)::int n from kliniva.doctor_working_hours");
      expect(seenA.rows[0].n).toBeGreaterThan(0);
      await c1.query("commit");
      c1.release();

      const c2 = await pool.connect();
      expect(c2).toBe(c1);
      expect((await c2.query("select current_setting('app.tenant_id', true) as v")).rows[0]?.v ?? "").toBe(
        "",
      );
      for (const t of NEW_TABLES)
        expect((await c2.query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
      await c2.query("begin");
      await c2.query("select set_config('app.tenant_id', $1, true)", [B.id]);
      const leak = await c2.query(
        "select count(*)::int n from kliniva.doctor_working_hours where tenant_id = $1",
        [A.id],
      );
      expect(leak.rows[0].n).toBe(0);
      await c2.query("rollback");
      c2.release();
    } finally {
      await pool.end();
    }
    // Uygulamanın tenantQuery'si: dönüşümlü 20 istek, her biri yalnızca kendi kiracısının planını görür.
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const ctx = i % 2 ? B.users.owner!.ctx : owner();
        return tenantQuery(ctx, async (scope) => {
          const r = await scope.tx.execute<{ tenant_id: string }>(
            sql`select tenant_id from kliniva.doctor_profiles`,
          );
          return { expected: ctx.tenantId, rows: r.rows };
        });
      }),
    );
    for (const s of seen) expect(s.rows.every((r) => r.tenant_id === s.expected)).toBe(true);
  });
});

// ================================================================ audit
describe("Sprint 1 audit olayları", () => {
  it("yönetim olayları kaydedilir; serbest metin (izin/kapanış nedeni) ve logo baytı audit'e girmez", async () => {
    const rows = await tenantQuery(owner(), async (scope) => {
      const r = await scope.tx.execute<{ action: string; metadata_safe: unknown }>(
        sql`select action, metadata_safe from kliniva.audit_logs`,
      );
      return r.rows;
    });
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
      "CLINIC_PROFILE_UPDATED",
      "CLINIC_LOGO_UPDATED",
      "ROOM_CREATED",
      "DOCTOR_CREATED",
      "DOCTOR_BRANCH_ASSIGNED",
      "DOCTOR_SCHEDULE_CREATED",
      "DOCTOR_SCHEDULE_DELETED",
      "DOCTOR_ROOM_ASSIGNED",
      "DOCTOR_EXCEPTION_CREATED",
      "BRANCH_CLOSURE_CREATED",
      "BRANCH_WORKING_HOURS_UPDATED",
    ]) {
      expect(actions.has(a), a).toBe(true);
    }
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("Yıllık izin");
    expect(dump).not.toContain("Resmi tatil");
    expect(dump).not.toContain("iVBORw0KGgo");
    expect(dump).not.toContain(TEST_PASSWORD);
  });
});

// ================================================================ liste sorguları (bağıntılı alt sorgular)
describe("Liste sorguları — doğru kapsam ve sayımlar", () => {
  it("şube listesi oda / doktor / açık gün sayılarını doğru hesaplar", async () => {
    const { listBranchesWithStats } = await import("@/server/services/org");
    const rows = await listBranchesWithStats(owner());
    const a = rows.find((r) => r.id === A.branchA)!;
    const b = rows.find((r) => r.id === A.branchB)!;
    expect(a.roomCount).toBe(2);
    expect(b.roomCount).toBe(1);
    expect(a.doctorCount).toBeGreaterThanOrEqual(2);
    expect(a.openDays).toBe(5);
    expect(rows.map((r) => r.id)).not.toContain(B.branchA);
  });

  it("doktor adayları: profili olanlar hariç; DOCTOR rolü doğru işaretlenir; başka kiracı yok", async () => {
    const { listDoctorCandidates } = await import("@/server/services/doctors");
    const candidates = await listDoctorCandidates(owner());
    const ids = candidates.map((c) => c.id);
    expect(ids).not.toContain(A.users.docuser!.id); // artık profili var
    expect(ids).toContain(A.users.reception!.id);
    expect(candidates.find((c) => c.id === A.users.reception!.id)?.isDoctorRole).toBe(false);
    expect(ids).not.toContain(B.users.owner!.id);
  });
});
