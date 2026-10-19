import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs } from "@/server/db/schema";
import { runInTenant } from "@/server/tenant/tenant-query";
import {
  addStock,
  createInventoryItem,
  createLocation,
  getInventoryDashboard,
} from "@/server/services/inventory";
import { addDays, dateInZone } from "@/lib/time";
import { cleanupTenants, createTenant, type TestTenant } from "../support/fixtures";

/**
 * Panel stok özeti: ana panel her açılışta SAYI özeti alır → audit YAZILMAZ (audit: false); stok ekranı / rapor
 * görüntülemesi audit'lenmeye devam eder (varsayılan). Sayılar kapsam içi ve doğru.
 */
let A: TestTenant;

beforeAll(async () => {
  A = await createTenant({ owner: { role: "CLINIC_OWNER" }, doctor: { role: "DOCTOR" } });
  const owner = A.users.owner!.ctx;
  const loc = (await createLocation(owner, { branchId: A.branchA, type: "BRANCH_WAREHOUSE", name: "Depo" }))
    .id;
  const punch = (
    await createInventoryItem(owner, { name: "Punch", code: "DB-PUNCH", minimumStockLevel: "10" })
  ).id;
  await addStock(owner, { inventoryItemId: punch, locationId: loc, quantity: "4", kind: "INITIAL_STOCK" });
  await createInventoryItem(owner, { name: "Boş ürün", code: "DB-EMPTY" });
  const lotItem = (
    await createInventoryItem(owner, { name: "Dolgu", code: "DB-LOT", trackLots: true, trackExpiry: true })
  ).id;
  const today = dateInZone(new Date(), "Europe/Istanbul");
  await addStock(owner, {
    inventoryItemId: lotItem,
    locationId: loc,
    quantity: "2",
    lotNumber: "D1",
    expiryDate: addDays(today, 10),
  });
  await addStock(owner, {
    inventoryItemId: lotItem,
    locationId: loc,
    quantity: "1",
    lotNumber: "D0",
    expiryDate: addDays(today, -1),
  });
}, 120_000);

afterAll(cleanupTenants);

const lowStockAudits = () =>
  runInTenant(A.id, (s) =>
    s.tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, A.id), eq(auditLogs.action, "LOW_STOCK_VIEWED"))),
  );

describe("Panel stok özeti", () => {
  it("audit: false → doğru sayılar, LOW_STOCK_VIEWED audit'i YOK; varsayılan (stok ekranı) → audit VAR", async () => {
    const owner = A.users.owner!.ctx;
    const before = (await lowStockAudits()).length;
    const d = await getInventoryDashboard(owner, {}, { audit: false });
    expect(d.lowStock).toBe(1);
    expect(d.outOfStock).toBeGreaterThanOrEqual(1);
    expect(d.lotCards).toMatchObject({ expiringSoon: 1, expired: 1 });
    expect((await lowStockAudits()).length).toBe(before);
    await getInventoryDashboard(owner, {});
    expect((await lowStockAudits()).length).toBe(before + 1);
  });
});
