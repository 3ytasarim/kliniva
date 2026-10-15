/**
 * Randevu motoru — SAF hesaplama (DB yok → birim test edilebilir). Aralıklar yarı açık [start, end), dakika.
 *
 *   uygun slot = doktorun efektif müsaitliği (çalışma ∩ şube saatleri − izin − kapanış; computeAvailability)
 *              − doktorun mevcut randevuları − hastanın mevcut randevuları
 *              ∩ (oda gerekiyorsa) en az bir uygun oda
 *
 * Oda uygunluğu: oda tipi hizmete uygun + o aralıkta oda randevusu yok + oda BAŞKA bir doktorun EFEKTİF oda
 * atamasında değil. Efektif atama = atama ∩ o doktorun gerçekten çalıştığı süre (izin / kapanış düşülmüş) →
 * izinli doktorun haftalık odası o gün (veya izinli saatlerde) boş sayılır.
 */
import {
  computeAvailability,
  normalize,
  overlaps,
  type AvailabilityInput,
  type Interval,
} from "@/server/scheduling/availability";

export type RoomHolding = Interval & { roomId: string; doctorId: string };

export type DoctorDay = { doctorId: string } & AvailabilityInput;

/** Her doktorun efektif oda segmentleri (izin ve kapanışlar düşülmüş). */
export function computeRoomHoldings(doctors: DoctorDay[]): RoomHolding[] {
  const out: RoomHolding[] = [];
  for (const d of doctors) {
    for (const seg of computeAvailability(d)) {
      if (seg.roomId) out.push({ start: seg.start, end: seg.end, roomId: seg.roomId, doctorId: d.doctorId });
    }
  }
  return out;
}

export type RoomCandidate = {
  roomId: string;
  roomName: string;
  /** Oda randevuları + diğer doktorların efektif atamaları. */
  busy: Interval[];
};

export type SlotInput = {
  /** Doktorun efektif müsait pencereleri. */
  windows: Interval[];
  /** Doktorun kendi oda atamaları (tercih edilen oda). */
  ownRooms: { start: number; end: number; roomId: string }[];
  doctorBusy: Interval[];
  patientBusy: Interval[];
  duration: number;
  step: number;
  /** Bu dakikadan önce başlayan slot üretilmez (bugün için şimdi + asgari süre). */
  earliestStart: number;
  requiresRoom: boolean;
  /** Tipi uygun, aktif odalar. */
  rooms: RoomCandidate[];
};

export type Slot = Interval & { rooms: { roomId: string; roomName: string }[] };

export function computeSlots(input: SlotInput): Slot[] {
  const { duration, step } = input;
  if (duration <= 0 || step <= 0) return [];
  const slots: Slot[] = [];
  for (const w of normalize(input.windows)) {
    const first = Math.max(Math.ceil(w.start / step) * step, Math.ceil(input.earliestStart / step) * step);
    for (let t = first; t + duration <= w.end; t += step) {
      if (t < w.start) continue;
      const iv = { start: t, end: t + duration };
      if (input.doctorBusy.some((b) => overlaps(b, iv))) continue;
      if (input.patientBusy.some((b) => overlaps(b, iv))) continue;
      const free = input.rooms.filter((r) => !r.busy.some((b) => overlaps(b, iv)));
      if (input.requiresRoom && free.length === 0) continue;
      const preferred = new Set(
        input.ownRooms.filter((o) => o.start <= iv.start && o.end >= iv.end).map((o) => o.roomId),
      );
      free.sort(
        (a, b) =>
          Number(preferred.has(b.roomId)) - Number(preferred.has(a.roomId)) ||
          a.roomName.localeCompare(b.roomName, "tr"),
      );
      slots.push({ ...iv, rooms: free.map((r) => ({ roomId: r.roomId, roomName: r.roomName })) });
    }
  }
  return slots;
}

// ---------------------------------------------------------------- durum makinesi (DB tetikleyicisiyle aynı)

export const APPOINTMENT_STATUSES = [
  "DRAFT",
  "BOOKED",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "PENDING_APPROVAL",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Slot tutan (çakışma kontrolüne giren) statüler — exclusion constraint WHERE koşuluyla aynı. */
export const ACTIVE_STATUSES: AppointmentStatus[] = [
  // Doktor onayı bekleyen randevu da slotu tutar (reddedilince CANCELLED → slot boşalır).
  "PENDING_APPROVAL",
  "BOOKED",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
];

const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  DRAFT: ["BOOKED", "CANCELLED"],
  BOOKED: ["CONFIRMED", "CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  // Doktor onayı: kabul → BOOKED, ret (veya resepsiyon iptali) → CANCELLED.
  PENDING_APPROVAL: ["BOOKED", "CANCELLED"],
};

export const canTransition = (from: AppointmentStatus, to: AppointmentStatus) =>
  TRANSITIONS[from].includes(to);
export const nextStatuses = (from: AppointmentStatus) => TRANSITIONS[from];
export const isReschedulable = (s: AppointmentStatus) =>
  s === "DRAFT" || s === "BOOKED" || s === "CONFIRMED" || s === "PENDING_APPROVAL";
