import type { AppointmentStatus } from "@/types/appointments";

/** Randevu ekranlarında ortak etiketler / rozetler (sunucu ve istemci bileşeni olarak kullanılabilir). */
export const APPOINTMENT_STATUS: Record<AppointmentStatus, { label: string; badge: string; card: string }> = {
  DRAFT: { label: "Taslak", badge: "badge-gray", card: "border-slate-300 bg-white dark:bg-slate-900" },
  BOOKED: {
    label: "Planlandı",
    badge: "badge-gray",
    card: "border-slate-400 bg-white dark:border-slate-500 dark:bg-slate-900",
  },
  CONFIRMED: {
    label: "Onaylandı",
    badge: "badge-brand",
    card: "border-brand-500 bg-brand-50 dark:bg-brand-900",
  },
  CHECKED_IN: {
    label: "Geldi",
    badge: "badge-amber",
    card: "border-amber-500 bg-amber-50 dark:bg-amber-950",
  },
  IN_PROGRESS: {
    label: "İşlemde",
    badge: "badge-sky",
    card: "border-sky-500 bg-sky-50 dark:bg-sky-950",
  },
  COMPLETED: {
    label: "Tamamlandı",
    badge: "badge-green",
    card: "border-emerald-500 bg-emerald-50 dark:bg-emerald-950",
  },
  CANCELLED: {
    label: "İptal",
    badge: "badge-gray",
    card: "border-slate-300 bg-slate-50 text-slate-500 line-through dark:bg-slate-900",
  },
  NO_SHOW: { label: "Gelmedi", badge: "badge-red", card: "border-red-400 bg-red-50 dark:bg-red-950" },
  PENDING_APPROVAL: {
    label: "Onay bekliyor",
    badge: "badge-amber",
    card: "border-dashed border-amber-500 bg-amber-50 dark:bg-amber-950",
  },
};

export function AppointmentStatusBadge({ status }: { status: AppointmentStatus }) {
  const s = APPOINTMENT_STATUS[status];
  return <span className={`badge ${s.badge}`}>{s.label}</span>;
}

export const ACTION_LABELS: Record<string, string> = {
  CONFIRMED: "Onayla",
  CHECKED_IN: "Hasta geldi (check-in)",
  IN_PROGRESS: "Başlat",
  COMPLETED: "Tamamla",
  NO_SHOW: "Gelmedi",
};

export const EVENT_LABELS: Record<string, string> = {
  CREATED: "Randevu oluşturuldu",
  RESCHEDULED: "Randevu taşındı",
  CONFIRMED: "Onaylandı",
  CHECKED_IN: "Hasta geldi",
  STARTED: "Muayene / işlem başladı",
  COMPLETED: "Tamamlandı",
  CANCELLED: "İptal edildi",
  NO_SHOW: "Gelmedi olarak işaretlendi",
  NOTES_UPDATED: "Operasyon notu güncellendi",
  APPROVED: "Doktor onayladı",
  DECLINED: "Doktor reddetti",
};

export const SLOT_REASON_LABELS: Record<string, string> = {
  OK: "",
  NOT_WORKING: "Doktor bu gün bu şubede çalışmıyor.",
  DOCTOR_EXCEPTION: "Doktor bu gün izinli.",
  BRANCH_CLOSED: "Şube bu gün kapalı.",
  INACTIVE: "Doktor, şube veya atama aktif değil.",
  FULLY_BOOKED: "Bu gün için uygun saat kalmadı.",
  NO_ROOM: "Bu hizmete uygun boş oda yok.",
  OUT_OF_RANGE: "Bu tarih randevu alınabilecek aralığın dışında.",
  SERVICE_NOT_OFFERED: "Doktor bu hizmeti vermiyor.",
};

export const formatLocalDate = (date: string) =>
  new Intl.DateTimeFormat("tr-TR", { dateStyle: "full", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
