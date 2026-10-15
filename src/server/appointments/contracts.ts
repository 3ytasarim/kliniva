import { z } from "zod";
import { isValidDate } from "@/lib/time";
import { uuidSchema } from "@/server/validation";

/**
 * Randevu uygulama servislerinin GİRDİ sözleşmeleri — HTTP / server action / (ileride) Voice AI araçları aynı
 * şemaları kullanır. Yapay zekâ veritabanına doğrudan erişmez; yalnızca bu sözleşmelerle servis çağırır ve
 * servisler oturumdaki kullanıcının yetkisi + kiracı/şube kapsamıyla çalışır.
 * (Bu sprintte Voice AI bağlantısı YOKTUR — yalnızca tip/şema hazırlığı.)
 */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const dateString = z.string().refine(isValidDate, "invalid date");
const optUuid = z.preprocess(blank, uuidSchema.optional());
const optDuration = z.preprocess(blank, z.coerce.number().int().min(5).max(480).optional());
/** UTC ISO an (ör. 2026-10-20T07:30:00.000Z). Sunucunun ürettiği slot.startUtc değeri gönderilir. */
const instant = z.iso.datetime({ offset: true });

export const getAvailableSlotsInput = z.object({
  branchId: uuidSchema,
  doctorId: uuidSchema,
  serviceId: optUuid,
  date: dateString,
  durationMinutes: optDuration,
  /** Hasta biliniyorsa onun çakışan randevuları da düşülür. */
  patientId: optUuid,
  /** Taşıma ekranı: taşınan randevunun kendi eski aralığı dolu sayılmaz (erişim yetkisi doğrulanır). */
  excludeAppointmentId: optUuid,
});
export type GetAvailableSlotsInput = z.input<typeof getAvailableSlotsInput>;

export const getDoctorAvailabilityInput = z.object({
  branchId: uuidSchema,
  doctorId: uuidSchema,
  serviceId: optUuid,
  fromDate: dateString,
  days: z.coerce.number().int().min(1).max(14).default(7),
});
export type GetDoctorAvailabilityInput = z.input<typeof getDoctorAvailabilityInput>;

export const createAppointmentInput = z.object({
  patientId: uuidSchema,
  branchId: uuidSchema,
  doctorId: uuidSchema,
  serviceId: optUuid,
  start: instant,
  durationMinutes: optDuration,
  roomId: optUuid,
  notes: z.preprocess(blank, z.string().trim().max(2000).optional()),
  /** Şimdilik aktif kaynaklar: STAFF, DOCTOR (AI_VOICE ileride). */
  source: z.enum(["STAFF", "DOCTOR"]).default("STAFF"),
});
export type CreateAppointmentInput = z.input<typeof createAppointmentInput>;

export const rescheduleAppointmentInput = z.object({
  start: instant,
  roomId: optUuid,
});
export type RescheduleAppointmentInput = z.input<typeof rescheduleAppointmentInput>;

export const cancelAppointmentInput = z.object({
  reason: z.preprocess(blank, z.string().trim().min(3).max(500).optional()),
});
export type CancelAppointmentInput = z.input<typeof cancelAppointmentInput>;

export const updateAppointmentStatusInput = z.object({
  status: z.enum(["CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "NO_SHOW"]),
});
export type UpdateAppointmentStatusInput = z.input<typeof updateAppointmentStatusInput>;

export const listAppointmentsInput = z.object({
  from: dateString,
  to: dateString,
  branchId: optUuid,
  doctorId: optUuid,
  patientId: optUuid,
  status: z.preprocess(
    blank,
    z
      .enum([
        "DRAFT",
        "BOOKED",
        "CONFIRMED",
        "CHECKED_IN",
        "IN_PROGRESS",
        "COMPLETED",
        "CANCELLED",
        "NO_SHOW",
      ])
      .optional(),
  ),
});
export type ListAppointmentsInput = z.input<typeof listAppointmentsInput>;

export const appointmentNotesInput = z.object({
  notes: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().max(2000)),
});
