import { requireUserFromRequest } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { AppError } from "@/server/errors";
import { handle, json } from "@/server/http";
import { getTodayAppointments } from "@/server/services/appointments";
import { quickActions } from "@/components/appointment-ui";
import type { AppointmentReminder } from "@/types/reminders";

export const dynamic = "force-dynamic";

const EARLY_MS = 5 * 60_000; // randevudan 5 dk önce
const LATE_MS = 30 * 60_000; // bitişten 30 dk sonrasına kadar "geldi mi?"

/**
 * GET /api/v1/appointments/reminders — ŞU AN işlem bekleyen bugünkü randevular (açılır hatırlatma kartı):
 *  - due: planlı / onaylı, saati geldi (−5 dk … bitiş + 30 dk) → "Hasta geldi mi?"
 *  - waiting: hasta geldi, muayene başlamadı (başlatma yetkisi olana) → "Muayeneyi başlat"
 *  - overdue: muayenede, bitiş saati geçti → "Tamamlandı mı?"
 * Kapsam servisten (doktor: yalnızca KENDİ randevuları; personel: yetkili şubeler). İşlem düğmeleri kullanıcının
 * yetkisine göre; sunucu her geçişi ayrıca doğrular. Hasta adı dışında kişisel veri yok.
 */
export async function GET(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    if (!hasPermission(ctx, "appointment.read") && !hasPermission(ctx, "appointment.read.own")) {
      throw new AppError("FORBIDDEN");
    }
    const perms = {
      checkin: hasPermission(ctx, "appointment.checkin"),
      start: hasPermission(ctx, "appointment.start"),
      complete: hasPermission(ctx, "appointment.complete"),
      noShow: hasPermission(ctx, "appointment.no_show"),
    };
    if (!perms.checkin && !perms.start && !perms.complete && !perms.noShow) return json({ data: [] });
    const { items } = await getTodayAppointments(ctx);
    const now = Date.now();
    const out: AppointmentReminder[] = [];
    for (const a of items) {
      const start = new Date(a.start).getTime();
      const end = new Date(a.end).getTime();
      let kind: AppointmentReminder["kind"] | null = null;
      if (
        (a.status === "BOOKED" || a.status === "CONFIRMED") &&
        now >= start - EARLY_MS &&
        now <= end + LATE_MS
      )
        kind = "due";
      else if (a.status === "CHECKED_IN" && perms.start && now >= start - EARLY_MS) kind = "waiting";
      else if (a.status === "IN_PROGRESS" && now >= end) kind = "overdue";
      if (!kind) continue;
      const actions = quickActions(a.status, perms, now >= start);
      if (!actions.length) continue;
      out.push({
        id: a.id,
        kind,
        localStart: a.localStart,
        localEnd: a.localEnd,
        patient: a.patient.name,
        service: a.service?.name ?? null,
        room: a.room?.name ?? null,
        doctor: a.doctor.name,
        actions,
      });
    }
    return json({ data: out });
  });
}
