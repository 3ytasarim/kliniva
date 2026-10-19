import type { QuickAction } from "@/components/appointment-ui";

/** Saati gelen / işlem bekleyen randevu (açılır hatırlatma kartı). Hasta adı yalnızca yetkili kullanıcıya. */
export type AppointmentReminder = {
  id: string;
  kind: "due" | "waiting" | "overdue";
  localStart: string;
  localEnd: string;
  patient: string;
  service: string | null;
  room: string | null;
  doctor: string;
  actions: QuickAction[];
};
