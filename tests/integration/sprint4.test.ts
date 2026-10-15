import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { getMigrationDb } from "@/server/db/migration-client";
import { auditLogs, patientMaterialUsages, stockMovements } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant, tenantQuery } from "@/server/tenant/tenant-query";
import { createRoom } from "@/server/services/org";
import { assignDoctorBranch, createDoctor } from "@/server/services/doctors";
import { addWorkingHour } from "@/server/services/schedule";
import { createPatient } from "@/server/services/patients";
import { createClinicalService, setDoctorServices } from "@/server/services/clinical-services";
import {
  cancelAppointment,
  createAppointment,
  updateAppointmentStatus,
} from "@/server/services/appointments";
import {
  addStock,
  adjustStock,
  createCategory,
  createInventoryItem,
  createLocation,
  getInventoryDashboard,
  getInventoryItem,
  getLowStockItems,
  getStockByLocation,
  listInventoryItems,
  listStockMovements,
  reconcileStockBalance,
  transferStock,
  verifyStockBalance,
} from "@/server/services/inventory";
import {
  addPatientMaterialUsageItem,
  createPatientMaterialUsage,
  finalizePatientMaterialUsage,
  getPatientMaterialUsage,
  listPatientMaterialUsage,
  recordMaterialUsage,
  setServiceMaterialTemplates,
  voidPatientMaterialUsage,
} from "@/server/services/material-usage";
import { addDays, dateInZone, isoDayOfWeek, parseTime, zonedDateTimeToUtc } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Sprint 4 — stok, lokasyon, değişmez defter, transfer, hasta malzeme kullanımı (taslak / kesinleştir / VOID),
 * hizmet şablonları, kritik stok, uzlaştırma, kapsam (kiracı / şube / doktor), RLS, eşzamanlılık.
 * Her şey uygulama rolüyle (kliniva_app); migration rolü yalnızca fikstür ve kurcalama simülasyonu için.
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let D1: string;
let D2: string;
let R1: string; // Şube A · PROCEDURE odası
let S_PRP: string;
let CAT: string;
let PUNCH: string;
let SYRINGE: string;
let NEEDLE: string;
let KIT: string;
let WH_A: string; // Şube A ana depo
let ROOM_A: string; // Şube A · Oda 1 lokasyonu
let WH_B: string; // Şube B ana depo
let BITEM: string; // Kiracı B ürünü
let BLOC: string; // Kiracı B lokasyonu
const P: string[] = [];

const owner = () => A.users.owner!.ctx;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};
const tally = (rs: string[]) =>
  rs.reduce<Record<string, number>>((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});
const qty = async (item: string, loc: string) =>
  runInTenant(A.id, async (s) => {
    const r = await s.tx.execute<{ q: string | null }>(
      sql`select quantity::text q from kliniva.stock_balances where inventory_item_id = ${item} and location_id = ${loc}`,
    );
    return Number(r.rows[0]?.q ?? 0);
  });

function monday(weeks: number): string {
  let d = addDays(dateInZone(new Date(), TZ), 7);
  while (isoDayOfWeek(d) !== 1) d = addDays(d, 1);
  return addDays(d, weeks * 7);
}
const at = (date: string, hhmm: string) => zonedDateTimeToUtc(date, parseTime(hhmm)!, TZ).toISOString();

/** IN_PROGRESS randevu (D1 veya D2, PRP, Oda 1). */
async function inProgress(patient: string, doctor: string, date: string, time: string) {
  const { id } = await createAppointment(A.users.reception!.ctx, {
    patientId: patient,
    branchId: A.branchA,
    doctorId: doctor,
    serviceId: S_PRP,
    start: at(date, time),
  });
  await updateAppointmentStatus(A.users.reception!.ctx, id, { status: "CHECKED_IN" });
  await updateAppointmentStatus(owner(), id, { status: "IN_PROGRESS" });
  return id;
}

async function newLocation(name: string, branch = A.branchA) {
  return (await createLocation(owner(), { branchId: branch, type: "BRANCH_WAREHOUSE", name })).id;
}

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    admin: { role: "CLINIC_ADMIN" },
    managerA: { role: "BRANCH_MANAGER", branch: "A" },
    reception: { role: "RECEPTION" },
    assistantA: { role: "ASSISTANT", branch: "A" },
    assistantB: { role: "ASSISTANT", branch: "B" },
    invmgr: { role: "INVENTORY_MANAGER" },
    docA: { role: "DOCTOR" },
    docB: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });

  R1 = (await createRoom(owner(), { branchId: A.branchA, name: "Oda 1", type: "PROCEDURE" })).id;
  D1 = (await createDoctor(owner(), { mode: "existing", userId: A.users.docA!.id, specialty: "Dermatoloji" }))
    .id;
  D2 = (await createDoctor(owner(), { mode: "existing", userId: A.users.docB!.id, specialty: "Estetik" })).id;
  for (const d of [D1, D2]) {
    await assignDoctorBranch(owner(), d, A.branchA);
    await addWorkingHour(owner(), {
      doctorId: d,
      branchId: A.branchA,
      dayOfWeek: 1,
      startTime: "08:00",
      endTime: "20:00",
    });
  }
  S_PRP = (
    await createClinicalService(owner(), {
      name: "PRP",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
    })
  ).id;
  for (const d of [D1, D2])
    await setDoctorServices(owner(), { doctorId: d, services: [{ serviceId: S_PRP }] });

  CAT = (await createCategory(owner(), { name: "Medikal Sarf" })).id;
  const item = async (name: string, c: string, min?: string) =>
    (
      await createInventoryItem(owner(), {
        name,
        code: c,
        unit: "PIECE",
        categoryId: CAT,
        minimumStockLevel: min,
      })
    ).id;
  PUNCH = await item("Punch 5 mm", "PUNCH-5MM");
  SYRINGE = await item("Enjektör 5 ml", "SYR-5");
  NEEDLE = await item("İğne ucu 30G", "NDL-30G");
  KIT = await item("PRP Kit", "PRP-KIT");

  WH_A = await newLocation("İstanbul Ana Depo");
  ROOM_A = (await createLocation(owner(), { branchId: A.branchA, type: "ROOM", roomId: R1 })).id;
  WH_B = await newLocation("Ankara Ana Depo", A.branchB);

  BITEM = (await createInventoryItem(B.users.owner!.ctx, { name: "B ürünü", unit: "PIECE" })).id;
  BLOC = (
    await createLocation(B.users.owner!.ctx, {
      branchId: B.branchA,
      type: "BRANCH_WAREHOUSE",
      name: "B depo",
    })
  ).id;

  for (let i = 0; i < 25; i++) {
    P.push(
      (
        await createPatient(owner(), {
          firstName: `Stok${i}`,
          lastName: "Hasta",
          phone: `0537${String(1000000 + i)}`,
          branchId: A.branchA,
        })
      ).id,
    );
  }
}, 240_000);

afterAll(cleanupTenants);

// ================================================================ katalog + lokasyon
describe("Ürün, kategori, lokasyon", () => {
  it("yeni ürün stoksuz başlar (sayı uydurulmaz); kod tekil; ad / kod / barkod araması; sayfalama en fazla 100", async () => {
    expect((await getInventoryItem(owner(), PUNCH)).totalStock).toBe("0.000");
    expect(
      await code(createInventoryItem(owner(), { name: "Kopya", code: "PUNCH-5MM", unit: "PIECE" })),
    ).toBe("CONFLICT");
    expect((await listInventoryItems(owner(), { q: "punch" })).items.map((i) => i.id)).toEqual([PUNCH]);
    expect((await listInventoryItems(owner(), { q: "SYR-5" })).items.map((i) => i.id)).toEqual([SYRINGE]);
    const r = await listInventoryItems(owner(), {});
    expect(r.limit).toBe(25);
    expect(await code(listInventoryItems(owner(), { limit: 500 }))).toBe("VALIDATION");
  });

  it("oda lokasyonu: oda başına tek, oda aynı şubeden olmalı", async () => {
    expect(await code(createLocation(owner(), { branchId: A.branchA, type: "ROOM", roomId: R1 }))).toBe(
      "CONFLICT",
    );
    expect(await code(createLocation(owner(), { branchId: A.branchB, type: "ROOM", roomId: R1 }))).toBe(
      "NOT_FOUND",
    );
    // DB: A şubesinin (lokasyonu olmayan) odası B şubesinin lokasyonu olamaz — bileşik FK.
    const spare = (await createRoom(owner(), { branchId: A.branchA, name: "Yedek Oda", type: "OTHER" })).id;
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.execute(sql`insert into kliniva.inventory_locations (tenant_id, branch_id, type, room_id, name)
          values (${A.id}, ${A.branchB}, 'ROOM', ${spare}, 'Yanlış şube')`),
      ),
    );
    expect(err.code).toBe("23503");
  });
});

// ================================================================ giriş / düzeltme / transfer
describe("Stok girişi, düzeltme, transfer", () => {
  it("ilk stok yalnızca bir kez; sonra alım; bakiye = defter", async () => {
    expect(
      (
        await addStock(owner(), {
          inventoryItemId: PUNCH,
          locationId: WH_A,
          quantity: "50",
          kind: "INITIAL_STOCK",
        })
      ).balance,
    ).toBe("50.000");
    expect(
      await code(
        addStock(owner(), { inventoryItemId: PUNCH, locationId: WH_A, quantity: "5", kind: "INITIAL_STOCK" }),
      ),
    ).toBe("CONFLICT");
    await addStock(owner(), {
      inventoryItemId: PUNCH,
      locationId: WH_A,
      quantity: "10",
      kind: "PURCHASE",
      reference: "IRS-1",
    });
    for (const [it, q] of [
      [SYRINGE, "100"],
      [NEEDLE, "200"],
      [KIT, "20"],
    ] as const) {
      await addStock(owner(), { inventoryItemId: it, locationId: WH_A, quantity: q, kind: "INITIAL_STOCK" });
    }
    expect(await qty(PUNCH, WH_A)).toBe(60);
    expect((await verifyStockBalance(owner(), { inventoryItemId: PUNCH, locationId: WH_A })).ok).toBe(true);
  });

  it("düzeltme: gerekçe zorunlu; fazla çıkış INSUFFICIENT_STOCK; negatif stok yok", async () => {
    expect(
      await code(
        adjustStock(owner(), {
          inventoryItemId: PUNCH,
          locationId: WH_A,
          direction: "OUT",
          quantity: "1",
          reason: "",
        }),
      ),
    ).toBe("VALIDATION");
    await adjustStock(owner(), {
      inventoryItemId: PUNCH,
      locationId: WH_A,
      direction: "OUT",
      quantity: "5",
      reason: "Sayım farkı",
    });
    await adjustStock(owner(), {
      inventoryItemId: PUNCH,
      locationId: WH_A,
      direction: "IN",
      quantity: "5",
      reason: "Yanlış düşüm düzeltmesi",
    });
    expect(
      await code(
        adjustStock(owner(), {
          inventoryItemId: PUNCH,
          locationId: WH_A,
          direction: "OUT",
          quantity: "61",
          reason: "Fazla",
        }),
      ),
    ).toBe("INSUFFICIENT_STOCK");
    expect(await qty(PUNCH, WH_A)).toBe(60);
  });

  it("depo → oda transferi atomik: kaynak azalır, hedef artar; yetersizse hiçbir şey değişmez", async () => {
    for (const [it, q] of [
      [PUNCH, "5"],
      [SYRINGE, "10"],
      [NEEDLE, "20"],
      [KIT, "5"],
    ] as const) {
      await transferStock(owner(), {
        inventoryItemId: it,
        fromLocationId: WH_A,
        toLocationId: ROOM_A,
        quantity: q,
      });
    }
    expect([await qty(PUNCH, WH_A), await qty(PUNCH, ROOM_A)]).toEqual([55, 5]);
    expect(
      await code(
        transferStock(owner(), {
          inventoryItemId: PUNCH,
          fromLocationId: ROOM_A,
          toLocationId: WH_A,
          quantity: "6",
        }),
      ),
    ).toBe("INSUFFICIENT_STOCK");
    expect([await qty(PUNCH, WH_A), await qty(PUNCH, ROOM_A)]).toEqual([55, 5]);
  });

  it("şubeler arası transfer: şube müdürü yapamaz; özel yetkili (yönetici) yapabilir", async () => {
    expect(
      await code(
        transferStock(A.users.managerA!.ctx, {
          inventoryItemId: PUNCH,
          fromLocationId: WH_A,
          toLocationId: WH_B,
          quantity: "1",
        }),
      ),
    ).not.toBe("OK");
    expect(
      await code(
        transferStock(A.users.admin!.ctx, {
          inventoryItemId: PUNCH,
          fromLocationId: WH_A,
          toLocationId: WH_B,
          quantity: "1",
        }),
      ),
    ).toBe("OK");
    expect(await qty(PUNCH, WH_B)).toBe(1);
  });
});

// ================================================================ değişmez defter (DB)
describe("Defter değişmezliği ve bakiye koruması (DB)", () => {
  it("uygulama rolü: hareket UPDATE/DELETE ve bakiye yazma yetkisi YOK (42501)", async () => {
    for (const stmt of [
      sql`update kliniva.stock_movements set quantity = 999`,
      sql`delete from kliniva.stock_movements`,
      sql`update kliniva.stock_balances set quantity = 999`,
      sql`insert into kliniva.stock_balances (tenant_id, inventory_item_id, location_id, quantity) values (${A.id}, ${PUNCH}, ${WH_B}, 5)`,
    ]) {
      expect((await dbError(runInTenant(A.id, (s) => s.tx.execute(stmt)))).code).toBe("42501");
    }
  });

  it("sahip rol bile hareketi güncelleyemez / silemez (tetikleyici)", async () => {
    const run = (stmt: ReturnType<typeof sql>) =>
      getMigrationDb().transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${A.id}, true)`);
        await tx.execute(stmt);
      });
    expect(
      (await dbError(run(sql`update kliniva.stock_movements set reason = 'x' where tenant_id = ${A.id}`)))
        .message,
    ).toMatch(/KLINIVA_IMMUTABLE/);
    expect(
      (await dbError(run(sql`delete from kliniva.stock_movements where tenant_id = ${A.id}`))).message,
    ).toMatch(/KLINIVA_IMMUTABLE/);
  });

  it("servisi atlayan ham çıkış hareketi yetersiz stokta reddedilir (negatif stok imkânsız)", async () => {
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.stock_movements (tenant_id, inventory_item_id, movement_type, from_location_id, quantity, reason, created_by_user_id)
          values (${A.id}, ${PUNCH}, 'ADJUSTMENT_OUT', ${ROOM_A}, 1000, 'test', ${A.users.owner!.id})`),
      ),
    );
    expect(err.message).toMatch(/KLINIVA_INSUFFICIENT_STOCK/);
    expect(await qty(PUNCH, ROOM_A)).toBe(5);
  });
});

// ================================================================ 46 / 47 eşzamanlılık
describe("Eşzamanlılık", () => {
  it("Concurrent Stock Usage: 1 Punch, 20 eşzamanlı kesinleştirme → 1 başarılı, 19 INSUFFICIENT_STOCK, bakiye 0", async () => {
    const L = await newLocation("Eşzamanlı Depo");
    await addStock(owner(), { inventoryItemId: PUNCH, locationId: L, quantity: "1", kind: "INITIAL_STOCK" });
    const drafts: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { id } = await createPatientMaterialUsage(owner(), { patientId: P[i]!, branchId: A.branchA });
      await addPatientMaterialUsageItem(owner(), id, {
        inventoryItemId: PUNCH,
        locationId: L,
        quantity: "1",
      });
      drafts.push(id);
    }
    const results = await Promise.all(drafts.map((d) => code(finalizePatientMaterialUsage(owner(), d))));
    expect(tally(results)).toEqual({ OK: 1, INSUFFICIENT_STOCK: 19 });
    expect(await qty(PUNCH, L)).toBe(0);
    const moves = await runInTenant(A.id, (s) =>
      s.tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(and(eq(stockMovements.fromLocationId, L), eq(stockMovements.movementType, "PATIENT_USAGE"))),
    );
    expect(moves).toHaveLength(1);
  }, 180_000);

  it("Transfer Concurrency: 10 adet, 20 eşzamanlı 1'er transfer → en fazla 10 başarılı, toplam korunur, negatif yok", async () => {
    const L1 = await newLocation("Transfer Kaynak");
    const L2 = await newLocation("Transfer Hedef");
    await addStock(owner(), {
      inventoryItemId: SYRINGE,
      locationId: L1,
      quantity: "10",
      kind: "INITIAL_STOCK",
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        code(
          transferStock(owner(), {
            inventoryItemId: SYRINGE,
            fromLocationId: L1,
            toLocationId: L2,
            quantity: "1",
          }),
        ),
      ),
    );
    expect(tally(results)).toEqual({ OK: 10, INSUFFICIENT_STOCK: 10 });
    expect([await qty(SYRINGE, L1), await qty(SYRINGE, L2)]).toEqual([0, 10]);
    expect((await verifyStockBalance(owner(), { inventoryItemId: SYRINGE, locationId: L2 })).ok).toBe(true);
  }, 180_000);
});

// ================================================================ 48 / 49 kullanım
describe("Hasta malzeme kullanımı", () => {
  it("Atomic Multi-Item: biri yetersizse hiçbir stok düşmez, kısmi hareket yok, kullanım DRAFT kalır", async () => {
    const before = [await qty(PUNCH, ROOM_A), await qty(SYRINGE, ROOM_A), await qty(NEEDLE, ROOM_A)];
    const { id } = await createPatientMaterialUsage(owner(), { patientId: P[0]!, branchId: A.branchA });
    await addPatientMaterialUsageItem(owner(), id, {
      inventoryItemId: PUNCH,
      locationId: ROOM_A,
      quantity: "1",
    });
    await addPatientMaterialUsageItem(owner(), id, {
      inventoryItemId: SYRINGE,
      locationId: ROOM_A,
      quantity: "2",
    });
    await addPatientMaterialUsageItem(owner(), id, {
      inventoryItemId: NEEDLE,
      locationId: ROOM_A,
      quantity: "500",
    });
    expect(await code(finalizePatientMaterialUsage(owner(), id))).toBe("INSUFFICIENT_STOCK");
    expect([await qty(PUNCH, ROOM_A), await qty(SYRINGE, ROOM_A), await qty(NEEDLE, ROOM_A)]).toEqual(before);
    const m = await runInTenant(A.id, (s) =>
      s.tx.select().from(stockMovements).where(eq(stockMovements.patientUsageId, id)),
    );
    expect(m).toHaveLength(0);
    expect((await getPatientMaterialUsage(owner(), id)).status).toBe("DRAFT");
  });

  it("taslak stok düşürmez; kesinleştirme düşürür; kesinleşmiş kalemler değişmez", async () => {
    const before = await qty(PUNCH, ROOM_A);
    const { id } = await createPatientMaterialUsage(owner(), {
      patientId: P[1]!,
      branchId: A.branchA,
      notes: "Gizli kullanım notu",
    });
    await addPatientMaterialUsageItem(owner(), id, {
      inventoryItemId: PUNCH,
      locationId: ROOM_A,
      quantity: "1",
    });
    expect(await qty(PUNCH, ROOM_A)).toBe(before);
    await finalizePatientMaterialUsage(owner(), id);
    expect(await qty(PUNCH, ROOM_A)).toBe(before - 1);
    expect(
      await code(
        addPatientMaterialUsageItem(owner(), id, {
          inventoryItemId: SYRINGE,
          locationId: ROOM_A,
          quantity: "1",
        }),
      ),
    ).toBe("INVALID_STATUS_TRANSITION");
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.execute(
          sql`update kliniva.patient_material_usage_items set quantity = 9 where patient_usage_id = ${id}`,
        ),
      ),
    );
    expect(err.message).toMatch(/KLINIVA_IMMUTABLE/);
    expect((await getPatientMaterialUsage(owner(), id)).notes).toBe("Gizli kullanım notu");
    const raw = await runInTenant(A.id, (s) =>
      s.tx
        .select({ n: patientMaterialUsages.notesEncrypted })
        .from(patientMaterialUsages)
        .where(eq(patientMaterialUsages.id, id)),
    );
    expect(raw[0]!.n).not.toContain("Gizli");
  });

  it("VOID: ters hareketler stoğu geri ekler, orijinaller kalır, VOIDED; ikinci VOID reddedilir; gerekçe zorunlu", async () => {
    const [p0, s0] = [await qty(PUNCH, ROOM_A), await qty(SYRINGE, ROOM_A)];
    const { id } = await createPatientMaterialUsage(owner(), { patientId: P[2]!, branchId: A.branchA });
    await addPatientMaterialUsageItem(owner(), id, {
      inventoryItemId: PUNCH,
      locationId: ROOM_A,
      quantity: "1",
    });
    await addPatientMaterialUsageItem(owner(), id, {
      inventoryItemId: SYRINGE,
      locationId: ROOM_A,
      quantity: "2",
    });
    await finalizePatientMaterialUsage(owner(), id);
    expect([await qty(PUNCH, ROOM_A), await qty(SYRINGE, ROOM_A)]).toEqual([p0 - 1, s0 - 2]);
    expect(await code(voidPatientMaterialUsage(A.users.managerA!.ctx, id, { reason: "Yanlış hasta" }))).toBe(
      "FORBIDDEN",
    );
    expect(await code(voidPatientMaterialUsage(owner(), id, { reason: "" }))).toBe("VALIDATION");
    await voidPatientMaterialUsage(owner(), id, { reason: "Yanlış hasta seçildi" });
    expect([await qty(PUNCH, ROOM_A), await qty(SYRINGE, ROOM_A)]).toEqual([p0, s0]);
    const moves = await runInTenant(A.id, (s) =>
      s.tx
        .select({ t: stockMovements.movementType })
        .from(stockMovements)
        .where(eq(stockMovements.patientUsageId, id)),
    );
    expect(tally(moves.map((m) => m.t))).toEqual({ PATIENT_USAGE: 2, RETURN_FROM_PATIENT_USAGE: 2 });
    expect((await getPatientMaterialUsage(owner(), id)).status).toBe("VOIDED");
    expect(await code(voidPatientMaterialUsage(owner(), id, { reason: "tekrar" }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
  });

  it("Voice AI'ye hazır tek adım (recordMaterialUsage) + kesinleştirme", async () => {
    const before = await qty(NEEDLE, ROOM_A);
    const r = await recordMaterialUsage(owner(), {
      patientId: P[3]!,
      branchId: A.branchA,
      items: [{ inventoryItemId: NEEDLE, quantity: 2, locationId: ROOM_A }],
      finalize: true,
    });
    expect(r.finalized).toBe(true);
    expect(await qty(NEEDLE, ROOM_A)).toBe(before - 2);
  });
});

// ================================================================ 18 / 20 / 21 randevu + şablon
describe("Randevu bağlantısı ve hizmet şablonu", () => {
  it("şablon yalnızca öneri: taslağa gelir, stok değişmez; kesinleştirince düşer", async () => {
    await setServiceMaterialTemplates(owner(), {
      clinicalServiceId: S_PRP,
      items: [
        { inventoryItemId: KIT, defaultQuantity: "1", required: true },
        { inventoryItemId: NEEDLE, defaultQuantity: "2" },
      ],
    });
    const [k0, n0] = [await qty(KIT, ROOM_A), await qty(NEEDLE, ROOM_A)];
    const appt = await inProgress(P[4]!, D1, monday(0), "09:00");
    const { id } = await createPatientMaterialUsage(owner(), { patientId: P[4]!, appointmentId: appt });
    const draft = await getPatientMaterialUsage(owner(), id);
    expect(draft.lines.map((l) => [l.inventoryItemId, l.quantity, l.locationId]).sort()).toEqual(
      [
        [KIT, "1.000", ROOM_A],
        [NEEDLE, "2.000", ROOM_A],
      ].sort(),
    );
    expect([await qty(KIT, ROOM_A), await qty(NEEDLE, ROOM_A)]).toEqual([k0, n0]);
    await addPatientMaterialUsageItem(owner(), id, {
      inventoryItemId: NEEDLE,
      locationId: ROOM_A,
      quantity: "3",
    });
    await finalizePatientMaterialUsage(owner(), id);
    expect([await qty(KIT, ROOM_A), await qty(NEEDLE, ROOM_A)]).toEqual([k0 - 1, n0 - 3]);
    const list = await listPatientMaterialUsage(owner(), { appointmentId: appt });
    expect(list.map((u) => u.id)).toEqual([id]);
  });

  it("iptal edilmiş / henüz başlamamış randevuya kullanım bağlanamaz; başka hastanın randevusu NOT_FOUND", async () => {
    const booked = (
      await createAppointment(A.users.reception!.ctx, {
        patientId: P[5]!,
        branchId: A.branchA,
        doctorId: D1,
        serviceId: S_PRP,
        start: at(monday(0), "10:00"),
      })
    ).id;
    expect(await code(createPatientMaterialUsage(owner(), { patientId: P[5]!, appointmentId: booked }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    await cancelAppointment(A.users.reception!.ctx, booked, { reason: "Hasta gelmedi" });
    expect(await code(createPatientMaterialUsage(owner(), { patientId: P[5]!, appointmentId: booked }))).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    const other = await inProgress(P[6]!, D1, monday(0), "11:00");
    expect(await code(createPatientMaterialUsage(owner(), { patientId: P[7]!, appointmentId: other }))).toBe(
      "NOT_FOUND",
    );
    // DB: kullanım randevusu başka hastaya / şubeye bağlanamaz (bileşik FK).
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.patient_material_usages (tenant_id, patient_id, appointment_id, branch_id, created_by_user_id)
          values (${A.id}, ${P[7]}, ${other}, ${A.branchA}, ${A.users.owner!.id})`),
      ),
    );
    expect(err.code).toBe("23503");
  });

  it("doktor: kendi randevusuna kullanım girer / kesinleştirir; başka doktorunkine NOT_FOUND; randevusuz VALIDATION", async () => {
    const mine = await inProgress(P[8]!, D1, monday(0), "12:00");
    const theirs = await inProgress(P[9]!, D2, monday(0), "12:00");
    const doc = A.users.docA!.ctx;
    expect(await code(createPatientMaterialUsage(doc, { patientId: P[9]!, appointmentId: theirs }))).toBe(
      "NOT_FOUND",
    );
    expect(await code(createPatientMaterialUsage(doc, { patientId: P[8]!, branchId: A.branchA }))).toBe(
      "VALIDATION",
    );
    const { id } = await createPatientMaterialUsage(doc, {
      patientId: P[8]!,
      appointmentId: mine,
      applyTemplate: false,
    });
    await addPatientMaterialUsageItem(doc, id, {
      inventoryItemId: SYRINGE,
      locationId: ROOM_A,
      quantity: "1",
    });
    await finalizePatientMaterialUsage(doc, id);
    const theirUsage = (
      await createPatientMaterialUsage(owner(), { patientId: P[9]!, appointmentId: theirs })
    ).id;
    expect(await code(getPatientMaterialUsage(doc, theirUsage))).toBe("NOT_FOUND");
    expect(await code(finalizePatientMaterialUsage(doc, theirUsage))).toBe("NOT_FOUND");
    const visible = await listPatientMaterialUsage(doc, { appointmentId: mine });
    expect(visible.map((u) => u.id)).toEqual([id]);
  });
});

// ================================================================ kapsam + kiracı
describe("Kapsam: şube, kiracı", () => {
  it("asistan B, Şube A kullanımını kesinleştiremez / oluşturamaz; asistan A kendi şubesinde yapabilir", async () => {
    const { id } = await createPatientMaterialUsage(A.users.assistantA!.ctx, {
      patientId: P[10]!,
      branchId: A.branchA,
    });
    await addPatientMaterialUsageItem(A.users.assistantA!.ctx, id, {
      inventoryItemId: NEEDLE,
      locationId: ROOM_A,
      quantity: "1",
    });
    expect(await code(finalizePatientMaterialUsage(A.users.assistantB!.ctx, id))).toBe("NOT_FOUND");
    expect(
      await code(
        createPatientMaterialUsage(A.users.assistantB!.ctx, { patientId: P[10]!, branchId: A.branchA }),
      ),
    ).toBe("NOT_FOUND");
    expect(await code(finalizePatientMaterialUsage(A.users.assistantA!.ctx, id))).toBe("OK");
  });

  it("şube müdürü A başka şubenin stoğunu göremez", async () => {
    const rows = await getStockByLocation(A.users.managerA!.ctx);
    expect(rows.some((r) => r.locationId === WH_B)).toBe(false);
    expect(rows.some((r) => r.locationId === WH_A)).toBe(true);
    expect(
      (await getInventoryItem(A.users.managerA!.ctx, PUNCH)).stockByLocation.map((r) => r.locationId),
    ).not.toContain(WH_B);
    expect(
      await code(
        addStock(A.users.managerA!.ctx, {
          inventoryItemId: PUNCH,
          locationId: WH_B,
          quantity: "1",
          kind: "PURCHASE",
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("Kiracı A, Kiracı B'nin ürününü / lokasyonunu okuyamaz ve onlarla hareket oluşturamaz", async () => {
    expect(await code(getInventoryItem(owner(), BITEM))).toBe("NOT_FOUND");
    expect(
      await code(
        addStock(owner(), { inventoryItemId: BITEM, locationId: WH_A, quantity: "1", kind: "PURCHASE" }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(
        addStock(owner(), { inventoryItemId: PUNCH, locationId: BLOC, quantity: "1", kind: "PURCHASE" }),
      ),
    ).toBe("NOT_FOUND");
    // DB: A bağlamında B ürünüyle hareket — bileşik FK (B ürünü A kiracısında yok).
    const fk = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.stock_movements (tenant_id, inventory_item_id, movement_type, to_location_id, quantity, created_by_user_id)
          values (${A.id}, ${BITEM}, 'PURCHASE', ${WH_A}, 1, ${A.users.owner!.id})`),
      ),
    );
    expect(fk.code).toBe("23503");
    // A bağlamında B kiracı kimliğiyle yazma — RLS WITH CHECK.
    const rls = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.execute(
          sql`insert into kliniva.inventory_categories (tenant_id, name) values (${B.id}, 'Sızma')`,
        ),
      ),
    );
    expect(rls.code).toBe("42501");
  });
});

// ================================================================ kritik stok + uzlaştırma + audit
describe("Kritik stok, uzlaştırma, audit", () => {
  it("min 5, stok 6, kullanım 2 → 4: kritik stok listesinde", async () => {
    const item = (
      await createInventoryItem(owner(), {
        name: "Eldiven",
        code: "GLV",
        unit: "PAIR",
        minimumStockLevel: "5",
      })
    ).id;
    const L = await newLocation("Kritik Depo");
    await addStock(owner(), { inventoryItemId: item, locationId: L, quantity: "6", kind: "INITIAL_STOCK" });
    expect((await getLowStockItems(owner())).low.some((r) => r.itemId === item)).toBe(false);
    await recordMaterialUsage(owner(), {
      patientId: P[11]!,
      branchId: A.branchA,
      items: [{ inventoryItemId: item, quantity: "2", locationId: L }],
      finalize: true,
    });
    const low = await getLowStockItems(owner());
    const row = low.low.find((r) => r.itemId === item)!;
    expect(row.quantity).toBe("4.000");
    const dash = await getInventoryDashboard(owner());
    expect(dash.lowStock).toBeGreaterThan(0);
    expect(dash.todayUsage).toBeGreaterThan(0);
    expect(dash.todayTransfers).toBeGreaterThan(0);
  });

  it("bakiye kurcalanırsa: verify → STOCK_BALANCE_MISMATCH; kuru çalıştırma fark; uygulama → defterle eşit", async () => {
    await getMigrationDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${A.id}, true)`);
      await tx.execute(
        sql`update kliniva.stock_balances set quantity = quantity + 7 where inventory_item_id = ${KIT} and location_id = ${WH_A}`,
      );
    });
    const v = await verifyStockBalance(owner(), { inventoryItemId: KIT, locationId: WH_A });
    expect([v.ok, v.difference]).toEqual([false, "7.000"]);
    const dry = await reconcileStockBalance(owner(), { inventoryItemId: KIT, locationId: WH_A });
    expect([dry.applied, dry.difference]).toEqual([false, "7.000"]);
    expect(
      await code(
        reconcileStockBalance(A.users.managerA!.ctx, { inventoryItemId: KIT, locationId: WH_A, apply: true }),
      ),
    ).toBe("FORBIDDEN");
    const done = await reconcileStockBalance(owner(), {
      inventoryItemId: KIT,
      locationId: WH_A,
      apply: true,
    });
    expect(done.applied).toBe(true);
    expect((await verifyStockBalance(owner(), { inventoryItemId: KIT, locationId: WH_A })).ok).toBe(true);
    const mism = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.tenantId, A.id), eq(auditLogs.action, "STOCK_BALANCE_MISMATCH"))),
    );
    expect(mism.length).toBeGreaterThan(0);
  });

  it("hareket geçmişi sayfalı ve filtreli; PATIENT_USAGE görünür", async () => {
    const r = await listStockMovements(owner(), { inventoryItemId: PUNCH, limit: 5 });
    expect(r.items.length).toBeLessThanOrEqual(5);
    expect(r.total).toBeGreaterThan(5);
    const usage = await listStockMovements(owner(), {
      inventoryItemId: PUNCH,
      movementType: "PATIENT_USAGE",
    });
    expect(usage.items.length).toBeGreaterThan(0);
    expect(usage.items.every((m) => m.movementType === "PATIENT_USAGE")).toBe(true);
    const mgr = await listStockMovements(A.users.managerA!.ctx, { limit: 100 });
    expect(mgr.items.some((m) => m.toLocationName === "Ankara Ana Depo" && m.fromLocationName === null)).toBe(
      false,
    );
  });

  it("audit olayları yazılır; hasta adı / not / gerekçe sızmaz", async () => {
    const audit = await runInTenant(A.id, (s) =>
      s.tx.select().from(auditLogs).where(eq(auditLogs.tenantId, A.id)),
    );
    const actions = new Set(audit.map((r) => r.action));
    for (const a of [
      "INVENTORY_ITEM_CREATED",
      "STOCK_INITIALIZED",
      "STOCK_ADDED",
      "STOCK_ADJUSTED",
      "STOCK_TRANSFERRED",
      "PATIENT_MATERIAL_USAGE_CREATED",
      "PATIENT_MATERIAL_USAGE_FINALIZED",
      "PATIENT_MATERIAL_USAGE_VOIDED",
      "LOW_STOCK_VIEWED",
      "STOCK_BALANCE_MISMATCH",
    ]) {
      expect(actions.has(a as never), a).toBe(true);
    }
    const dump = JSON.stringify(audit);
    for (const secret of ["Gizli kullanım notu", "Yanlış hasta seçildi", "Stok1", "0537100000"]) {
      expect(dump, secret).not.toContain(secret);
    }
  });
});

// ================================================================ RLS + pooled leak
describe("RLS — stok tabloları", () => {
  const NEW = [
    "inventory_categories",
    "inventory_items",
    "inventory_locations",
    "stock_balances",
    "stock_lots",
    "stock_movements",
    "patient_material_usages",
    "patient_material_usage_items",
    "service_material_templates",
  ];

  it("RLS ENABLE + FORCE; bağlam yok → 0 satır; B bağlamında A satırı görünmez", async () => {
    const r = await getPool().query(
      `select c.relname, c.relrowsecurity e, c.relforcerowsecurity f from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'kliniva' and c.relname = any($1)`,
      [NEW],
    );
    expect(r.rowCount).toBe(NEW.length);
    for (const row of r.rows) expect([row.relname, row.e, row.f]).toEqual([row.relname, true, true]);
    for (const t of NEW)
      expect((await getPool().query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
    const c = await getPool().connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.tenant_id', $1, true)", [B.id]);
      for (const t of NEW) {
        expect((await c.query(`select 1 from kliniva.${t} where tenant_id = $1`, [A.id])).rowCount, t).toBe(
          0,
        );
      }
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });

  it("POOLED_CONNECTION_TENANT_CONTEXT_LEAK_TEST (stok tabloları)", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const c1: PoolClient = await pool.connect();
      await c1.query("begin");
      await c1.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      expect(
        (await c1.query("select count(*)::int n from kliniva.stock_movements")).rows[0].n,
      ).toBeGreaterThan(0);
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
        expect(
          (await c2.query(`select count(*)::int n from kliniva.${t} where tenant_id = $1`, [A.id])).rows[0].n,
          t,
        ).toBe(0);
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
            await scope.tx.execute<{ tenant_id: string }>(sql`select tenant_id from kliniva.stock_balances`)
          ).rows,
        }));
      }),
    );
    for (const s of seen) expect(s.rows.every((r) => r.tenant_id === s.expected)).toBe(true);
  });
});
