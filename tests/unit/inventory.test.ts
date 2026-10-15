import { describe, expect, it } from "vitest";
import {
  addStockInput,
  adjustStockInput,
  listItemsInput,
  locationInput,
  quantitySchema,
  recordMaterialUsageInput,
  transferStockInput,
} from "@/server/inventory/contracts";
import { formatQuantity, fromMilli, toMilli } from "@/lib/quantity";
import { SYSTEM_ROLES } from "@/server/auth/permissions";

const id = "6f1c1b7e-1111-4a1a-9a1a-111111111111";
const id2 = "6f1c1b7e-2222-4a1a-9a1a-222222222222";

describe("Miktar (float yok)", () => {
  it.each([
    ["1", "1"],
    [2, "2"],
    ["2,5", "2.5"],
    ["0.125", "0.125"],
  ])("%s geçerli → %s", (raw, out) => {
    expect(quantitySchema.parse(raw)).toBe(out);
  });

  it.each(["0", "-1", "1.2345", "abc", "", "1e3", "10000000000"])("%s reddedilir", (raw) => {
    expect(quantitySchema.safeParse(raw).success).toBe(false);
  });

  it("binde birim tamsayı aritmetiği: 0.1 + 0.2 kayması yok", () => {
    expect(fromMilli(toMilli("0.1") + toMilli("0.2"))).toBe("0.300");
    expect(toMilli("5.000")).toBe(5000);
    expect(formatQuantity("4.000")).toBe("4");
    expect(formatQuantity("2.500")).toBe("2,5");
  });
});

describe("Stok sözleşmeleri (Voice AI'ye hazır)", () => {
  it("düzeltmede gerekçe zorunlu", () => {
    const b = { inventoryItemId: id, locationId: id2, direction: "OUT", quantity: "1" };
    expect(adjustStockInput.safeParse(b).success).toBe(false);
    expect(adjustStockInput.safeParse({ ...b, reason: "Sayım farkı" }).success).toBe(true);
  });

  it("giriş tipi yalnızca ilk stok / alım (tüketim girişle yapılamaz)", () => {
    const b = { inventoryItemId: id, locationId: id2, quantity: "1" };
    expect(addStockInput.safeParse({ ...b, kind: "PATIENT_USAGE" }).success).toBe(false);
    expect(addStockInput.parse(b).kind).toBe("PURCHASE");
  });

  it("transfer miktarı pozitif olmalı", () => {
    expect(
      transferStockInput.safeParse({
        inventoryItemId: id,
        fromLocationId: id,
        toLocationId: id2,
        quantity: "0",
      }).success,
    ).toBe(false);
  });

  it("oda lokasyonu oda kimliği ister; depo istemez", () => {
    expect(locationInput.safeParse({ branchId: id, type: "ROOM" }).success).toBe(false);
    expect(
      locationInput.safeParse({ branchId: id, type: "BRANCH_WAREHOUSE", name: "Depo", roomId: id2 }).success,
    ).toBe(false);
    expect(locationInput.safeParse({ branchId: id, type: "BRANCH_WAREHOUSE", name: "Depo" }).success).toBe(
      true,
    );
  });

  it("kayıt sözleşmesi: en az bir kalem; sayfalama varsayılan 25, en fazla 100", () => {
    expect(recordMaterialUsageInput.safeParse({ patientId: id, items: [] }).success).toBe(false);
    expect(
      recordMaterialUsageInput.parse({ patientId: id, items: [{ inventoryItemId: id2, quantity: 2 }] })
        .finalize,
    ).toBe(false);
    expect(listItemsInput.parse({}).limit).toBe(25);
    expect(listItemsInput.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("Stok yetki matrisi", () => {
  const has = (role: keyof typeof SYSTEM_ROLES, p: string) =>
    SYSTEM_ROLES[role].permissions.includes(p as never);

  it("VOID ve şubeler arası transfer yalnızca yüksek yetkili rollerde", () => {
    for (const r of ["CLINIC_OWNER", "CLINIC_ADMIN"] as const) {
      expect(has(r, "inventory.usage.void"), r).toBe(true);
      expect(has(r, "inventory.transfer.cross_branch"), r).toBe(true);
    }
    for (const r of ["BRANCH_MANAGER", "DOCTOR", "ASSISTANT", "RECEPTION", "READ_ONLY"] as const) {
      expect(has(r, "inventory.usage.void"), r).toBe(false);
      expect(has(r, "inventory.transfer.cross_branch"), r).toBe(false);
    }
  });

  it("doktor ve asistan kullanım oluşturur / kesinleştirir; resepsiyon yalnızca okur", () => {
    for (const r of ["DOCTOR", "ASSISTANT"] as const) {
      expect(has(r, "inventory.usage.create") && has(r, "inventory.usage.finalize"), r).toBe(true);
      expect(has(r, "inventory.stock.adjust"), r).toBe(false);
    }
    expect(has("RECEPTION", "inventory.read")).toBe(true);
    expect(has("RECEPTION", "inventory.usage.create")).toBe(false);
  });

  it("stok sorumlusu stok + transfer yönetir ama hasta kullanımı oluşturmaz", () => {
    expect(has("INVENTORY_MANAGER", "inventory.transfer")).toBe(true);
    expect(has("INVENTORY_MANAGER", "inventory.stock.add")).toBe(true);
    expect(has("INVENTORY_MANAGER", "inventory.usage.create")).toBe(false);
  });

  it("yetki yükseltme: klinik yöneticisi sağlık verisi içermeyen her rolün (stok dahil) yetkilerine sahip", () => {
    // DOCTOR / ASSISTANT sağlık verisi yetkisi taşır → CLINIC_ADMIN bunları zaten atayamaz (Sprint 1 kuralı).
    const admin = new Set(SYSTEM_ROLES.CLINIC_ADMIN.permissions);
    for (const r of ["BRANCH_MANAGER", "RECEPTION", "INVENTORY_MANAGER", "READ_ONLY"] as const) {
      const missing = SYSTEM_ROLES[r].permissions.filter((p) => !admin.has(p));
      expect(missing, r).toEqual([]);
    }
  });
});
