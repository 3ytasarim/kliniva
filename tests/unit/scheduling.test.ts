import { describe, expect, it } from "vitest";
import {
  addDays,
  dateInZone,
  formatMinutes,
  isValidDate,
  isValidTimeZone,
  isoDayOfWeek,
  parseTime,
  zoneOffsetMinutes,
  zonedDateTimeToUtc,
} from "@/lib/time";
import { computeAvailability, intersect, normalize, subtract } from "@/server/scheduling/availability";

const t = (s: string) => parseTime(s)!;
const iv = (a: string, b: string) => ({ start: t(a), end: t(b) });
const fmt = (list: { start: number; end: number; roomName?: string | null }[]) =>
  list.map(
    (i) =>
      `${formatMinutes(i.start)}-${formatMinutes(i.end)}${i.roomName !== undefined ? `@${i.roomName ?? "-"}` : ""}`,
  );

describe("Saat / tarih yardımcıları", () => {
  it("HH:MM ayrıştırma ve biçimlendirme", () => {
    expect(parseTime("09:30")).toBe(570);
    expect(parseTime("09:30:00")).toBe(570);
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("9:3")).toBeNull();
    expect(formatMinutes(570)).toBe("09:30");
  });

  it("ISO gün numarası (1 = Pazartesi … 7 = Pazar) ve tarih aritmetiği", () => {
    expect(isoDayOfWeek("2026-10-19")).toBe(1); // Pazartesi
    expect(isoDayOfWeek("2026-10-25")).toBe(7); // Pazar
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-02-28")).toBe(true);
  });

  it("saat dilimi doğrulama", () => {
    expect(isValidTimeZone("Europe/Istanbul")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("İstanbul: sabit +03:00 VARSAYILMADAN doğru UTC dönüşümü", () => {
    expect(zonedDateTimeToUtc("2026-11-02", t("09:00"), "Europe/Istanbul").toISOString()).toBe(
      "2026-11-02T06:00:00.000Z",
    );
    expect(zoneOffsetMinutes(new Date("2026-07-01T12:00:00Z"), "Europe/Istanbul")).toBe(180);
  });

  it("yaz saati uygulayan bölge (Berlin): kış ve yaz ofsetleri farklı", () => {
    expect(zonedDateTimeToUtc("2026-01-15", t("09:00"), "Europe/Berlin").toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
    expect(zonedDateTimeToUtc("2026-07-15", t("09:00"), "Europe/Berlin").toISOString()).toBe(
      "2026-07-15T07:00:00.000Z",
    );
    // geçiş günü (29 Mart 2026, 02:00 → 03:00): 09:00 yaz saatindedir
    expect(zonedDateTimeToUtc("2026-03-29", t("09:00"), "Europe/Berlin").toISOString()).toBe(
      "2026-03-29T07:00:00.000Z",
    );
  });

  it("anın yerel takvim tarihi", () => {
    // İstanbul'da 2026-10-14 23:30 = UTC 20:30; UTC tarihi aynı, ama UTC 22:00 → İstanbul'da ertesi gün
    expect(dateInZone(new Date("2026-10-14T22:00:00Z"), "Europe/Istanbul")).toBe("2026-10-15");
  });
});

describe("Aralık matematiği", () => {
  it("birleştirme, kesişim, çıkarma (yarı açık aralıklar)", () => {
    expect(fmt(normalize([iv("09:00", "12:00"), iv("11:00", "13:00"), iv("14:00", "15:00")]))).toEqual([
      "09:00-13:00",
      "14:00-15:00",
    ]);
    expect(fmt(intersect([iv("08:00", "18:00")], [iv("09:00", "17:00")]))).toEqual(["09:00-17:00"]);
    expect(fmt(subtract([iv("09:00", "17:00")], [iv("12:00", "13:00")]))).toEqual([
      "09:00-12:00",
      "13:00-17:00",
    ]);
    // bitişik aralıklar çakışmaz: 12:00'de biten ile 12:00'de başlayan
    expect(fmt(subtract([iv("09:00", "12:00")], [iv("12:00", "15:00")]))).toEqual(["09:00-12:00"]);
  });
});

describe("Müsaitlik temeli", () => {
  const base = {
    working: [iv("09:00", "17:00")],
    branchHours: null,
    exceptions: [],
    closures: [],
    weeklyRooms: [],
    datedRooms: [],
  };

  it("ALL_DAY izin → müsaitlik boş", () => {
    expect(computeAvailability({ ...base, exceptions: [{ allDay: true }] })).toEqual([]);
  });

  it("TIME_RANGE izin → ilgili pencere çıkarılır", () => {
    const r = computeAvailability({ ...base, exceptions: [{ allDay: false, ...iv("14:00", "16:00") }] });
    expect(fmt(r)).toEqual(["09:00-14:00@-", "16:00-17:00@-"]);
  });

  it("şube tüm gün kapalı → boş; yarım gün kapalı → kırpılır", () => {
    expect(computeAvailability({ ...base, closures: [{ allDay: true }] })).toEqual([]);
    expect(
      fmt(computeAvailability({ ...base, closures: [{ allDay: false, ...iv("15:00", "23:00") }] })),
    ).toEqual(["09:00-15:00@-"]);
  });

  it("şube saatleri etkin → kesişim; şube o gün kapalı ([]) → boş", () => {
    expect(fmt(computeAvailability({ ...base, branchHours: [iv("10:00", "16:00")] }))).toEqual([
      "10:00-16:00@-",
    ]);
    expect(computeAvailability({ ...base, branchHours: [] })).toEqual([]);
  });

  it("oda atamaları: haftalık bölme + tarihli override önceliği + atanmamış süre", () => {
    const r = computeAvailability({
      ...base,
      weeklyRooms: [{ ...iv("09:00", "17:00"), roomId: "r2", roomName: "Oda 2" }],
      datedRooms: [{ ...iv("10:00", "12:00"), roomId: "r3", roomName: "Oda 3" }],
    });
    expect(fmt(r)).toEqual(["09:00-10:00@Oda 2", "10:00-12:00@Oda 3", "12:00-17:00@Oda 2"]);
    const partial = computeAvailability({
      ...base,
      weeklyRooms: [{ ...iv("09:00", "12:00"), roomId: "r1", roomName: "Oda 1" }],
    });
    expect(fmt(partial)).toEqual(["09:00-12:00@Oda 1", "12:00-17:00@-"]);
  });

  it("aynı gün iki blok (09–12, 13–17) ayrı pencereler", () => {
    expect(
      fmt(computeAvailability({ ...base, working: [iv("09:00", "12:00"), iv("13:00", "17:00")] })),
    ).toEqual(["09:00-12:00@-", "13:00-17:00@-"]);
  });
});
