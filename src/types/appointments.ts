/** Randevu ekranlarında istemci ve sunucunun paylaştığı tipler (çalışma zamanı kodu yok). */
export type AppointmentStatus =
  | "DRAFT"
  | "BOOKED"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "PENDING_APPROVAL";

export type SlotReason =
  | "OK"
  | "NOT_WORKING"
  | "DOCTOR_EXCEPTION"
  | "BRANCH_CLOSED"
  | "INACTIVE"
  | "FULLY_BOOKED"
  | "NO_ROOM"
  | "OUT_OF_RANGE"
  | "SERVICE_NOT_OFFERED";

export type AvailableSlot = {
  /** Şube yerel saati "HH:MM". */
  start: string;
  end: string;
  startUtc: string;
  endUtc: string;
  rooms: { roomId: string; roomName: string }[];
};

export type AvailableSlotsResult = {
  date: string;
  timezone: string;
  branchId: string;
  doctorId: string;
  serviceId: string | null;
  durationMinutes: number;
  requiresRoom: boolean;
  reason: SlotReason;
  slots: AvailableSlot[];
};

export type BookingOption = { id: string; name: string };
export type ServiceOption = BookingOption & { durationMinutes: number; requiresRoom: boolean };
export type PatientOption = {
  id: string;
  patientNumber: string;
  firstName: string;
  lastName: string;
  phoneMasked: string;
};
