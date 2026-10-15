import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getPool } from "@/server/db/client";
import { auditLogs, patientMaterialUsageAllocations, stockLots, stockMovements } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { runInTenant, tenantQuery } from "@/server/tenant/tenant-query";
import { createRoom } from "@/server/services/org";
import { upsertClinicProfile } from "@/server/services/clinic";
import { assignDoctorBranch, createDoctor } from "@/server/services/doctors";
import { addWorkingHour } from "@/server/services/schedule";
import { createPatient } from "@/server/services/patients";
import { createClinicalService, setDoctorServices } from "@/server/services/clinical-services";
import { createAppointment } from "@/server/services/appointments";
import {
  addStock,
  adjustStock,
  createInventoryItem,
  createLocation,
  getInventoryDashboard,
  getInventoryItem,
  getLowStockItems,
  listStockMovements,
  transferStock,
  updateInventoryItem,
  verifyStockBalance,
} from "@/server/services/inventory";
import {
  correctLotMetadata,
  findPatientsByLot,
  getExpiringLots,
  getLot,
  getStockByLot,
  recallLot,
  recordPhysicalCount,
  selectFefoLots,
  writeOffLot,
} from "@/server/services/lots";
import {
  addPatientMaterialUsageItem,
  createPatientMaterialUsage,
  finalizePatientMaterialUsage,
  getPatientMaterialUsage,
  listPatientMaterialUsage,
  recordMaterialUsage,
  removePatientMaterialUsageItem,
  setPatientMaterialUsageItemLots,
  voidPatientMaterialUsage,
} from "@/server/services/material-usage";
import { addDays, dateInZone, isoDayOfWeek, parseTime, zonedDateTimeToUtc } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Sprint 5 — lot / parti, SKT, FEFO, hasta lot izlenebilirliği, geri çağırma, imha, fiziksel sayım, kapsam, RLS,
 * eşzamanlılık ve DB havuzu yük doğrulaması. Her şey uygulama rolüyle (kliniva_app).
 * SKT "bugün"ü şubenin saat diliminde (fikstür şubeleri Europe/Istanbul).
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let D1: string;
let S_PRP: string;
let WH_A: string;
let ROOM_A: string;
let WH_B: string;
let BLOC: string;
const P: string[] = [];
let seq = 0;

const owner = () => A.users.owner!.ctx;
const today = () => dateInZone(new Date(), TZ);
const day = (n: number) => addDays(today(), n);
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
const lotQty = async (lotId: string) =>
  runInTenant(A.id, async (s) => {
    const r = await s.tx.execute<{ q: string | null }>(
      sql`select quantity::text q from kliniva.stock_lots where id = ${lotId}`,
    );
    return Number(r.rows[0]?.q ?? NaN);
  });
const balance = async (item: string, loc: string) =>
  runInTenant(A.id, async (s) => {
    const r = await s.tx.execute<{ q: string | null }>(
      sql`select quantity::text q from kliniva.stock_balances where inventory_item_id = ${item} and location_id = ${loc}`,
    );
    return Number(r.rows[0]?.q ?? 0);
  });

async function lotItem(name: string, opts: { expiry?: boolean; min?: string } = {}) {
  seq++;
  return (
    await createInventoryItem(owner(), {
      name: `${name} ${seq}`,
      code: `S5-${seq}`,
      unit: "PIECE",
      trackLots: true,
      trackExpiry: opts.expiry ?? true,
      minimumStockLevel: opts.min,
    })
  ).id;
}
async function stockIn(
  item: string,
  loc: string,
  lotNumber: string,
  expiryDate: string | undefined,
  quantity: string,
) {
  const r = await addStock(owner(), {
    inventoryItemId: item,
    locationId: loc,
    quantity,
    kind: "PURCHASE",
    lotNumber,
    expiryDate,
  });
  return r.stockLotId!;
}
async function newLocation(name: string, branch = A.branchA) {
  return (await createLocation(owner(), { branchId: branch, type: "BRANCH_WAREHOUSE", name })).id;
}
async function draft(patient: string, item: string, loc: string, quantity: string) {
  const { id } = await createPatientMaterialUsage(owner(), { patientId: patient, branchId: A.branchA });
  await addPatientMaterialUsageItem(owner(), id, { inventoryItemId: item, locationId: loc, quantity });
  return id;
}
const firstLine = async (usageId: string) => (await getPatientMaterialUsage(owner(), usageId)).lines[0]!;
const lotMoves = async (lotId: string) =>
  runInTenant(A.id, (s) =>
    s.tx
      .select()
      .from(stockMovements)
      .where(sql`${stockMovements.fromStockLotId} = ${lotId} or ${stockMovements.toStockLotId} = ${lotId}`),
  );
const audits = async (action: string) =>
  runInTenant(A.id, (s) =>
    s.tx
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, action as typeof auditLogs.$inferSelect.action)),
  );

function monday(weeks: number): string {
  let d = addDays(today(), 7);
  while (isoDayOfWeek(d) !== 1) d = addDays(d, 1);
  return addDays(d, weeks * 7);
}
const at = (date: string, hhmm: string) => zonedDateTimeToUtc(date, parseTime(hhmm)!, TZ).toISOString();

beforeAll(async () => {
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    admin: { role: "CLINIC_ADMIN" },
    managerA: { role: "BRANCH_MANAGER", branch: "A" },
    reception: { role: "RECEPTION" },
    assistantA: { role: "ASSISTANT", branch: "A" },
    invmgr: { role: "INVENTORY_MANAGER" },
    docA: { role: "DOCTOR" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });

  const R1 = (await createRoom(owner(), { branchId: A.branchA, name: "Oda 1", type: "PROCEDURE" })).id;
  D1 = (await createDoctor(owner(), { mode: "existing", userId: A.users.docA!.id, specialty: "Dermatoloji" }))
    .id;
  await assignDoctorBranch(owner(), D1, A.branchA);
  await addWorkingHour(owner(), {
    doctorId: D1,
    branchId: A.branchA,
    dayOfWeek: 1,
    startTime: "08:00",
    endTime: "20:00",
  });
  S_PRP = (
    await createClinicalService(owner(), {
      name: "PRP",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
    })
  ).id;
  await setDoctorServices(owner(), { doctorId: D1, services: [{ serviceId: S_PRP }] });

  WH_A = await newLocation("İstanbul Ana Depo");
  ROOM_A = (await createLocation(owner(), { branchId: A.branchA, type: "ROOM", roomId: R1 })).id;
  WH_B = await newLocation("Ankara Ana Depo", A.branchB);
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
          firstName: `Lot${i}`,
          lastName: "Hasta",
          phone: `0538${String(1000000 + i)}`,
          branchId: A.branchA,
        })
      ).id,
    );
  }
}, 300_000);

afterAll(cleanupTenants);

// ================================================================ takip modu
describe("Ürün takip bayrakları", () => {
  it("SKT takibi lot takibi gerektirir (Zod + DB CHECK)", async () => {
    expect(await code(createInventoryItem(owner(), { name: "Hatalı ürün", trackExpiry: true }))).toBe(
      "VALIDATION",
    );
    const plain = (await createInventoryItem(owner(), { name: "Düz ürün", code: "S5-PLAIN-0" })).id;
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.execute(
          sql`update kliniva.inventory_items set track_expiry = true, track_lots = false where id = ${plain}`,
        ),
      ),
    );
    expect(err.code).toBe("23514");
  });

  it("stoklu ürüne lot takibi açılamaz; lot geçmişi olan üründe kapatılamaz; mevcut defter değişmez, uydurma lot yok", async () => {
    const plain = (await createInventoryItem(owner(), { name: "Gazlı bez S5", code: "S5-GAUZE" })).id;
    await addStock(owner(), {
      inventoryItemId: plain,
      locationId: WH_A,
      quantity: "5",
      kind: "INITIAL_STOCK",
    });
    expect(
      await code(
        updateInventoryItem(owner(), plain, { name: "Gazlı bez S5", unit: "PIECE", trackLots: true }),
      ),
    ).toBe("TRACKING_MODE_CHANGE_REQUIRES_MIGRATION");
    expect((await getInventoryItem(owner(), plain)).trackLots).toBe(false);
    const lots = await runInTenant(A.id, (s) =>
      s.tx.select().from(stockLots).where(eq(stockLots.inventoryItemId, plain)),
    );
    expect(lots).toHaveLength(0);
    // lot numarası lot takipsiz üründe reddedilir
    expect(
      await code(
        addStock(owner(), { inventoryItemId: plain, locationId: WH_A, quantity: "1", lotNumber: "X1" }),
      ),
    ).toBe("VALIDATION");

    // Stoksuz ürün: lot takibi açılabilir.
    const empty = (await createInventoryItem(owner(), { name: "Boş ürün S5", code: "S5-EMPTY" })).id;
    await updateInventoryItem(owner(), empty, { name: "Boş ürün S5", unit: "PIECE", trackLots: true });
    expect((await getInventoryItem(owner(), empty)).trackLots).toBe(true);
    await stockIn(empty, WH_A, "E-1", undefined, "2");
    expect(
      await code(
        updateInventoryItem(owner(), empty, { name: "Boş ürün S5", unit: "PIECE", trackLots: false }),
      ),
    ).toBe("LOT_TRACKING_ALREADY_IN_USE");
    // SKT'siz lotu varken SKT takibi açılamaz.
    expect(
      await code(
        updateInventoryItem(owner(), empty, {
          name: "Boş ürün S5",
          unit: "PIECE",
          trackLots: true,
          trackExpiry: true,
        }),
      ),
    ).toBe("TRACKING_MODE_CHANGE_REQUIRES_MIGRATION");
  });
});

// ================================================================ giriş
describe("Lotlu stok girişi", () => {
  it("lot numarası + SKT zorunlu; aynı lot birikir; farklı SKT ile aynı numara reddedilir; bakiye = lot toplamı", async () => {
    const it1 = await lotItem("Dolgu");
    expect(await code(addStock(owner(), { inventoryItemId: it1, locationId: WH_A, quantity: "3" }))).toBe(
      "VALIDATION",
    );
    expect(
      await code(
        addStock(owner(), { inventoryItemId: it1, locationId: WH_A, quantity: "3", lotNumber: "D-1" }),
      ),
    ).toBe("VALIDATION");
    const r1 = await addStock(owner(), {
      inventoryItemId: it1,
      locationId: WH_A,
      quantity: "10",
      kind: "INITIAL_STOCK",
      lotNumber: "D-1",
      expiryDate: day(200),
    });
    const r2 = await addStock(owner(), {
      inventoryItemId: it1,
      locationId: WH_A,
      quantity: "5",
      lotNumber: "D-1",
      expiryDate: day(200),
    });
    expect(r2.stockLotId).toBe(r1.stockLotId);
    expect(await lotQty(r1.stockLotId!)).toBe(15);
    expect(
      await code(
        addStock(owner(), {
          inventoryItemId: it1,
          locationId: WH_A,
          quantity: "1",
          lotNumber: "D-1",
          expiryDate: day(10),
        }),
      ),
    ).toBe("CONFLICT");
    await stockIn(it1, WH_A, "D-2", day(300), "4");
    expect(await balance(it1, WH_A)).toBe(19);
    const v = await verifyStockBalance(owner(), { inventoryItemId: it1, locationId: WH_A });
    expect(v.ok).toBe(true);
    expect(v.lots.map((l) => l.lotNumber)).toEqual(["D-1", "D-2"]);
    expect((await audits("LOT_CREATED")).length).toBeGreaterThanOrEqual(2);
    expect((await audits("LOT_STOCK_ADDED")).length).toBeGreaterThanOrEqual(3);
    // lot listesi
    const byLot = await getStockByLot(owner(), { inventoryItemId: it1 });
    expect(byLot.map((l) => [l.lotNumber, l.quantity, l.status])).toEqual([
      ["D-1", "15.000", "AVAILABLE"],
      ["D-2", "4.000", "AVAILABLE"],
    ]);
  });

  it("DB: lot miktarı / numarası uygulama rolünce yazılamaz; yeni lot dolu başlayamaz; silinemez", async () => {
    const it1 = await lotItem("Koruma");
    const lot = await stockIn(it1, WH_A, "K-1", day(100), "3");
    for (const stmt of [
      sql`update kliniva.stock_lots set quantity = 999 where id = ${lot}`,
      sql`update kliniva.stock_lots set lot_number = 'HACK' where id = ${lot}`,
      sql`delete from kliniva.stock_lots where id = ${lot}`,
    ]) {
      expect((await dbError(runInTenant(A.id, (s) => s.tx.execute(stmt)))).code).toBe("42501");
    }
    const ins = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.stock_lots (tenant_id, inventory_item_id, location_id, lot_number, expiry_date, quantity)
          values (${A.id}, ${it1}, ${WH_A}, 'K-2', ${day(100)}::date, 50)`),
      ),
    );
    expect(ins.message).toMatch(/KLINIVA_INVALID/);
    // lot takipli üründe lotsuz ham hareket reddedilir
    const raw = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.stock_movements (tenant_id, inventory_item_id, movement_type, to_location_id, quantity)
          values (${A.id}, ${it1}, 'PURCHASE', ${WH_A}, 1)`),
      ),
    );
    expect(raw.message).toMatch(/requires lot/);
    expect(await lotQty(lot)).toBe(3);
  });
});

// ================================================================ transfer
describe("Lotlu transfer", () => {
  it("lot kimliği (numara + SKT) korunur; lokasyon ve lot bakiyeleri atomik; hatalı seçimler reddedilir", async () => {
    const it1 = await lotItem("Transfer lot");
    const src = await stockIn(it1, WH_A, "T-1", day(120), "10");
    expect(
      await code(
        transferStock(owner(), {
          inventoryItemId: it1,
          fromLocationId: WH_A,
          toLocationId: ROOM_A,
          quantity: "1",
        }),
      ),
    ).toBe("VALIDATION");
    const r = await transferStock(owner(), {
      inventoryItemId: it1,
      fromLocationId: WH_A,
      toLocationId: ROOM_A,
      quantity: "4",
      fromStockLotId: src,
    });
    const dst = r.toStockLotId!;
    const [s1, d1] = await runInTenant(A.id, (s) =>
      Promise.all([
        s.tx.select().from(stockLots).where(eq(stockLots.id, src)),
        s.tx.select().from(stockLots).where(eq(stockLots.id, dst)),
      ]),
    );
    expect([d1[0]!.lotNumber, d1[0]!.expiryDate, d1[0]!.locationId]).toEqual([
      s1[0]!.lotNumber,
      s1[0]!.expiryDate,
      ROOM_A,
    ]);
    expect([
      await lotQty(src),
      await lotQty(dst),
      await balance(it1, WH_A),
      await balance(it1, ROOM_A),
    ]).toEqual([6, 4, 6, 4]);
    // ikinci transfer aynı hedef lotu kullanır
    expect(
      (
        await transferStock(owner(), {
          inventoryItemId: it1,
          fromLocationId: WH_A,
          toLocationId: ROOM_A,
          quantity: "2",
          fromStockLotId: src,
        })
      ).toStockLotId,
    ).toBe(dst);
    // hedef lokasyondaki lot kaynak lokasyon için seçilemez
    expect(
      await code(
        transferStock(owner(), {
          inventoryItemId: it1,
          fromLocationId: WH_A,
          toLocationId: ROOM_A,
          quantity: "1",
          fromStockLotId: dst,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(
        transferStock(owner(), {
          inventoryItemId: it1,
          fromLocationId: WH_A,
          toLocationId: ROOM_A,
          quantity: "100",
          fromStockLotId: src,
        }),
      ),
    ).toBe("INSUFFICIENT_STOCK");
    expect([await lotQty(src), await lotQty(dst)]).toEqual([4, 6]);
    for (const loc of [WH_A, ROOM_A])
      expect((await verifyStockBalance(owner(), { inventoryItemId: it1, locationId: loc })).ok).toBe(true);
    expect((await audits("LOT_TRANSFERRED")).length).toBeGreaterThanOrEqual(2);
    // hareket geçmişi lot filtresi + lot numarası
    const mv = await listStockMovements(owner(), { stockLotId: dst });
    expect(mv.items.every((m) => m.lotNumber === "T-1")).toBe(true);
    expect(mv.total).toBe(2);
  });

  it("DB: kimliği korumayan ham transfer reddedilir", async () => {
    const it1 = await lotItem("Kimlik");
    const a = await stockIn(it1, WH_A, "I-1", day(50), "5");
    const b = await stockIn(it1, ROOM_A, "I-2", day(50), "1");
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.stock_movements (tenant_id, inventory_item_id, movement_type, from_location_id, to_location_id,
            from_stock_lot_id, to_stock_lot_id, quantity) values (${A.id}, ${it1}, 'TRANSFER', ${WH_A}, ${ROOM_A}, ${a}, ${b}, 1)`),
      ),
    );
    expect(err.message).toMatch(/preserve lot identity/);
    // lot başka lokasyonun lotu → bileşik FK
    const fk = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.stock_movements (tenant_id, inventory_item_id, movement_type, from_location_id, from_stock_lot_id, quantity, reason, created_by_user_id)
          values (${A.id}, ${it1}, 'ADJUSTMENT_OUT', ${WH_A}, ${b}, 1, 'x', ${A.users.owner!.id})`),
      ),
    );
    expect(fk.code).toBe("23503");
  });
});

// ================================================================ FEFO + kullanım
describe("FEFO ve hasta kullanımı", () => {
  it("taslak stok düşürmez + öneri gösterir; kesinleştirme FEFO (çoklu lot); hasta Malzemeler lot no; VOID aynı lota iade", async () => {
    const it1 = await lotItem("Hyalüronik");
    const l1 = await stockIn(it1, ROOM_A, "F-1", day(10), "2");
    const l2 = await stockIn(it1, ROOM_A, "F-2", day(300), "10");
    const l0 = await stockIn(it1, ROOM_A, "F-0", day(-1), "5"); // süresi geçmiş (fiziksel stok)
    const u = await draft(P[0]!, it1, ROOM_A, "3");
    const line = await firstLine(u);
    expect(line.trackLots).toBe(true);
    expect(line.suggested.map((s) => [s.lotNumber, s.quantity])).toEqual([
      ["F-1", "2.000"],
      ["F-2", "1.000"],
    ]);
    expect(line.lotOptions.map((o) => o.lotNumber)).toEqual(["F-1", "F-2"]);
    expect(line.available).toBe("12.000");
    expect(await balance(it1, ROOM_A)).toBe(17);

    const fefo = await selectFefoLots(A.users.docA!.ctx, {
      inventoryItemId: it1,
      locationId: ROOM_A,
      quantity: "3",
    });
    expect(fefo.allocations.map((a) => a.lotNumber)).toEqual(["F-1", "F-2"]);

    await finalizePatientMaterialUsage(owner(), u);
    expect([await lotQty(l1), await lotQty(l2), await lotQty(l0)]).toEqual([0, 9, 5]);
    expect(await balance(it1, ROOM_A)).toBe(14);
    const allocs = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(patientMaterialUsageAllocations)
        .where(eq(patientMaterialUsageAllocations.stockLotId, l1)),
    );
    expect(allocs).toHaveLength(1);
    const mats = await listPatientMaterialUsage(owner(), { patientId: P[0]! });
    const mine = mats.find((m) => m.id === u)!;
    expect(mine.items[0]!.lots.map((l) => l.lotNumber).sort()).toEqual(["F-1", "F-2"]);
    expect((await firstLine(u)).allocations.map((a) => a.lotNumber)).toEqual(["F-1", "F-2"]);

    // fiziksel vs kullanılabilir
    const item = await getInventoryItem(owner(), it1);
    expect([item.totalStock, item.usableStock]).toEqual(["14.000", "9.000"]);

    // audit: hasta kimliği lot kullanım kaydında YOK
    const fin = (await audits("PATIENT_LOT_USAGE_FINALIZED")).find((a) => a.entityId === u)!;
    expect(JSON.stringify(fin.metadataSafe)).not.toContain(P[0]!);
    expect(fin.metadataSafe).toMatchObject({ allocationCount: 2, lots: 2 });

    await voidPatientMaterialUsage(owner(), u, { reason: "Yanlış hasta" });
    expect([await lotQty(l1), await lotQty(l2)]).toEqual([2, 10]);
    const returns = (await lotMoves(l1)).filter((m) => m.movementType === "RETURN_FROM_PATIENT_USAGE");
    expect(returns).toHaveLength(1);
    expect(returns[0]!.toStockLotId).toBe(l1);
    expect((await verifyStockBalance(owner(), { inventoryItemId: it1, locationId: ROOM_A })).ok).toBe(true);
  });

  it("elle seçim: başka lokasyon lotu NOT_FOUND; toplam uyuşmazsa VALIDATION; seçilen (FEFO dışı) lot kullanılır; miktar değişince seçim temizlenir", async () => {
    const it1 = await lotItem("Elle seçim");
    const la = await stockIn(it1, ROOM_A, "M-A", day(10), "5");
    const lb = await stockIn(it1, ROOM_A, "M-B", day(100), "5");
    const lc = await stockIn(it1, WH_A, "M-C", day(5), "5");
    const u = await draft(P[1]!, it1, ROOM_A, "3");
    const row = (await firstLine(u)).id;
    expect(
      await code(
        setPatientMaterialUsageItemLots(owner(), u, row, { lots: [{ stockLotId: lc, quantity: "3" }] }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(
        setPatientMaterialUsageItemLots(owner(), u, row, { lots: [{ stockLotId: lb, quantity: "2" }] }),
      ),
    ).toBe("VALIDATION");
    // B kiracısının lot kimliği → NOT_FOUND (kapsam)
    expect(
      await code(
        setPatientMaterialUsageItemLots(owner(), u, row, {
          lots: [{ stockLotId: "11111111-1111-4111-8111-111111111111", quantity: "3" }],
        }),
      ),
    ).toBe("NOT_FOUND");
    await setPatientMaterialUsageItemLots(owner(), u, row, { lots: [{ stockLotId: lb, quantity: "3" }] });
    const view = await firstLine(u);
    expect(view.allocations.map((a) => a.lotNumber)).toEqual(["M-B"]);
    expect(view.suggested).toEqual([]);
    expect(await lotQty(lb)).toBe(5); // taslak stok düşürmez

    // miktar değişince elle seçim temizlenir → FEFO önerisi
    await addPatientMaterialUsageItem(owner(), u, {
      inventoryItemId: it1,
      locationId: ROOM_A,
      quantity: "2",
    });
    const v2 = await firstLine(u);
    expect(v2.allocations).toEqual([]);
    expect(v2.suggested.map((s) => s.lotNumber)).toEqual(["M-A"]);
    await setPatientMaterialUsageItemLots(owner(), u, v2.id, { lots: [{ stockLotId: lb, quantity: "2" }] });
    await finalizePatientMaterialUsage(owner(), u);
    expect([await lotQty(la), await lotQty(lb)]).toEqual([5, 3]);
    // yetersiz elle seçim
    const u2 = await draft(P[2]!, it1, ROOM_A, "6");
    expect(
      await code(
        setPatientMaterialUsageItemLots(owner(), u2, (await firstLine(u2)).id, {
          lots: [{ stockLotId: la, quantity: "6" }],
        }),
      ),
    ).toBe("INSUFFICIENT_STOCK");
    // seçimli taslak kalem silinebilir
    await setPatientMaterialUsageItemLots(owner(), u2, (await firstLine(u2)).id, {
      lots: [
        { stockLotId: la, quantity: "5" },
        { stockLotId: lb, quantity: "1" },
      ],
    });
    await removePatientMaterialUsageItem(owner(), u2, (await firstLine(u2)).id);
    expect((await getPatientMaterialUsage(owner(), u2)).lines).toHaveLength(0);
  });

  it("recordPatientMaterialUsage (Voice AI'ye hazır) elle lot seçimiyle tek adım", async () => {
    const it1 = await lotItem("Tek adım");
    await stockIn(it1, ROOM_A, "V-1", day(20), "4");
    const lb = await stockIn(it1, ROOM_A, "V-2", day(200), "4");
    const r = await recordMaterialUsage(owner(), {
      patientId: P[3]!,
      branchId: A.branchA,
      items: [
        {
          inventoryItemId: it1,
          locationId: ROOM_A,
          quantity: "1",
          lots: [{ stockLotId: lb, quantity: "1" }],
        },
      ],
      finalize: true,
    });
    expect(r.finalized).toBe(true);
    expect(await lotQty(lb)).toBe(3);
  });
});

// ================================================================ SKT
describe("SKT (son kullanma)", () => {
  it("süresi geçmiş lot hasta kullanımında reddedilir (servis + DB); SKT günü kullanılabilir; kritik stok kullanılabilir stoğa göre", async () => {
    const it1 = await lotItem("Botoks", { min: "3" });
    const old = await stockIn(it1, ROOM_A, "E-OLD", day(-1), "5");
    const tday = await stockIn(it1, ROOM_A, "E-TODAY", day(0), "1");
    const u = await draft(P[4]!, it1, ROOM_A, "1");
    const row = (await firstLine(u)).id;
    expect(
      await code(
        setPatientMaterialUsageItemLots(owner(), u, row, { lots: [{ stockLotId: old, quantity: "1" }] }),
      ),
    ).toBe("LOT_EXPIRED");
    // FEFO 2 adet: kullanılabilir yalnızca 1 → INSUFFICIENT_STOCK, hiçbir şey düşmez
    const u2 = await draft(P[5]!, it1, ROOM_A, "2");
    expect(await code(finalizePatientMaterialUsage(owner(), u2))).toBe("INSUFFICIENT_STOCK");
    expect([await lotQty(old), await lotQty(tday)]).toEqual([5, 1]);
    // kritik stok: fiziksel 6, kullanılabilir 1 ≤ 3
    const low = await getLowStockItems(owner(), {});
    const row1 = low.low.find((l) => l.itemId === it1)!;
    expect([row1.quantity, row1.usableQuantity]).toEqual(["6.000", "1.000"]);
    await finalizePatientMaterialUsage(owner(), u); // SKT bugün → geçerli (FEFO E-TODAY)
    expect(await lotQty(tday)).toBe(0);
    // kullanılabilir 0 → tükenmiş sayılır (fiziksel 5 olsa da)
    expect((await getLowStockItems(owner(), {})).outOfStock.map((o) => o.id)).toContain(it1);
    // DB son savunma: servisi atlayan süresi geçmiş kullanım
    const err = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.stock_movements (tenant_id, inventory_item_id, movement_type, from_location_id, from_stock_lot_id, quantity)
          values (${A.id}, ${it1}, 'PATIENT_USAGE', ${ROOM_A}, ${old}, 1)`),
      ),
    );
    expect(err.message).toMatch(/KLINIVA_LOT_EXPIRED/);
    // panel kartları
    const dash = await getInventoryDashboard(owner(), {});
    expect(dash.lotCards!.expired).toBeGreaterThanOrEqual(1);
    expect(dash.lotCards!.lotTrackedItems).toBeGreaterThanOrEqual(1);
  });

  it("Expiry race: taslakta seçilen lotun SKT'si düzeltilip geçmişe alınırsa kesinleştirme sunucuda LOT_EXPIRED", async () => {
    const it1 = await lotItem("SKT yarışı");
    const lot = await stockIn(it1, ROOM_A, "R-ACE", day(5), "3");
    const u = await draft(P[6]!, it1, ROOM_A, "1");
    await setPatientMaterialUsageItemLots(owner(), u, (await firstLine(u)).id, {
      lots: [{ stockLotId: lot, quantity: "1" }],
    });
    expect(
      await code(
        correctLotMetadata(A.users.docA!.ctx, {
          stockLotId: lot,
          expiryDate: day(-2),
          reason: "Etiket hatası",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(
        correctLotMetadata(A.users.invmgr!.ctx, {
          stockLotId: lot,
          expiryDate: day(-2),
          reason: "Etiket hatası",
        }),
      ),
    ).toBe("FORBIDDEN");
    await correctLotMetadata(owner(), { stockLotId: lot, expiryDate: day(-2), reason: "Etiket hatası" });
    expect(await code(finalizePatientMaterialUsage(owner(), u))).toBe("LOT_EXPIRED");
    expect(await lotQty(lot)).toBe(3);
    const a = (await audits("LOT_METADATA_CORRECTED")).find((x) => x.entityId === lot)!;
    expect(a.metadataSafe).toMatchObject({ previous: day(5), next: day(-2) });
    expect(JSON.stringify(a.metadataSafe)).not.toContain("Etiket");
  });

  it("SKT raporu: yaklaşan (gün penceresi) / geçmiş; filtreler; LOT_EXPIRY_VIEWED", async () => {
    const it1 = await lotItem("Rapor");
    await stockIn(it1, WH_A, "X-SOON", day(7), "2");
    await stockIn(it1, WH_A, "X-LATE", day(90), "2");
    await stockIn(it1, WH_A, "X-PAST", day(-3), "2");
    const soon = await getExpiringLots(owner(), { days: 30, locationId: WH_A });
    const nums = soon.rows.map((r) => r.lotNumber);
    expect(nums).toContain("X-SOON");
    expect(nums).not.toContain("X-LATE");
    expect(nums).not.toContain("X-PAST");
    expect(soon.rows.find((r) => r.lotNumber === "X-SOON")!).toMatchObject({
      daysRemaining: 7,
      status: "EXPIRING_SOON",
    });
    const past = await getExpiringLots(owner(), { kind: "expired", locationId: WH_A });
    expect(past.rows.find((r) => r.lotNumber === "X-PAST")!).toMatchObject({
      daysRemaining: -3,
      status: "EXPIRED",
    });
    expect(
      (await getExpiringLots(owner(), { days: 120, locationId: WH_A })).rows.map((r) => r.lotNumber),
    ).toContain("X-LATE");
    // varsayılan pencere (klinik ayarı 30)
    expect((await getExpiringLots(owner(), { locationId: WH_A })).days).toBe(30);
    // klinik ayarı: pencere 7 gün → X-SOON (7 gün) dahil, sonra varsayılana dön
    await upsertClinicProfile(owner(), { displayName: "Lot Klinik", expiryWarningDays: 7 });
    const w7 = await getExpiringLots(owner(), { locationId: WH_A });
    expect(w7.days).toBe(7);
    expect(w7.rows.map((r) => r.lotNumber)).toContain("X-SOON");
    expect(
      await code(upsertClinicProfile(owner(), { displayName: "Lot Klinik", expiryWarningDays: 0 })),
    ).toBe("VALIDATION");
    await upsertClinicProfile(owner(), { displayName: "Lot Klinik", expiryWarningDays: 30 });
    // şube kapsamı: B şubesi filtresi → A lotları yok
    expect(
      (await getExpiringLots(owner(), { branchId: A.branchB, days: 365 })).rows.map((r) => r.lotNumber),
    ).not.toContain("X-SOON");
    expect(await code(getExpiringLots(A.users.docA!.ctx, {}))).toBe("FORBIDDEN");
    expect((await audits("LOT_EXPIRY_VIEWED")).length).toBeGreaterThanOrEqual(3);
  });
});

// ================================================================ geri çağırma
describe("Geri çağırma (recall)", () => {
  it("yetki + gerekçe; kimliğin tüm satırları; yeni kullanım / transfer / giriş reddedilir; geçmiş değişmez; geri alınamaz", async () => {
    const it1 = await lotItem("Geri çağrılan");
    const wh = await stockIn(it1, WH_A, "RC-1", day(60), "10");
    const room = (
      await transferStock(owner(), {
        inventoryItemId: it1,
        fromLocationId: WH_A,
        toLocationId: ROOM_A,
        quantity: "4",
        fromStockLotId: wh,
      })
    ).toStockLotId!;
    // geri çağırma öncesi kesinleşmiş kullanım (geçmiş)
    const before = await draft(P[7]!, it1, ROOM_A, "1");
    await finalizePatientMaterialUsage(owner(), before);
    // taslakta elle seçilmiş
    const pending = await draft(P[8]!, it1, ROOM_A, "1");
    await setPatientMaterialUsageItemLots(owner(), pending, (await firstLine(pending)).id, {
      lots: [{ stockLotId: room, quantity: "1" }],
    });

    expect(await code(recallLot(owner(), { stockLotId: wh, reason: "" }))).toBe("VALIDATION");
    expect(await code(recallLot(A.users.docA!.ctx, { stockLotId: wh, reason: "Üretici uyarısı" }))).toBe(
      "FORBIDDEN",
    );
    expect(
      await code(recallLot(A.users.assistantA!.ctx, { stockLotId: wh, reason: "Üretici uyarısı" })),
    ).toBe("FORBIDDEN");
    // Geri çağırma kiracı genelidir: stok sorumlusu / şube müdürü yapamaz; izin özel rolle verilse bile şube
    // kapsamlı kullanıcı reddedilir.
    for (const who of ["invmgr", "managerA"] as const) {
      expect(
        await code(recallLot(A.users[who]!.ctx, { stockLotId: wh, reason: "Üretici uyarısı" })),
        who,
      ).toBe("FORBIDDEN");
    }
    const scopedWithPerm = {
      ...A.users.managerA!.ctx,
      permissions: new Set([...A.users.managerA!.ctx.permissions, "inventory.lot.recall" as const]),
    };
    expect(await code(recallLot(scopedWithPerm, { stockLotId: wh, reason: "Üretici uyarısı" }))).toBe(
      "FORBIDDEN",
    );
    // Aynı lot kimliği başka şubede (B şubesi deposu) + başka kiracıda aynı lot numarası
    const otherBranch = (
      await transferStock(owner(), {
        inventoryItemId: it1,
        fromLocationId: WH_A,
        toLocationId: WH_B,
        quantity: "1",
        fromStockLotId: wh,
      })
    ).toStockLotId!;
    const bo = B.users.owner!.ctx;
    const bItem = (
      await createInventoryItem(bo, { name: "B lotlu", unit: "PIECE", trackLots: true, trackExpiry: true })
    ).id;
    const bLot = (
      await addStock(bo, {
        inventoryItemId: bItem,
        locationId: BLOC,
        quantity: "3",
        lotNumber: "RC-1",
        expiryDate: day(60),
      })
    ).stockLotId!;
    const SECRET = "Uretici-gizli-gerekce-7781";
    expect(
      (await recallLot(A.users.admin!.ctx, { stockLotId: wh, reason: `${SECRET} kontaminasyon` }))
        .affectedLots,
    ).toBe(3);
    // diğer şubedeki satır da geri çağrıldı → transfer / kullanım kapalı
    expect(
      await code(
        transferStock(owner(), {
          inventoryItemId: it1,
          fromLocationId: WH_B,
          toLocationId: WH_A,
          quantity: "1",
          fromStockLotId: otherBranch,
        }),
      ),
    ).toBe("LOT_RECALLED");
    // kiracı B etkilenmez
    const bRow = await runInTenant(B.id, (s) => s.tx.select().from(stockLots).where(eq(stockLots.id, bLot)));
    expect(bRow[0]!.recalledAt).toBeNull();
    await addStock(bo, {
      inventoryItemId: bItem,
      locationId: BLOC,
      quantity: "1",
      lotNumber: "RC-1",
      expiryDate: day(60),
    });
    expect((await getLot(bo, bLot)).status).toBe("AVAILABLE");

    expect(await code(finalizePatientMaterialUsage(owner(), pending))).toBe("LOT_RECALLED");
    const fresh = await draft(P[9]!, it1, ROOM_A, "1");
    expect((await firstLine(fresh)).suggested).toEqual([]);
    expect((await firstLine(fresh)).shortfall).toBe(true);
    expect(await code(finalizePatientMaterialUsage(owner(), fresh))).toBe("INSUFFICIENT_STOCK");
    expect(
      await code(
        transferStock(owner(), {
          inventoryItemId: it1,
          fromLocationId: WH_A,
          toLocationId: ROOM_A,
          quantity: "1",
          fromStockLotId: wh,
        }),
      ),
    ).toBe("LOT_RECALLED");
    expect(
      await code(
        addStock(owner(), {
          inventoryItemId: it1,
          locationId: WH_B,
          quantity: "1",
          lotNumber: "RC-1",
          expiryDate: day(60),
        }),
      ),
    ).toBe("LOT_RECALLED");
    // aynı lokasyondaki mevcut (geri çağrılmış) lot satırına da giriş yapılamaz
    expect(
      await code(
        addStock(owner(), {
          inventoryItemId: it1,
          locationId: WH_A,
          quantity: "1",
          lotNumber: "RC-1",
          expiryDate: day(60),
        }),
      ),
    ).toBe("LOT_RECALLED");
    expect(await code(recallLot(owner(), { stockLotId: room, reason: "Tekrar deneme" }))).toBe("CONFLICT");
    expect(
      await code(correctLotMetadata(owner(), { stockLotId: wh, expiryDate: day(90), reason: "Düzeltme" })),
    ).toBe("LOT_RECALLED");
    // geçmiş değişmez
    expect((await getPatientMaterialUsage(owner(), before)).status).toBe("FINALIZED");
    expect([await lotQty(wh), await lotQty(room), await lotQty(otherBranch)]).toEqual([5, 3, 1]);
    // DB: geri alınamaz; gerekçe düz metin değil; audit'te gerekçe yok
    const undo = await dbError(
      runInTenant(A.id, (s) =>
        s.tx.execute(sql`update kliniva.stock_lots set recalled_at = null where id = ${wh}`),
      ),
    );
    expect(undo.message).toMatch(/KLINIVA_IMMUTABLE/);
    const raw = await runInTenant(A.id, (s) =>
      s.tx.execute<{ r: string }>(
        sql`select recall_reason_encrypted r from kliniva.stock_lots where id = ${wh}`,
      ),
    );
    expect(raw.rows[0]!.r).not.toContain(SECRET);
    const rec = (await audits("LOT_RECALLED")).find((a) => a.entityId === wh)!;
    expect(JSON.stringify(rec)).not.toContain(SECRET);
    // durum + kullanılabilir stok
    const lots = await getStockByLot(owner(), { inventoryItemId: it1 });
    expect(lots.every((l) => l.status === "RECALLED" && !l.usable)).toBe(true);
    expect((await getInventoryItem(owner(), it1)).usableStock).toBe("0.000");
    // geri çağrılmış stok imha edilebilir
    await writeOffLot(A.users.invmgr!.ctx, { stockLotId: room, reason: "Üreticiye iade" });
    expect(await lotQty(room)).toBe(0);
  });
});

// ================================================================ imha + sayım
describe("İmha (write-off) ve fiziksel sayım", () => {
  it("yalnızca SKT geçmiş / geri çağrılmış lot imha edilir; gerekçe zorunlu; WRITE_OFF hareketi; yetki", async () => {
    const it1 = await lotItem("İmha");
    const ok = await stockIn(it1, WH_A, "W-OK", day(30), "3");
    const exp = await stockIn(it1, WH_A, "W-EXP", day(-10), "4");
    expect(await code(writeOffLot(owner(), { stockLotId: ok, reason: "Fire" }))).toBe("VALIDATION");
    expect(await code(writeOffLot(owner(), { stockLotId: exp, reason: "" }))).toBe("VALIDATION");
    expect(await code(writeOffLot(A.users.docA!.ctx, { stockLotId: exp, reason: "İmha" }))).toBe("FORBIDDEN");
    expect(await code(writeOffLot(owner(), { stockLotId: exp, quantity: "9", reason: "İmha" }))).toBe(
      "INSUFFICIENT_STOCK",
    );
    const r = await writeOffLot(A.users.invmgr!.ctx, {
      stockLotId: exp,
      quantity: "1",
      reason: "Kısmi imha",
    });
    expect(r.remaining).toBe("3.000");
    await writeOffLot(A.users.invmgr!.ctx, { stockLotId: exp, reason: "SKT geçmiş imha" });
    expect(await lotQty(exp)).toBe(0);
    const moves = (await lotMoves(exp)).filter((m) => m.movementType === "WRITE_OFF");
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.reason)).toBe(true);
    expect((await audits("EXPIRED_STOCK_WRITTEN_OFF")).filter((a) => a.entityId === exp)).toHaveLength(2);
    expect((await verifyStockBalance(owner(), { inventoryItemId: it1, locationId: WH_A })).ok).toBe(true);
  });

  it("sayım: beklenen vs sayılan; onaysız kayıt yok; onayla ADJUSTMENT_IN/OUT; lot takipli üründe lot zorunlu", async () => {
    const it1 = await lotItem("Sayım");
    const lot = await stockIn(it1, WH_A, "C-1", day(100), "10");
    expect(
      await code(
        recordPhysicalCount(owner(), { inventoryItemId: it1, locationId: WH_A, countedQuantity: "8" }),
      ),
    ).toBe("VALIDATION");
    const dry = await recordPhysicalCount(owner(), {
      inventoryItemId: it1,
      locationId: WH_A,
      stockLotId: lot,
      countedQuantity: "8",
    });
    expect([dry.expected, dry.counted, dry.difference, dry.applied]).toEqual([
      "10.000",
      "8.000",
      "-2.000",
      false,
    ]);
    expect(await lotQty(lot)).toBe(10);
    const out = await recordPhysicalCount(A.users.invmgr!.ctx, {
      inventoryItemId: it1,
      locationId: WH_A,
      stockLotId: lot,
      countedQuantity: "8",
      apply: true,
    });
    expect(out.applied).toBe(true);
    expect(await lotQty(lot)).toBe(8);
    await recordPhysicalCount(owner(), {
      inventoryItemId: it1,
      locationId: WH_A,
      stockLotId: lot,
      countedQuantity: "11",
      apply: true,
    });
    expect(await lotQty(lot)).toBe(11);
    const types = (await lotMoves(lot)).map((m) => m.movementType).sort();
    expect(types).toEqual(["ADJUSTMENT_IN", "ADJUSTMENT_OUT", "PURCHASE"]);
    // fark yoksa hareket yok, kayıt var
    const same = await recordPhysicalCount(owner(), {
      inventoryItemId: it1,
      locationId: WH_A,
      stockLotId: lot,
      countedQuantity: "11",
      apply: true,
    });
    expect(same.movementId).toBeNull();
    expect((await audits("PHYSICAL_COUNT_RECORDED")).filter((a) => a.entityId === it1)).toHaveLength(3);
    expect(
      await code(
        recordPhysicalCount(A.users.docA!.ctx, {
          inventoryItemId: it1,
          locationId: WH_A,
          stockLotId: lot,
          countedQuantity: "1",
        }),
      ),
    ).toBe("FORBIDDEN");
    // lot takipsiz ürün
    const plain = (await createInventoryItem(owner(), { name: "Sayım düz", code: "S5-COUNT" })).id;
    await addStock(owner(), {
      inventoryItemId: plain,
      locationId: WH_A,
      quantity: "4",
      kind: "INITIAL_STOCK",
    });
    await recordPhysicalCount(owner(), {
      inventoryItemId: plain,
      locationId: WH_A,
      countedQuantity: "3",
      apply: true,
    });
    expect(await balance(plain, WH_A)).toBe(3);
    // düzeltme (adjustStock) lotlu üründe lot ister
    expect(
      await code(
        adjustStock(owner(), {
          inventoryItemId: it1,
          locationId: WH_A,
          direction: "OUT",
          quantity: "1",
          reason: "Kırık",
        }),
      ),
    ).toBe("VALIDATION");
    await adjustStock(owner(), {
      inventoryItemId: it1,
      locationId: WH_A,
      direction: "OUT",
      quantity: "1",
      reason: "Kırık",
      stockLotId: lot,
    });
    expect(await lotQty(lot)).toBe(10);
  });
});

// ================================================================ izleme + kapsam
describe("Hasta lot izlenebilirliği ve kapsam", () => {
  it("findPatientsByLot: kimlik düzeyi (ad yok), lot kimliğinin tüm satırları; yetki; audit'te hasta kimliği yok", async () => {
    const it1 = await lotItem("İzleme");
    const wh = await stockIn(it1, WH_A, "TR-1", day(80), "6");
    await transferStock(owner(), {
      inventoryItemId: it1,
      fromLocationId: WH_A,
      toLocationId: ROOM_A,
      quantity: "4",
      fromStockLotId: wh,
    });
    const u1 = await draft(P[10]!, it1, ROOM_A, "1");
    await finalizePatientMaterialUsage(owner(), u1);
    const u2 = await draft(P[11]!, it1, ROOM_A, "2");
    await finalizePatientMaterialUsage(owner(), u2);
    await draft(P[12]!, it1, ROOM_A, "1"); // taslak — izlemede görünmez

    const r = await findPatientsByLot(owner(), { stockLotId: wh }); // depo satırı → oda kullanımları da (kimlik)
    expect(r.rows.map((x) => x.patientId).sort()).toEqual([P[10]!, P[11]!].sort());
    for (const row of r.rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "branchName",
          "finalizedAt",
          "locationName",
          "lotNumber",
          "patientId",
          "patientNumber",
          "patientUsageId",
          "quantity",
          "usageStatus",
        ].sort(),
      );
      expect(JSON.stringify(row)).not.toContain("Lot1");
    }
    expect((await findPatientsByLot(A.users.admin!.ctx, { stockLotId: wh })).rows).toHaveLength(2);
    for (const who of ["docA", "invmgr", "managerA", "assistantA"] as const) {
      expect(await code(findPatientsByLot(A.users[who]!.ctx, { stockLotId: wh })), who).toBe("FORBIDDEN");
    }
    const a = (await audits("LOT_PATIENT_TRACE_VIEWED")).filter((x) => x.entityId === wh);
    expect(a.length).toBeGreaterThanOrEqual(2);
    for (const x of a) {
      expect(JSON.stringify(x.metadataSafe)).not.toContain(P[10]!);
      expect(x.metadataSafe).toMatchObject({ found: 2 });
    }
    // doktor lotları görür (kullanım sırasında)
    expect((await getLot(A.users.docA!.ctx, wh)).lotNumber).toBe("TR-1");
  });

  it("şube kapsamı: başka şubenin lotu NOT_FOUND; kiracı B, A lotuna erişemez", async () => {
    const it1 = await lotItem("Kapsam");
    const bl = await stockIn(it1, WH_B, "SC-1", day(40), "2");
    const al = await stockIn(it1, WH_A, "SC-2", day(40), "2");
    const mgr = A.users.managerA!.ctx;
    expect(await code(getLot(mgr, bl))).toBe("NOT_FOUND");
    expect((await getLot(mgr, al)).lotNumber).toBe("SC-2");
    expect(await code(selectFefoLots(mgr, { inventoryItemId: it1, locationId: WH_B, quantity: "1" }))).toBe(
      "NOT_FOUND",
    );
    expect(await code(writeOffLot(mgr, { stockLotId: bl, reason: "Yetkisiz" }))).toBe("NOT_FOUND");
    expect((await getStockByLot(mgr, { inventoryItemId: it1 })).map((l) => l.lotNumber)).toEqual(["SC-2"]);
    const bo = B.users.owner!.ctx;
    expect(await code(getLot(bo, al))).toBe("NOT_FOUND");
    expect(await code(recallLot(bo, { stockLotId: al, reason: "Başka kiracı" }))).toBe("NOT_FOUND");
    expect(await code(findPatientsByLot(bo, { stockLotId: al }))).toBe("NOT_FOUND");
    expect(
      await code(
        addStock(bo, {
          inventoryItemId: it1,
          locationId: BLOC,
          quantity: "1",
          lotNumber: "X",
          expiryDate: day(5),
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(await lotQty(al)).toBe(2);
  });

  it("DB: tahsis bileşik FK (başka ürünün lotu 23503); kesinleşmiş kullanımın tahsisi değiştirilemez", async () => {
    const it1 = await lotItem("Tahsis FK");
    const it2 = await lotItem("Tahsis FK 2");
    const l1 = await stockIn(it1, ROOM_A, "AF-1", day(30), "3");
    const l2 = await stockIn(it2, ROOM_A, "AF-2", day(30), "3");
    const u = await draft(P[13]!, it1, ROOM_A, "1");
    const row = (await firstLine(u)).id;
    const fk = await dbError(
      runInTenant(A.id, (s) =>
        s.tx
          .execute(sql`insert into kliniva.patient_material_usage_allocations (tenant_id, patient_usage_item_id, inventory_item_id, location_id, stock_lot_id, quantity)
          values (${A.id}, ${row}, ${it1}, ${ROOM_A}, ${l2}, 1)`),
      ),
    );
    expect(fk.code).toBe("23503");
    await finalizePatientMaterialUsage(owner(), u);
    for (const stmt of [
      sql`update kliniva.patient_material_usage_allocations set quantity = 2 where patient_usage_item_id = ${row}`,
      sql`delete from kliniva.patient_material_usage_allocations where patient_usage_item_id = ${row}`,
    ]) {
      expect((await dbError(runInTenant(A.id, (s) => s.tx.execute(stmt)))).message).toMatch(
        /KLINIVA_IMMUTABLE/,
      );
    }
    expect(await lotQty(l1)).toBe(2);
  });
});

// ================================================================ eşzamanlılık
describe("Eşzamanlılık (lot)", () => {
  it("Lot Concurrency: Lot A=1, 20 eşzamanlı kesinleştirme → 1 OK, 19 INSUFFICIENT_STOCK", async () => {
    const it1 = await lotItem("Eşzamanlı lot");
    const L = await newLocation("Lot Eşzamanlı Depo");
    const lot = await stockIn(it1, L, "CC-1", day(30), "1");
    const drafts: string[] = [];
    for (let i = 0; i < 20; i++) drafts.push(await draft(P[i]!, it1, L, "1"));
    const results = await Promise.all(drafts.map((d) => code(finalizePatientMaterialUsage(owner(), d))));
    expect(tally(results)).toEqual({ OK: 1, INSUFFICIENT_STOCK: 19 });
    expect([await lotQty(lot), await balance(it1, L)]).toEqual([0, 0]);
    expect((await lotMoves(lot)).filter((m) => m.movementType === "PATIENT_USAGE")).toHaveLength(1);
  }, 180_000);

  it("FEFO Concurrency: A=1 (yakın SKT), B=20; 20 eşzamanlı 1'er kullanım → A'dan 1, B'den 19", async () => {
    const it1 = await lotItem("FEFO eşzamanlı");
    const L = await newLocation("FEFO Eşzamanlı Depo");
    const la = await stockIn(it1, L, "FA", day(5), "1");
    const lb = await stockIn(it1, L, "FB", day(200), "20");
    const drafts: string[] = [];
    for (let i = 0; i < 20; i++) drafts.push(await draft(P[i]!, it1, L, "1"));
    const results = await Promise.all(drafts.map((d) => code(finalizePatientMaterialUsage(owner(), d))));
    expect(tally(results)).toEqual({ OK: 20 });
    expect([await lotQty(la), await lotQty(lb)]).toEqual([0, 1]);
    const allocs = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(patientMaterialUsageAllocations)
        .where(inArray(patientMaterialUsageAllocations.stockLotId, [la, lb])),
    );
    expect(allocs.filter((a) => a.stockLotId === la)).toHaveLength(1);
    expect(allocs.filter((a) => a.stockLotId === lb)).toHaveLength(19);
    expect((await verifyStockBalance(owner(), { inventoryItemId: it1, locationId: L })).ok).toBe(true);
  }, 180_000);

  it("Transfer Concurrency (lot): 10 adet, 20 eşzamanlı 1'er transfer → 10 OK, kaynak 0, hedef lot 10", async () => {
    const it1 = await lotItem("Transfer eşzamanlı");
    const L1 = await newLocation("Lot Transfer Kaynak");
    const L2 = await newLocation("Lot Transfer Hedef");
    const src = await stockIn(it1, L1, "TC-1", day(90), "10");
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        code(
          transferStock(owner(), {
            inventoryItemId: it1,
            fromLocationId: L1,
            toLocationId: L2,
            quantity: "1",
            fromStockLotId: src,
          }),
        ),
      ),
    );
    expect(tally(results)).toEqual({ OK: 10, INSUFFICIENT_STOCK: 10 });
    const dst = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(stockLots)
        .where(and(eq(stockLots.inventoryItemId, it1), eq(stockLots.locationId, L2))),
    );
    expect(dst).toHaveLength(1);
    expect([
      await lotQty(src),
      Number(dst[0]!.quantity),
      await balance(it1, L1),
      await balance(it1, L2),
    ]).toEqual([0, 10, 0, 10]);
    for (const loc of [L1, L2])
      expect((await verifyStockBalance(owner(), { inventoryItemId: it1, locationId: loc })).ok).toBe(true);
  }, 180_000);

  it("Recall race: 10 eşzamanlı kesinleştirme + geri çağırma → geri çağırmadan sonra kullanım yok, bakiye tutarlı", async () => {
    const it1 = await lotItem("Recall yarışı");
    const L = await newLocation("Recall Yarış Depo");
    const lot = await stockIn(it1, L, "RR-1", day(30), "5");
    const drafts: string[] = [];
    for (let i = 0; i < 10; i++) drafts.push(await draft(P[i]!, it1, L, "1"));
    const [recall, ...results] = await Promise.all([
      code(recallLot(owner(), { stockLotId: lot, reason: "Eşzamanlı geri çağırma" })),
      ...drafts.map((d) => code(finalizePatientMaterialUsage(owner(), d))),
    ]);
    expect(recall).toBe("OK");
    for (const r of results) expect(["OK", "LOT_RECALLED", "INSUFFICIENT_STOCK"]).toContain(r);
    const ok = results.filter((r) => r === "OK").length;
    expect(ok).toBeLessThanOrEqual(5);
    expect(await lotQty(lot)).toBe(5 - ok);
    expect((await lotMoves(lot)).filter((m) => m.movementType === "PATIENT_USAGE")).toHaveLength(ok);
    // geri çağırmadan sonra hiçbir yeni kullanım
    expect(await code(finalizePatientMaterialUsage(owner(), await draft(P[20]!, it1, L, "1")))).toBe(
      "INSUFFICIENT_STOCK",
    );
  }, 180_000);
});

// ================================================================ DB havuzu yük doğrulaması
describe("DB havuzu yük testi (randevu + stok + lot aynı anda)", () => {
  it("havuz tükenmez: zaman aşımı 0, max bağlantı ≤ DB_POOL_MAX; sonuçlar doğru", async () => {
    const pool = getPool();
    const maxConfigured = (pool as unknown as { options: { max: number } }).options.max;
    let peakTotal = 0;
    let peakWaiting = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const sampler = setInterval(() => {
      peakTotal = Math.max(peakTotal, pool.totalCount);
      peakWaiting = Math.max(peakWaiting, pool.waitingCount);
    }, 2);
    const track = async <T>(p: () => Promise<T>) => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        return await p();
      } finally {
        inFlight--;
      }
    };
    // hazırlık
    const lotIt = await lotItem("Havuz lot");
    const L = await newLocation("Havuz Depo");
    const L2 = await newLocation("Havuz Hedef");
    const usageLot = await stockIn(lotIt, L, "PL-1", day(30), "5");
    const transferLot = await stockIn(lotIt, L2, "PL-2", day(60), "10");
    const drafts: string[] = [];
    for (let i = 0; i < 20; i++) drafts.push(await draft(P[i]!, lotIt, L, "1"));
    const date = monday(3);
    try {
      const all = await Promise.all([
        ...P.slice(0, 20).map((p) =>
          track(() =>
            code(
              createAppointment(A.users.reception!.ctx, {
                patientId: p,
                branchId: A.branchA,
                doctorId: D1,
                serviceId: S_PRP,
                start: at(date, "11:00"),
              }),
            ),
          ),
        ),
        ...drafts.map((d) => track(() => code(finalizePatientMaterialUsage(owner(), d)))),
        ...Array.from({ length: 20 }, () =>
          track(() =>
            code(
              transferStock(owner(), {
                inventoryItemId: lotIt,
                fromLocationId: L2,
                toLocationId: L,
                quantity: "1",
                fromStockLotId: transferLot,
              }),
            ),
          ),
        ),
      ]);
      const appt = tally(all.slice(0, 20));
      const fin = tally(all.slice(20, 40));
      const tr = tally(all.slice(40, 60));
      const timeouts = all.filter((r) => /timeout/i.test(r)).length;
      // Rapor için ölçüm (yalnızca sayılar; geçici dizine — depoya girmez).
      writeFileSync(
        join(tmpdir(), "kliniva-pool-load.json"),
        JSON.stringify({
          maxConfigured,
          peakTotal,
          peakWaiting,
          peakConcurrentOps: peakInFlight,
          timeouts,
          appt,
          fin,
          tr,
        }),
      );
      expect(timeouts).toBe(0);
      expect(all.filter((r) => r.startsWith("UNEXPECTED"))).toEqual([]);
      expect(peakTotal).toBeLessThanOrEqual(maxConfigured);
      expect(appt).toEqual({ OK: 1, APPOINTMENT_CONFLICT: 19 });
      expect(fin).toEqual({ OK: 5, INSUFFICIENT_STOCK: 15 });
      expect(tr).toEqual({ OK: 10, INSUFFICIENT_STOCK: 10 });
      expect([await lotQty(usageLot), await lotQty(transferLot)]).toEqual([0, 0]);
    } finally {
      clearInterval(sampler);
    }
  }, 240_000);
});

// ================================================================ RLS + pooled leak
describe("RLS — lot tabloları", () => {
  const NEW = ["stock_lots", "patient_material_usage_allocations", "stock_movements"];

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
      for (const t of NEW)
        expect((await c.query(`select 1 from kliniva.${t} where tenant_id = $1`, [A.id])).rowCount, t).toBe(
          0,
        );
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });

  it("POOLED_CONNECTION_TENANT_CONTEXT_LEAK_TEST (lot tabloları)", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const c1: PoolClient = await pool.connect();
      await c1.query("begin");
      await c1.query("select set_config('app.tenant_id', $1, true)", [A.id]);
      expect(
        (await c1.query("select count(*)::int n from kliniva.patient_material_usage_allocations")).rows[0].n,
      ).toBeGreaterThan(0);
      expect((await c1.query("select count(*)::int n from kliniva.stock_lots")).rows[0].n).toBeGreaterThan(0);
      await c1.query("commit");
      c1.release();
      const c2 = await pool.connect();
      expect(c2).toBe(c1);
      expect((await c2.query("select current_setting('app.tenant_id', true) as v")).rows[0]?.v ?? "").toBe(
        "",
      );
      for (const t of NEW) expect((await c2.query(`select 1 from kliniva.${t} limit 1`)).rowCount, t).toBe(0);
      c2.release();
    } finally {
      await pool.end();
    }
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const ctx = i % 2 ? B.users.owner!.ctx : A.users.owner!.ctx;
        return tenantQuery(ctx, async (scope) => ({
          expected: ctx.tenantId,
          rows: (await scope.tx.execute<{ tenant_id: string }>(sql`select tenant_id from kliniva.stock_lots`))
            .rows,
        }));
      }),
    );
    for (const s of seen) expect(s.rows.every((r) => r.tenant_id === s.expected)).toBe(true);
  });
});
