import { describe, expect, it } from "vitest";
import {
  daysBetween,
  fefoAllocate,
  fefoOrder,
  isExpired,
  isUsable,
  lotStatus,
  type LotCandidate,
} from "@/server/inventory/fefo";
import { dateInZone } from "@/lib/time";
import {
  correctLotInput,
  getExpiringLotsInput,
  itemInput,
  physicalCountInput,
  recallLotInput,
  recordPatientMaterialUsageInput,
} from "@/server/inventory/contracts";
import { PERMISSIONS, SYSTEM_ROLES, type RoleKey } from "@/server/auth/permissions";

/** Sprint 5 — saf FEFO / SKT anlamı / sözleşmeler / RBAC eşlemesi (DB yok). */
const lot = (
  id: string,
  expiryDate: string | null,
  q: number,
  extra: Partial<LotCandidate> = {},
): LotCandidate => ({
  id,
  lotNumber: `L-${id}`,
  expiryDate,
  quantityMilli: q * 1000,
  receivedAt: null,
  recalled: false,
  active: true,
  ...extra,
});

describe("SKT anlamı (şube yerel takvimi, SKT günü SONUNA kadar geçerli)", () => {
  it("SKT günü geçerli, ertesi gün geçmiş", () => {
    expect(isExpired("2026-05-10", "2026-05-09")).toBe(false);
    expect(isExpired("2026-05-10", "2026-05-10")).toBe(false);
    expect(isExpired("2026-05-10", "2026-05-11")).toBe(true);
    expect(isExpired(null, "2099-01-01")).toBe(false);
  });

  it("Europe/Berlin yaz saatine geçiş (2026-03-29): yerel gece yarısı sınırı UTC'ye göre değil", () => {
    // 2026-03-28 23:59 CET = 22:59Z → hâlâ 28'i: SKT 28 olan lot geçerli.
    expect(dateInZone(new Date("2026-03-28T22:59:00Z"), "Europe/Berlin")).toBe("2026-03-28");
    expect(isExpired("2026-03-28", dateInZone(new Date("2026-03-28T22:59:00Z"), "Europe/Berlin"))).toBe(
      false,
    );
    // 23:00Z = 29'u 00:00 CET → geçmiş.
    expect(isExpired("2026-03-28", dateInZone(new Date("2026-03-28T23:00:00Z"), "Europe/Berlin"))).toBe(true);
    // DST anı (01:00Z → 03:00 CEST) aynı gün içinde: SKT 29 olan lot 29'u boyunca geçerli.
    expect(dateInZone(new Date("2026-03-29T21:59:00Z"), "Europe/Berlin")).toBe("2026-03-29");
    expect(isExpired("2026-03-29", dateInZone(new Date("2026-03-29T21:59:00Z"), "Europe/Berlin"))).toBe(
      false,
    );
    expect(isExpired("2026-03-29", dateInZone(new Date("2026-03-29T22:00:00Z"), "Europe/Berlin"))).toBe(true);
  });

  it("Europe/Berlin kış saatine dönüş (2026-10-25): 25 saatlik gün, sınır yerel gece yarısı", () => {
    // 24'ü 23:59 CEST = 21:59Z
    expect(isExpired("2026-10-24", dateInZone(new Date("2026-10-24T21:59:00Z"), "Europe/Berlin"))).toBe(
      false,
    );
    expect(isExpired("2026-10-24", dateInZone(new Date("2026-10-24T22:00:00Z"), "Europe/Berlin"))).toBe(true);
    // 25'i 23:59 CET = 22:59Z (gün 25 saat sürdü)
    expect(isExpired("2026-10-25", dateInZone(new Date("2026-10-25T22:59:00Z"), "Europe/Berlin"))).toBe(
      false,
    );
    expect(isExpired("2026-10-25", dateInZone(new Date("2026-10-25T23:00:00Z"), "Europe/Berlin"))).toBe(true);
  });

  it("aynı UTC anında İstanbul ve Berlin farklı gün görebilir (şube saat dilimi esas)", () => {
    const t = new Date("2026-06-30T21:30:00Z"); // İstanbul 1 Temmuz 00:30, Berlin 30 Haziran 23:30
    expect(isExpired("2026-06-30", dateInZone(t, "Europe/Istanbul"))).toBe(true);
    expect(isExpired("2026-06-30", dateInZone(t, "Europe/Berlin"))).toBe(false);
  });
});

describe("FEFO", () => {
  const today = "2026-05-10";
  it("sıra: en yakın SKT → SKT'siz en sonda → teslim alma zamanı → id", () => {
    const lots = [
      lot("c", null, 5),
      lot("b", "2026-08-01", 5),
      lot("a", "2026-06-01", 5),
      lot("e", "2026-06-01", 5, { receivedAt: new Date("2026-01-02") }),
      lot("d", "2026-06-01", 5, { receivedAt: new Date("2026-01-01") }),
    ];
    expect(fefoOrder(lots, today).map((l) => l.id)).toEqual(["d", "e", "a", "b", "c"]);
  });

  it("süresi geçmiş / geri çağrılmış / pasif / boş lot hiç seçilmez", () => {
    const lots = [
      lot("exp", "2026-05-09", 10),
      lot("rec", "2026-05-11", 10, { recalled: true }),
      lot("off", "2026-05-11", 10, { active: false }),
      lot("zero", "2026-05-11", 0),
      lot("ok", "2026-05-10", 10),
    ];
    expect(fefoOrder(lots, today).map((l) => l.id)).toEqual(["ok"]);
    expect(isUsable(lots[0]!, today)).toBe(false);
  });

  it("birden fazla lot kullanılır; yetersizse kısmi tahsis YOK", () => {
    const lots = [lot("a", "2026-06-01", 1), lot("b", "2026-07-01", 20)];
    const r = fefoAllocate(lots, 3000, today);
    expect(r.shortfallMilli).toBe(0);
    expect(r.allocations.map((a) => [a.lotId, a.quantityMilli])).toEqual([
      ["a", 1000],
      ["b", 2000],
    ]);
    const short = fefoAllocate(lots, 22000, today);
    expect(short).toEqual({ allocations: [], shortfallMilli: 1000 });
    // ondalıklı miktar (binde birim)
    expect(fefoAllocate([lot("x", null, 1)], 250, today).allocations[0]!.quantityMilli).toBe(250);
  });

  it("türetilmiş lot durumu", () => {
    const w = "2026-06-09"; // 30 gün
    expect(lotStatus({ active: false, recalled: false, quantityMilli: 1, expiryDate: null }, today, w)).toBe(
      "INACTIVE",
    );
    expect(lotStatus({ active: true, recalled: true, quantityMilli: 1, expiryDate: null }, today, w)).toBe(
      "RECALLED",
    );
    expect(lotStatus({ active: true, recalled: false, quantityMilli: 0, expiryDate: null }, today, w)).toBe(
      "DEPLETED",
    );
    expect(
      lotStatus({ active: true, recalled: false, quantityMilli: 1, expiryDate: "2026-05-09" }, today, w),
    ).toBe("EXPIRED");
    expect(
      lotStatus({ active: true, recalled: false, quantityMilli: 1, expiryDate: "2026-06-09" }, today, w),
    ).toBe("EXPIRING_SOON");
    expect(
      lotStatus(
        { active: true, recalled: false, quantityMilli: 2000, expiryDate: "2026-12-01" },
        today,
        w,
        5000,
      ),
    ).toBe("LOW_STOCK");
    expect(
      lotStatus(
        { active: true, recalled: false, quantityMilli: 9000, expiryDate: "2026-12-01" },
        today,
        w,
        5000,
      ),
    ).toBe("AVAILABLE");
    expect(daysBetween("2026-05-10", "2026-05-12")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // DST'den etkilenmez
  });
});

describe("Sözleşmeler (Zod)", () => {
  it("SKT takibi lot takibi gerektirir", () => {
    expect(itemInput.safeParse({ name: "Dolgu", trackExpiry: true }).success).toBe(false);
    expect(itemInput.safeParse({ name: "Dolgu", trackLots: true, trackExpiry: true }).success).toBe(true);
    expect(itemInput.parse({ name: "Gazlı bez" }).trackLots).toBe(false);
  });
  it("geri çağırma gerekçesi zorunlu; SKT düzeltme geçerli tarih; sayım miktarı", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(recallLotInput.safeParse({ stockLotId: id, reason: "" }).success).toBe(false);
    expect(recallLotInput.safeParse({ stockLotId: id, reason: "Üretici geri çağırması" }).success).toBe(true);
    expect(
      correctLotInput.safeParse({ stockLotId: id, expiryDate: "2026-02-30", reason: "Etiket hatası" })
        .success,
    ).toBe(false);
    expect(
      physicalCountInput.parse({ inventoryItemId: id, locationId: id, countedQuantity: "0" }).countedQuantity,
    ).toBe("0");
    expect(
      physicalCountInput.safeParse({ inventoryItemId: id, locationId: id, countedQuantity: "-1" }).success,
    ).toBe(false);
    expect(getExpiringLotsInput.parse({}).kind).toBe("expiring");
    expect(getExpiringLotsInput.safeParse({ days: 400 }).success).toBe(false);
    expect(
      recordPatientMaterialUsageInput.safeParse({
        patientId: id,
        items: [{ inventoryItemId: id, quantity: "2", lots: [{ stockLotId: id, quantity: "2" }] }],
      }).success,
    ).toBe(true);
  });
});

describe("RBAC (Sprint 5)", () => {
  const perms = (role: RoleKey) => new Set<string>(SYSTEM_ROLES[role].permissions);
  it("izinler tanımlı", () => {
    for (const p of [
      "inventory.lot.read",
      "inventory.lot.manage",
      "inventory.lot.correct_metadata",
      "inventory.lot.recall",
      "inventory.lot.trace",
      "inventory.expiry.read",
      "inventory.write_off",
      "inventory.physical_count",
    ]) {
      expect(Object.keys(PERMISSIONS)).toContain(p);
    }
  });
  it("stok sorumlusu: lot yönetimi, SKT, imha, sayım; geri çağırma (kiracı geneli) ve izleme YOK", () => {
    const p = perms("INVENTORY_MANAGER");
    for (const x of [
      "inventory.lot.manage",
      "inventory.expiry.read",
      "inventory.write_off",
      "inventory.physical_count",
    ])
      expect(p.has(x)).toBe(true);
    for (const x of ["inventory.lot.recall", "inventory.lot.trace", "inventory.lot.correct_metadata"])
      expect(p.has(x)).toBe(false);
  });
  it("geri çağırma varsayılan olarak YALNIZCA klinik sahibi ve yöneticide", () => {
    const holders = (Object.keys(SYSTEM_ROLES) as RoleKey[]).filter((r) =>
      perms(r).has("inventory.lot.recall"),
    );
    expect(holders.sort()).toEqual(["CLINIC_ADMIN", "CLINIC_OWNER"]);
  });
  it("doktor: lotları görür; geri çağırma / izleme / düzeltme YOK", () => {
    const p = perms("DOCTOR");
    expect(p.has("inventory.lot.read")).toBe(true);
    for (const x of [
      "inventory.lot.recall",
      "inventory.lot.trace",
      "inventory.lot.correct_metadata",
      "inventory.write_off",
    ])
      expect(p.has(x)).toBe(false);
  });
  it("klinik sahibi / yönetici: izleme + geri çağırma + düzeltme", () => {
    for (const role of ["CLINIC_OWNER", "CLINIC_ADMIN"] as const) {
      const p = perms(role);
      for (const x of ["inventory.lot.trace", "inventory.lot.recall", "inventory.lot.correct_metadata"])
        expect(p.has(x)).toBe(true);
    }
  });
});
