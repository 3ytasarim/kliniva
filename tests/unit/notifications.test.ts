import { describe, expect, it } from "vitest";
import {
  CATEGORY_OF,
  MANDATORY_TYPES,
  NOTIFICATION_TYPES,
  SEVERITY_OF,
  TYPE_LABELS,
  assertSafeText,
  typesOfCategory,
  whenLabel,
} from "@/server/notifications/catalog";
import {
  OUTBOX_BACKOFF_MINUTES,
  OUTBOX_MAX_ATTEMPTS,
  nextAttemptAt,
  safeErrorCode,
} from "@/server/notifications/outbox";
import { stockCrossing } from "@/server/services/stock-alerts";
import { AppError } from "@/server/errors";
import { SYSTEM_ROLES, type RoleKey } from "@/server/auth/permissions";
import { canTransition, ACTIVE_STATUSES, isReschedulable } from "@/server/scheduling/slots";
import { timeAgo } from "@/components/notification-ui";

/** Sprint 6 — saf bildirim kataloğu, yeniden deneme, eşik geçişi, durum makinesi, RBAC (DB yok). */
describe("Bildirim kataloğu", () => {
  it("her tipin kategorisi, önem derecesi ve etiketi var; güvenlik kritik tipler zorunlu", () => {
    for (const t of NOTIFICATION_TYPES) {
      expect(CATEGORY_OF[t], t).toBeDefined();
      expect(SEVERITY_OF[t], t).toBeDefined();
      expect(TYPE_LABELS[t], t).toBeTruthy();
    }
    expect([...MANDATORY_TYPES].sort()).toEqual([
      "DOCUMENT_INTEGRITY_FAILED",
      "LOT_RECALLED",
      "SYSTEM_SECURITY_ALERT",
    ]);
    expect(typesOfCategory("security").sort()).toEqual([
      "DOCUMENT_INTEGRITY_FAILED",
      "SYSTEM_SECURITY_ALERT",
    ]);
    expect(typesOfCategory("inventory")).toContain("LOW_STOCK");
    expect(typesOfCategory("appointments")).toContain("PATIENT_CHECKED_IN");
  });

  it("zaman etiketi şube saat diliminde (Bugün / Yarın / gg.aa)", () => {
    const now = new Date("2026-10-15T08:00:00Z"); // İstanbul 11:00
    expect(whenLabel("2026-10-15T11:30:00Z", "Europe/Istanbul", now)).toBe("Bugün 14:30");
    expect(whenLabel("2026-10-16T06:00:00Z", "Europe/Istanbul", now)).toBe("Yarın 09:00");
    expect(whenLabel("2026-10-20T06:00:00Z", "Europe/Istanbul", now)).toBe("20.10 09:00");
    // Gün sınırı saat dilimine göre: 21:30Z İstanbul'da ertesi gün 00:30
    expect(whenLabel("2026-10-15T21:30:00Z", "Europe/Istanbul", now)).toBe("Yarın 00:30");
    expect(whenLabel("2026-10-15T21:30:00Z", "Europe/Berlin", now)).toBe("Bugün 23:30");
  });

  it("güvenli metin: telefon / uzun sayı / e-posta benzeri içerik reddedilir", () => {
    expect(assertSafeText("Bugün 14:30 · PRP")).toBe("Bugün 14:30 · PRP");
    expect(assertSafeText("Botoks · Lot L-2026-01 · SKT 01.02.2027 · Oda 1")).toBeTruthy();
    for (const bad of ["Hasta 05321234567", "ayse@example.com", "532 123 45 67", "TC 12345678901"]) {
      expect(() => assertSafeText(bad), bad).toThrow("NOTIFICATION_UNSAFE_TEXT");
    }
  });

  it("zaman önce", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(timeAgo("2026-10-15T11:59:40Z", now)).toBe("az önce");
    expect(timeAgo("2026-10-15T11:55:00Z", now)).toBe("5 dk önce");
    expect(timeAgo("2026-10-15T09:00:00Z", now)).toBe("3 sa önce");
    expect(timeAgo("2026-10-13T12:00:00Z", now)).toBe("2 gün önce");
  });
});

describe("Outbox yeniden deneme", () => {
  it("geri çekilme 1 / 5 / 15 / 60 dk; en fazla 5 deneme", () => {
    expect(OUTBOX_BACKOFF_MINUTES).toEqual([1, 5, 15, 60]);
    expect(OUTBOX_MAX_ATTEMPTS).toBe(5);
    const t0 = new Date(0);
    expect([1, 2, 3, 4, 5].map((a) => nextAttemptAt(a, t0).getTime() / 60_000)).toEqual([1, 5, 15, 60, 60]);
  });

  it("hata kodu güvenli: mesaj / yığın izi / bağlantı dizesi DB'ye yazılmaz", () => {
    expect(safeErrorCode(new AppError("NOT_FOUND"))).toBe("NOT_FOUND");
    expect(safeErrorCode(new Error("SIMULATED_CHANNEL_DOWN"))).toBe("SIMULATED_CHANNEL_DOWN");
    expect(
      safeErrorCode(new Error(["connect ECONNREFUSED ", "postgres", ":/", "/u:secret@h/db"].join(""))),
    ).toBe("HANDLER_ERROR");
    expect(safeErrorCode("string error")).toBe("HANDLER_ERROR");
  });
});

describe("Stok eşik geçişi (durumsuz)", () => {
  const MIN = 5000; // binde birim (5 adet)
  it("6 → 4 LOW; 4 → 3 yok; 3 → 10 yok; 10 → 5 LOW; 1 → 0 OUT; 0 → 0 yok; 6 → 0 yalnızca OUT", () => {
    expect(stockCrossing(6000, 4000, MIN)).toBe("STOCK_LOW");
    expect(stockCrossing(4000, 3000, MIN)).toBeNull();
    expect(stockCrossing(3000, 10000, MIN)).toBeNull();
    expect(stockCrossing(10000, 5000, MIN)).toBe("STOCK_LOW");
    expect(stockCrossing(1000, 0, MIN)).toBe("STOCK_OUT");
    expect(stockCrossing(0, 0, MIN)).toBeNull();
    expect(stockCrossing(6000, 0, MIN)).toBe("STOCK_OUT");
    expect(stockCrossing(6000, 4000, null)).toBeNull();
    expect(stockCrossing(2000, 0, null)).toBe("STOCK_OUT");
  });
});

describe("Randevu durum makinesi (onay modu)", () => {
  it("PENDING_APPROVAL slot tutar; yalnızca BOOKED / CANCELLED'a geçer; taşınabilir", () => {
    expect(ACTIVE_STATUSES).toContain("PENDING_APPROVAL");
    expect(canTransition("PENDING_APPROVAL", "BOOKED")).toBe(true);
    expect(canTransition("PENDING_APPROVAL", "CANCELLED")).toBe(true);
    for (const to of ["CHECKED_IN", "IN_PROGRESS", "COMPLETED", "NO_SHOW", "CONFIRMED"] as const) {
      expect(canTransition("PENDING_APPROVAL", to), to).toBe(false);
    }
    expect(isReschedulable("PENDING_APPROVAL")).toBe(true);
    expect(ACTIVE_STATUSES).not.toContain("CANCELLED");
  });
});

describe("RBAC (Sprint 6)", () => {
  const perms = (role: RoleKey) => new Set<string>(SYSTEM_ROLES[role].permissions);
  it("her kiracı rolü kendi bildirimlerini okur; platform yöneticisi okumaz", () => {
    for (const role of Object.keys(SYSTEM_ROLES) as RoleKey[]) {
      const p = perms(role);
      if (role === "PLATFORM_SUPER_ADMIN") expect(p.has("notification.read_own")).toBe(false);
      else {
        expect(p.has("notification.read_own"), role).toBe(true);
        expect(p.has("notification.preference.manage_own"), role).toBe(true);
      }
    }
  });
  it("başarısız olay görünümü yalnızca sahip / yönetici; doktor kendi onayını verir; resepsiyon veremez", () => {
    const holders = (perm: string) =>
      (Object.keys(SYSTEM_ROLES) as RoleKey[]).filter((r) => perms(r).has(perm)).sort();
    expect(holders("notification.admin.read_failed_events")).toEqual(["CLINIC_ADMIN", "CLINIC_OWNER"]);
    expect(perms("DOCTOR").has("appointment.approve_own")).toBe(true);
    expect(perms("DOCTOR").has("appointment.decline_own")).toBe(true);
    expect(perms("RECEPTION").has("appointment.approve_own")).toBe(false);
    expect(perms("INVENTORY_MANAGER").has("appointment.approve_own")).toBe(false);
  });
  it("DOCTOR ⊆ CLINIC_OWNER (yetki yükseltme kuralı korunur)", () => {
    const owner = perms("CLINIC_OWNER");
    for (const p of perms("DOCTOR")) expect(owner.has(p), p).toBe(true);
  });
});
