import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  canTransition,
  computeRoomHoldings,
  computeSlots,
  type DoctorDay,
  type SlotInput,
} from "@/server/scheduling/slots";
import { localDateTimeOf, localTimeStatus, zonedDateTimeToUtc } from "@/lib/time";
import { createAppointmentInput, getAvailableSlotsInput } from "@/server/appointments/contracts";

const h = (hh: number, mm = 0) => hh * 60 + mm;
const fmt = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const base: SlotInput = {
  windows: [{ start: h(9), end: h(12) }],
  ownRooms: [],
  doctorBusy: [],
  patientBusy: [],
  duration: 30,
  step: 30,
  earliestStart: 0,
  requiresRoom: false,
  rooms: [],
};
const starts = (input: Partial<SlotInput>) => computeSlots({ ...base, ...input }).map((s) => fmt(s.start));

describe("Slot motoru — temel", () => {
  it("çalışma penceresi içinde adım adım slot; pencere dışı yok", () => {
    expect(starts({})).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
  });

  it("süre pencereye sığmazsa slot üretilmez", () => {
    expect(starts({ duration: 45 })).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
  });

  it("mevcut randevu ilgili slotları düşürür; bitişik slot kalır (yarı açık aralık)", () => {
    expect(starts({ doctorBusy: [{ start: h(10), end: h(11) }] })).toEqual([
      "09:00",
      "09:30",
      "11:00",
      "11:30",
    ]);
  });

  it("hastanın başka randevusu da slotu düşürür", () => {
    expect(starts({ patientBusy: [{ start: h(9, 15), end: h(9, 45) }] })).toEqual([
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
  });

  it("en erken başlangıç (bugün / asgari süre) öncesi slot yok", () => {
    expect(starts({ earliestStart: h(10, 10) })).toEqual(["10:30", "11:00", "11:30"]);
  });

  it("parçalı pencereler (kısmi izin) → bölünmüş slotlar", () => {
    expect(
      starts({
        windows: [
          { start: h(9), end: h(10) },
          { start: h(11), end: h(12) },
        ],
      }),
    ).toEqual(["09:00", "09:30", "11:00", "11:30"]);
  });
});

describe("Slot motoru — oda", () => {
  const rooms = [
    { roomId: "r2", roomName: "Oda 2", busy: [{ start: h(10), end: h(10, 45) }] },
    { roomId: "r3", roomName: "Oda 3", busy: [] as { start: number; end: number }[] },
  ];

  it("bir oda doluysa diğer uygun oda ile slot kalır ve o oda önerilir", () => {
    const s = computeSlots({ ...base, requiresRoom: true, rooms, duration: 45, step: 15 }).find(
      (x) => x.start === h(10),
    );
    expect(s?.rooms.map((r) => r.roomId)).toEqual(["r3"]);
  });

  it("tüm uygun odalar doluysa slot yok", () => {
    const full = rooms.map((r) => ({ ...r, busy: [{ start: h(10), end: h(11) }] }));
    const s = computeSlots({ ...base, requiresRoom: true, rooms: full, duration: 45, step: 15 });
    expect(s.find((x) => x.start === h(10))).toBeUndefined();
  });

  it("uygun tipte oda yoksa (aday listesi boş) hiç slot yok", () => {
    expect(computeSlots({ ...base, requiresRoom: true, rooms: [] })).toEqual([]);
  });

  it("doktorun kendi atanmış odası önce önerilir", () => {
    const s = computeSlots({
      ...base,
      requiresRoom: true,
      rooms,
      ownRooms: [{ start: h(9), end: h(12), roomId: "r3" }],
    }).find((x) => x.start === h(9));
    expect(s?.rooms[0]?.roomId).toBe("r3");
  });
});

describe("Doktor izni + oda ataması (Sprint 1 sınırlamasının düzeltmesi)", () => {
  const day = (exceptions: DoctorDay["exceptions"]): DoctorDay => ({
    doctorId: "d2",
    working: [{ start: h(9), end: h(17) }],
    branchHours: null,
    exceptions,
    closures: [],
    weeklyRooms: [{ start: h(9), end: h(17), roomId: "r1", roomName: "Oda 1" }],
    datedRooms: [],
  });

  it("izin yok → oda 09:00–17:00 dolu", () => {
    expect(computeRoomHoldings([day([])]).map((x) => [x.start, x.end])).toEqual([[h(9), h(17)]]);
  });

  it("12:00–15:00 izin → oda 09–12 ve 15–17 dolu, 12–15 BOŞ", () => {
    const hold = computeRoomHoldings([day([{ allDay: false, start: h(12), end: h(15) }])]);
    expect(hold.map((x) => [fmt(x.start), fmt(x.end)])).toEqual([
      ["09:00", "12:00"],
      ["15:00", "17:00"],
    ]);
  });

  it("tüm gün izin → haftalık oda ataması o gün odayı TUTMAZ", () => {
    expect(computeRoomHoldings([day([{ allDay: true }])])).toEqual([]);
  });

  it("başka doktor bu boş aralıkta odayı kullanabilir (slot motoru)", () => {
    const busy = computeRoomHoldings([day([{ allDay: false, start: h(12), end: h(15) }])]);
    const slots = computeSlots({
      ...base,
      windows: [{ start: h(9), end: h(17) }],
      requiresRoom: true,
      step: 60,
      duration: 60,
      rooms: [{ roomId: "r1", roomName: "Oda 1", busy }],
    });
    expect(slots.map((s) => fmt(s.start))).toEqual(["12:00", "13:00", "14:00"]);
  });
});

describe("Randevu durum makinesi", () => {
  const ok: [string, string][] = [
    ["BOOKED", "CONFIRMED"],
    ["CONFIRMED", "CHECKED_IN"],
    ["CHECKED_IN", "IN_PROGRESS"],
    ["IN_PROGRESS", "COMPLETED"],
    ["BOOKED", "CANCELLED"],
    ["CONFIRMED", "NO_SHOW"],
    ["BOOKED", "NO_SHOW"],
  ];
  const bad: [string, string][] = [
    ["COMPLETED", "BOOKED"],
    ["CANCELLED", "CONFIRMED"],
    ["NO_SHOW", "BOOKED"],
    ["BOOKED", "COMPLETED"],
    ["IN_PROGRESS", "CANCELLED"],
    ["CHECKED_IN", "NO_SHOW"],
  ];
  it.each(ok)("%s → %s geçerli", (a, b) => expect(canTransition(a as never, b as never)).toBe(true));
  it.each(bad)("%s → %s reddedilir", (a, b) => expect(canTransition(a as never, b as never)).toBe(false));
  it("CANCELLED / NO_SHOW / DRAFT slot tutmaz", () => {
    for (const s of ["CANCELLED", "NO_SHOW", "DRAFT"]) expect(ACTIVE_STATUSES).not.toContain(s);
  });
});

describe("Saat dilimi / yaz saati (Europe/Berlin)", () => {
  it("ileri alma günü: 02:30 yaşanmaz (NONEXISTENT); 01:30 ve 03:30 normal", () => {
    expect(localTimeStatus("2027-03-28", h(2, 30), "Europe/Berlin")).toBe("NONEXISTENT");
    expect(localTimeStatus("2027-03-28", h(1, 30), "Europe/Berlin")).toBe("OK");
    expect(localTimeStatus("2027-03-28", h(3, 30), "Europe/Berlin")).toBe("OK");
  });

  it("geri alma günü: 02:30 iki kez yaşanır (AMBIGUOUS)", () => {
    expect(localTimeStatus("2027-10-31", h(2, 30), "Europe/Berlin")).toBe("AMBIGUOUS");
    expect(localTimeStatus("2027-10-31", h(9), "Europe/Berlin")).toBe("OK");
  });

  it("yerel 09:00 → UTC: kışın 08:00Z, yazın 07:00Z (sabit ofset yok)", () => {
    expect(zonedDateTimeToUtc("2027-01-11", h(9), "Europe/Berlin").toISOString()).toBe(
      "2027-01-11T08:00:00.000Z",
    );
    expect(zonedDateTimeToUtc("2027-07-12", h(9), "Europe/Berlin").toISOString()).toBe(
      "2027-07-12T07:00:00.000Z",
    );
    expect(localDateTimeOf(new Date("2027-07-12T07:00:00Z"), "Europe/Berlin")).toEqual({
      date: "2027-07-12",
      minutes: h(9),
    });
  });

  it("İstanbul yaz saati uygulamaz: her gün +03:00", () => {
    expect(localTimeStatus("2027-03-28", h(2, 30), "Europe/Istanbul")).toBe("OK");
    expect(zonedDateTimeToUtc("2027-07-12", h(9), "Europe/Istanbul").toISOString()).toBe(
      "2027-07-12T06:00:00.000Z",
    );
  });
});

describe("Sözleşmeler (Voice AI'ye hazır Zod şemaları)", () => {
  const id = "6f1c1b7e-1111-4a1a-9a1a-111111111111";
  it("geçersiz tarih / kimlik reddedilir", () => {
    expect(getAvailableSlotsInput.safeParse({ branchId: id, doctorId: id, date: "2027-02-30" }).success).toBe(
      false,
    );
    expect(
      getAvailableSlotsInput.safeParse({ branchId: "x", doctorId: id, date: "2027-02-03" }).success,
    ).toBe(false);
  });
  it("kaynak şimdilik yalnızca STAFF / DOCTOR (AI_VOICE henüz kabul edilmez)", () => {
    const b = { patientId: id, branchId: id, doctorId: id, start: "2027-02-03T07:00:00.000Z" };
    expect(createAppointmentInput.safeParse(b).success).toBe(true);
    expect(createAppointmentInput.safeParse({ ...b, source: "AI_VOICE" }).success).toBe(false);
    expect(createAppointmentInput.safeParse({ ...b, start: "yarın 10:00" }).success).toBe(false);
  });
});
