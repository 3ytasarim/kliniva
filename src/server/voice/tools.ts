import "server-only";
import { z } from "zod";
import { AppError, isAppError } from "@/server/errors";
import { hasPermission } from "@/server/auth/authz";
import { tenantQuery } from "@/server/tenant/tenant-query";
import { uuidSchema } from "@/server/validation";
import { logger } from "@/server/log/logger";
import { zonedDateTimeToUtc, parseTime } from "@/lib/time";
import { listBranches } from "@/server/services/org";
import { listBookableDoctors, listClinicalServices } from "@/server/services/clinical-services";
import { listPatients, loadVisiblePatient } from "@/server/services/patients";
import {
  cancelAppointment,
  createAppointment,
  getAppointment,
  getAppointmentStats,
  getAvailableSlots,
  getTodayAppointments,
  rescheduleAppointment,
  updateAppointmentStatus,
} from "@/server/services/appointments";
import { getLowStockItems, getStockByLocation } from "@/server/services/inventory";
import { getExpiringLots } from "@/server/services/lots";
import { recordMaterialUsage } from "@/server/services/material-usage";
import {
  formatDateLabel,
  resolveDateExpression,
  resolvePartOfDay,
  resolveTime,
  type VoiceLanguage,
} from "@/server/voice/dates";
import { translateVoiceError, voiceMaskedPhone, voicePatientName } from "@/server/voice/policy";
import {
  cancelPendingAction,
  confirmPendingAction,
  preparePendingAction,
  priorExecution,
  type ExecResult,
  type Executor,
} from "@/server/voice/actions";
import type { VoiceToolContext } from "@/server/voice/session";
import type { RealtimeTool } from "@/server/voice/transport";

/**
 * Sesli asistan ARAÇLARI — mevcut iş servislerinin İNCE sarmalayıcıları. AI veritabanına DOĞRUDAN erişmez; ayrı SQL
 * yazılmaz; Sprint 0–6 yetki / RLS / şube / doktor kapsamı aynen uygulanır (sesli asistan ek yetki VERMEZ).
 *  - Şemalarda tenantId / userId / rol YOK: bunlar sunucudaki oturumdan gelir.
 *  - Girdiler Zod ile doğrulanır; tarih / saat sunucuda klinik / şube saat dilimine göre çözülür.
 *  - Çıktılar EN AZ veri (DTO): listeler sınırlı, hasta adı gizlilik moduna göre kısaltılır, telefon maskeli,
 *    TC kimlik / sağlık notu hiç yok.
 *  - Yazma araçları işlemi yalnızca HAZIRLAR (onay gerekir); yürütme voice_confirm_action ile.
 */
type ToolKind = "READ" | "WRITE" | "CONTROL";
type ToolDef = {
  name: string;
  kind: ToolKind;
  description: string;
  schema: z.ZodType;
  run: (tc: VoiceToolContext, args: never) => Promise<Record<string, unknown>>;
};

const id = uuidSchema;
const optId = uuidSchema.optional();
const text = (max: number) => z.string().trim().min(1).max(max);
const L = (tc: VoiceToolContext) => tc.session.language;

function needs(field: string, message: string, options?: unknown) {
  return { ok: false, needs: field, message, ...(options ? { options } : {}) };
}

/** Ad karşılaştırması: "Dr. Ahmet" ↔ "Op. Dr. Ahmet Kaya" (aksan / büyük-küçük harf duyarsız). */
const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/\b(prof|doç|doc|uzm|op|dr|doktor|doctor)\b\.?/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const nameMatches = (candidate: string, query: string) => {
  const q = fold(query).split(" ").filter(Boolean);
  const c = fold(candidate);
  return q.length > 0 && q.every((t) => c.split(" ").some((w) => w.startsWith(t)));
};

// ---------------------------------------------------------------- ortak çözümleyiciler

async function branchesOf(tc: VoiceToolContext) {
  if (!hasPermission(tc.ctx, "branch.read")) return [];
  return (await listBranches(tc.ctx)).filter((b) => b.active);
}

async function doctorsOf(tc: VoiceToolContext, opts: { branchId?: string; serviceId?: string } = {}) {
  const branches = await branchesOf(tc);
  const list = opts.branchId ? branches.filter((b) => b.id === opts.branchId) : branches;
  const map = new Map<
    string,
    { doctorId: string; name: string; specialty: string; branches: { branchId: string; name: string }[] }
  >();
  for (const b of list) {
    for (const d of await listBookableDoctors(tc.ctx, { branchId: b.id, serviceId: opts.serviceId })) {
      const cur = map.get(d.id) ?? { doctorId: d.id, name: d.name, specialty: d.specialty, branches: [] };
      cur.branches.push({ branchId: b.id, name: b.name });
      map.set(d.id, cur);
    }
  }
  return [...map.values()];
}

/** Doktorun şubesi: verilmişse o; tek şubeyse o; birden fazlaysa kullanıcıya sorulur. */
async function resolveBranch(tc: VoiceToolContext, doctorId: string, branchId: string | undefined) {
  const docs = await doctorsOf(tc);
  const doc = docs.find((d) => d.doctorId === doctorId);
  if (!doc) throw new AppError("NOT_FOUND");
  if (branchId) {
    const b = doc.branches.find((x) => x.branchId === branchId);
    if (!b) throw new AppError("NOT_FOUND");
    return { doctor: doc, branch: b, choose: null };
  }
  if (doc.branches.length === 1) return { doctor: doc, branch: doc.branches[0]!, choose: null };
  return { doctor: doc, branch: null, choose: doc.branches };
}

async function branchTimezone(tc: VoiceToolContext, branchId: string) {
  const b = (await branchesOf(tc)).find((x) => x.id === branchId);
  return b?.timezone ?? tc.session.timezone;
}

function resolveDateOrThrow(tc: VoiceToolContext, expression: string, tz = tc.session.timezone) {
  const d = resolveDateExpression(expression, tz, new Date(), L(tc));
  if (!d) throw new AppError("VALIDATION", { fields: ["date"], message: "Tarih anlaşılamadı." });
  return d;
}

async function serviceOf(tc: VoiceToolContext, serviceId: string) {
  const svc = (await listClinicalServices(tc.ctx, { activeOnly: true })).find((s) => s.id === serviceId);
  if (!svc) throw new AppError("NOT_FOUND");
  return svc;
}

async function patientName(tc: VoiceToolContext, patientId: string) {
  const p = await tenantQuery(tc.ctx, (scope) => loadVisiblePatient(scope, tc.ctx, patientId));
  return { name: voicePatientName(p.firstName, p.lastName, tc.session.privacyMode), number: p.patientNumber };
}

function startInstant(date: string, time: string, tz: string): string {
  const minutes = parseTime(time);
  if (minutes === null) throw new AppError("VALIDATION", { fields: ["time"], message: "Saat anlaşılamadı." });
  return zonedDateTimeToUtc(date, minutes, tz).toISOString();
}

function timeOrThrow(expression: string) {
  const t = resolveTime(expression);
  if (!t) throw new AppError("VALIDATION", { fields: ["time"], message: "Saat anlaşılamadı." });
  return t;
}

// ---------------------------------------------------------------- OKUMA araçları

const resolveDate: ToolDef = {
  name: "voice_resolve_date",
  kind: "READ",
  description:
    "Doğal tarih ifadesini ('yarın', 'cuma', 'gelecek pazartesi', '16 Ekim') klinik saat dilimine göre mutlak tarihe çevirir.",
  schema: z.object({ expression: text(60) }),
  run: async (tc, a: { expression: string }) => {
    const d = resolveDateOrThrow(tc, a.expression);
    return { ok: true, date: d.date, dateLabel: d.label };
  },
};

const listBranchesTool: ToolDef = {
  name: "voice_list_branches",
  kind: "READ",
  description: "Kullanıcının erişebildiği aktif şubeleri listeler (ad ve kimlik).",
  schema: z.object({}),
  run: async (tc) => ({
    ok: true,
    branches: (await branchesOf(tc))
      .slice(0, 20)
      .map((b) => ({ branchId: b.id, name: b.name, city: b.city })),
  }),
};

const listServicesTool: ToolDef = {
  name: "voice_list_services",
  kind: "READ",
  description: "Randevu verilebilen aktif hizmetleri (muayene, işlem) süreleriyle listeler.",
  schema: z.object({}),
  run: async (tc) => ({
    ok: true,
    services: (await listClinicalServices(tc.ctx, { activeOnly: true }))
      .slice(0, 20)
      .map((s) => ({ serviceId: s.id, name: s.name, durationMinutes: s.defaultDurationMinutes })),
  }),
};

const listDoctorsTool: ToolDef = {
  name: "voice_list_doctors",
  kind: "READ",
  description:
    "Doktorları ad, şube veya uzmanlığa göre bulur (ör. 'Dr. Ahmet'). Doktor kimliğini almak için kullan; en fazla 10 sonuç.",
  schema: z.object({ name: text(60).optional(), branchId: optId, specialty: text(60).optional() }),
  run: async (tc, a: { name?: string; branchId?: string; specialty?: string }) => {
    const all = await doctorsOf(tc, { branchId: a.branchId });
    const found = all
      .filter((d) => (a.name ? nameMatches(d.name, a.name) : true))
      .filter((d) => (a.specialty ? fold(d.specialty).includes(fold(a.specialty)) : true))
      .slice(0, 10);
    return { ok: true, count: found.length, doctors: found };
  },
};

const availabilityTool: ToolDef = {
  name: "voice_get_doctor_availability",
  kind: "READ",
  description:
    "Bir doktorun belirli bir gündeki MÜSAİT saatlerini sistemden getirir. Müsaitlik hakkında yalnızca bu aracın sonucunu söyle. date: doğal ifade veya YYYY-MM-DD; partOfDay: 'sabah' / 'öğleden sonra' / 'akşam' (isteğe bağlı).",
  schema: z.object({
    doctorId: id,
    date: text(60),
    branchId: optId,
    serviceId: optId,
    partOfDay: text(30).optional(),
  }),
  run: async (
    tc,
    a: { doctorId: string; date: string; branchId?: string; serviceId?: string; partOfDay?: string },
  ) => {
    const r = await resolveBranch(tc, a.doctorId, a.branchId);
    if (!r.branch) {
      return needs("branchId", L(tc) === "en" ? "Which branch?" : "Hangi şube?", r.choose);
    }
    const tz = await branchTimezone(tc, r.branch.branchId);
    const d = resolveDateOrThrow(tc, a.date, tz);
    const res = await getAvailableSlots(tc.ctx, {
      branchId: r.branch.branchId,
      doctorId: a.doctorId,
      serviceId: a.serviceId,
      date: d.date,
    });
    const window = resolvePartOfDay(a.partOfDay);
    const slots = res.slots
      .filter((s) => (window ? s.start >= window.from && s.start < window.to : true))
      .slice(0, 24)
      .map((s) => s.start);
    return {
      ok: true,
      doctor: r.doctor.name,
      branch: r.branch.name,
      branchId: r.branch.branchId,
      date: d.date,
      dateLabel: d.label,
      durationMinutes: res.durationMinutes,
      reason: res.reason,
      availableTimes: slots,
      count: slots.length,
    };
  },
};

const todayTool: ToolDef = {
  name: "voice_get_today_appointments",
  kind: "READ",
  description:
    "Bugünün randevularını (kullanıcının yetki kapsamında; doktor yalnızca KENDİ randevularını) sayılar ve kısa liste olarak getirir.",
  schema: z.object({ branchId: optId, doctorId: optId }),
  run: async (tc, a: { branchId?: string; doctorId?: string }) => {
    const { today, items } = await getTodayAppointments(tc.ctx, { branchId: a.branchId });
    const list = items.filter((i) => (a.doctorId ? i.doctor.id === a.doctorId : true));
    const active = list.filter((i) => i.status !== "CANCELLED");
    const by = (s: string) => list.filter((i) => i.status === s).length;
    return {
      ok: true,
      date: today,
      dateLabel: formatDateLabel(today, L(tc)),
      total: active.length,
      byStatus: {
        pendingApproval: by("PENDING_APPROVAL"),
        booked: by("BOOKED") + by("CONFIRMED"),
        checkedIn: by("CHECKED_IN"),
        inProgress: by("IN_PROGRESS"),
        completed: by("COMPLETED"),
        noShow: by("NO_SHOW"),
        cancelled: by("CANCELLED"),
      },
      appointments: active.slice(0, 15).map((i) => {
        const [first, ...rest] = i.patient.name.split(" ");
        return {
          appointmentId: i.id,
          time: i.localStart,
          doctor: i.doctor.name,
          room: i.room?.name ?? null,
          service: i.service?.name ?? null,
          status: i.status,
          patient: voicePatientName(first ?? "", rest.join(" "), tc.session.privacyMode),
        };
      }),
      truncated: active.length > 15,
    };
  },
};

const branchSummaryTool: ToolDef = {
  name: "voice_get_branch_summary",
  kind: "READ",
  description:
    "Bugünkü operasyon sayıları (toplam, bekleyen, giriş yapmış, işlemde, tamamlanan, gelmeyen, iptal).",
  schema: z.object({ branchId: optId }),
  run: async (tc, a: { branchId?: string }) => {
    const s = await getAppointmentStats(tc.ctx, { branchId: a.branchId });
    return { ok: true, ...s, dateLabel: formatDateLabel(s.date, L(tc)) };
  },
};

const appointmentTool: ToolDef = {
  name: "voice_get_appointment",
  kind: "READ",
  description: "Tek bir randevunun özetini getirir (tarih, saat, doktor, şube, oda, hizmet, durum).",
  schema: z.object({ appointmentId: id }),
  run: async (tc, a: { appointmentId: string }) => {
    const r = await getAppointment(tc.ctx, a.appointmentId);
    const [first, ...rest] = r.patient.name.split(" ");
    return {
      ok: true,
      appointmentId: r.id,
      dateLabel: formatDateLabel(r.localDate, L(tc)),
      time: r.localStart,
      doctor: r.doctor.name,
      branch: r.branch.name,
      room: r.room?.name ?? null,
      service: r.service?.name ?? null,
      status: r.status,
      patient: voicePatientName(first ?? "", rest.join(" "), tc.session.privacyMode),
      patientNumber: r.patient.patientNumber,
    };
  },
};

const findPatientTool: ToolDef = {
  name: "voice_find_patient",
  kind: "READ",
  description:
    "Hastayı hasta numarası, ad veya telefonla arar (en fazla 5). Birden fazla sonuç varsa hasta numaralarını okuyup kullanıcıya hangisi olduğunu sor; kendin seçme.",
  schema: z.object({ query: text(80) }),
  run: async (tc, a: { query: string }) => {
    const r = await listPatients(tc.ctx, { q: a.query, limit: 5, status: "active" });
    const patients = r.items.map((p) => ({
      patientId: p.id,
      patientNumber: p.patientNumber,
      displayName: voicePatientName(p.firstName, p.lastName, tc.session.privacyMode),
      maskedPhone: voiceMaskedPhone(p.phoneMasked),
      branch: p.primaryBranchName,
    }));
    return { ok: true, count: patients.length, ambiguous: patients.length > 1, patients };
  },
};

const inventoryTool: ToolDef = {
  name: "voice_get_inventory",
  kind: "READ",
  description:
    "Bir ürünün lokasyon bazında stoğunu getirir. 'usable' (kullanılabilir — SKT geçmiş / geri çağrılmış lot hariç) değerini söyle; fiziksel stoğu kullanılabilir gibi söyleme.",
  schema: z.object({ query: text(80), branchId: optId, locationId: optId }),
  run: async (tc, a: { query: string; branchId?: string; locationId?: string }) => {
    const rows = await getStockByLocation(tc.ctx, { branchId: a.branchId, locationId: a.locationId });
    const hits = rows
      .filter((r) => nameMatches(r.itemName, a.query) || fold(r.locationName).includes(fold(a.query)))
      .slice(0, 10)
      .map((r) => ({
        itemId: r.itemId,
        item: r.itemName,
        location: r.locationName,
        branch: r.branchName,
        usable: Number(r.usableQuantity),
        physical: Number(r.quantity),
        unit: r.unit,
        lotTracked: r.trackLots,
      }));
    return { ok: true, count: hits.length, stock: hits };
  },
};

const lowStockTool: ToolDef = {
  name: "voice_get_low_stock",
  kind: "READ",
  description:
    "Kritik (asgari seviyede veya altında) ve tükenen ürünleri getirir (kullanılabilir stoğa göre).",
  schema: z.object({ branchId: optId }),
  run: async (tc, a: { branchId?: string }) => {
    const r = await getLowStockItems(tc.ctx, { branchId: a.branchId });
    return {
      ok: true,
      lowCount: r.low.length,
      low: r.low.slice(0, 10).map((x) => ({
        item: x.itemName,
        location: x.locationName,
        branch: x.branchName,
        usable: Number(x.usableQuantity),
        minimum: x.minimumStockLevel === null ? null : Number(x.minimumStockLevel),
      })),
      outOfStockCount: r.outOfStock.length,
      outOfStock: r.outOfStock.slice(0, 10).map((x) => x.name),
    };
  },
};

const expiringTool: ToolDef = {
  name: "voice_get_expiring_lots",
  kind: "READ",
  description:
    "Belirtilen gün içinde SKT'si dolacak lotlar (ürün, lot, SKT, lokasyon). Hasta izleme bilgisi içermez.",
  schema: z.object({ days: z.coerce.number().int().min(1).max(365).optional(), branchId: optId }),
  run: async (tc, a: { days?: number; branchId?: string }) => {
    const r = await getExpiringLots(tc.ctx, { days: a.days, branchId: a.branchId, kind: "expiring" });
    return {
      ok: true,
      days: r.days,
      count: r.rows.length,
      lots: r.rows.slice(0, 10).map((l) => ({
        item: l.itemName,
        lot: l.lotNumber,
        expiryLabel: l.expiryDate ? formatDateLabel(l.expiryDate, L(tc)) : null,
        daysRemaining: l.daysRemaining,
        location: l.locationName,
        quantity: Number(l.quantity),
      })),
    };
  },
};

// ---------------------------------------------------------------- YAZMA araçları (yalnızca hazırlar)

const createAppointmentTool: ToolDef = {
  name: "voice_create_appointment",
  kind: "WRITE",
  description:
    "Randevu oluşturmayı HAZIRLAR (onay gerekir). patientId voice_find_patient sonucundan, doctorId voice_list_doctors sonucundan alınmalı. date: doğal ifade veya YYYY-MM-DD; time: 'HH:MM'. Hizmet belirtilmemişse önce kullanıcıya sor.",
  schema: z.object({
    patientId: id,
    doctorId: id,
    date: text(60),
    time: text(20),
    serviceId: optId,
    branchId: optId,
  }),
  run: async (
    tc,
    a: {
      patientId: string;
      doctorId: string;
      date: string;
      time: string;
      serviceId?: string;
      branchId?: string;
    },
  ) => {
    if (!hasPermission(tc.ctx, "appointment.create")) throw new AppError("FORBIDDEN");
    const r = await resolveBranch(tc, a.doctorId, a.branchId);
    if (!r.branch) return needs("branchId", L(tc) === "en" ? "Which branch?" : "Hangi şubede?", r.choose);
    if (!a.serviceId) {
      const services = (await listClinicalServices(tc.ctx, { activeOnly: true })).slice(0, 10);
      return needs(
        "serviceId",
        L(tc) === "en" ? "Which service should I book?" : "Hangi hizmet için randevu oluşturayım?",
        services.map((s) => ({ serviceId: s.id, name: s.name, durationMinutes: s.defaultDurationMinutes })),
      );
    }
    const svc = await serviceOf(tc, a.serviceId);
    const tz = await branchTimezone(tc, r.branch.branchId);
    const d = resolveDateOrThrow(tc, a.date, tz);
    const time = timeOrThrow(a.time);
    const patient = await patientName(tc, a.patientId);
    const input = {
      patientId: a.patientId,
      doctorId: a.doctorId,
      branchId: r.branch.branchId,
      serviceId: a.serviceId,
      start: startInstant(d.date, time, tz),
    };
    const prior = await priorExecution(tc, "voice_create_appointment", input);
    if (prior) return { ok: true, ...prior };
    // Müsaitlik doğrulaması (hazırlıkta) — yürütmede servis yeniden doğrular (yarış: çakışma kodu).
    const slots = await getAvailableSlots(tc.ctx, {
      branchId: r.branch.branchId,
      doctorId: a.doctorId,
      serviceId: a.serviceId,
      date: d.date,
      patientId: a.patientId,
    });
    if (!slots.slots.some((s) => s.start === time)) {
      return {
        ok: false,
        error: "APPOINTMENT_CONFLICT",
        message: translateVoiceError("APPOINTMENT_CONFLICT", L(tc)),
        alternatives: slots.slots.slice(0, 6).map((s) => s.start),
        dateLabel: d.label,
      };
    }
    const summary =
      L(tc) === "en"
        ? `I will book a ${svc.defaultDurationMinutes}-minute ${svc.name} for ${patient.name} (${patient.number}) with ${r.doctor.name} at the ${r.branch.name} branch on ${d.label}, ${time}. Do you confirm?`
        : `${patient.name} (${patient.number}) için ${r.branch.name} şubesinde ${r.doctor.name} ile ${d.label}, ${time} saatine ${svc.defaultDurationMinutes} dakikalık ${svc.name} randevusu oluşturacağım. Onaylıyor musunuz?`;
    return {
      ok: true,
      ...(await preparePendingAction(tc, "voice_create_appointment", input, summary)),
      dateLabel: d.label,
      time,
    };
  },
};

const rescheduleTool: ToolDef = {
  name: "voice_reschedule_appointment",
  kind: "WRITE",
  description:
    "Randevu taşımayı HAZIRLAR (onay gerekir). appointmentId araç sonucundan alınmalı; yeni tarih + saat.",
  schema: z.object({ appointmentId: id, date: text(60), time: text(20) }),
  run: async (tc, a: { appointmentId: string; date: string; time: string }) => {
    if (!hasPermission(tc.ctx, "appointment.reschedule")) throw new AppError("FORBIDDEN");
    const appt = await getAppointment(tc.ctx, a.appointmentId);
    const tz = appt.timezone;
    const d = resolveDateOrThrow(tc, a.date, tz);
    const time = timeOrThrow(a.time);
    const input = { appointmentId: appt.id, start: startInstant(d.date, time, tz) };
    const prior = await priorExecution(tc, "voice_reschedule_appointment", input);
    if (prior) return { ok: true, ...prior };
    const slots = await getAvailableSlots(tc.ctx, {
      branchId: appt.branch.id,
      doctorId: appt.doctor.id,
      serviceId: appt.serviceId ?? undefined,
      date: d.date,
      patientId: appt.patient.id,
      excludeAppointmentId: appt.id,
    });
    if (!slots.slots.some((s) => s.start === time)) {
      return {
        ok: false,
        error: "APPOINTMENT_CONFLICT",
        message: translateVoiceError("APPOINTMENT_CONFLICT", L(tc)),
        alternatives: slots.slots.slice(0, 6).map((s) => s.start),
      };
    }
    const old = `${formatDateLabel(appt.localDate, L(tc))}, ${appt.localStart}`;
    const summary =
      L(tc) === "en"
        ? `I will move the ${old} appointment with ${appt.doctor.name} to ${d.label}, ${time}. Do you confirm?`
        : `${appt.doctor.name} ile ${old} randevusunu ${d.label}, ${time} saatine taşıyacağım. Onaylıyor musunuz?`;
    return {
      ok: true,
      ...(await preparePendingAction(tc, "voice_reschedule_appointment", input, summary, {
        entityType: "appointment",
        entityId: appt.id,
      })),
    };
  },
};

const cancelTool: ToolDef = {
  name: "voice_cancel_appointment",
  kind: "WRITE",
  description:
    "Randevu iptalini HAZIRLAR (onay gerekir). Klinik kuralı gerektiriyorsa iptal gerekçesi sorulur.",
  schema: z.object({ appointmentId: id, reason: z.string().trim().max(300).optional() }),
  run: async (tc, a: { appointmentId: string; reason?: string }) => {
    if (!hasPermission(tc.ctx, "appointment.cancel")) throw new AppError("FORBIDDEN");
    const appt = await getAppointment(tc.ctx, a.appointmentId);
    if (tc.session.cancellationReasonRequired && !a.reason) {
      return needs(
        "reason",
        L(tc) === "en" ? "What is the reason for cancelling?" : "İptal gerekçesi nedir?",
      );
    }
    const input = { appointmentId: appt.id, reason: a.reason ?? null };
    const summary =
      L(tc) === "en"
        ? `I will cancel the ${appt.localStart} appointment on ${formatDateLabel(appt.localDate, "en")} with ${appt.doctor.name}. Do you confirm?`
        : `${formatDateLabel(appt.localDate, "tr")} ${appt.localStart} ${appt.doctor.name} randevusunu iptal edeceğim. Onaylıyor musunuz?`;
    return {
      ok: true,
      ...(await preparePendingAction(tc, "voice_cancel_appointment", input, summary, {
        entityType: "appointment",
        entityId: appt.id,
      })),
    };
  },
};

const confirmAppointmentTool: ToolDef = {
  name: "voice_confirm_appointment",
  kind: "WRITE",
  description: "Randevunun hasta tarafından onaylandığını (CONFIRMED) işaretlemeyi HAZIRLAR (onay gerekir).",
  schema: z.object({ appointmentId: id }),
  run: async (tc, a: { appointmentId: string }) => {
    if (!hasPermission(tc.ctx, "appointment.update")) throw new AppError("FORBIDDEN");
    const appt = await getAppointment(tc.ctx, a.appointmentId);
    const summary =
      L(tc) === "en"
        ? `I will mark the ${appt.localStart} appointment on ${formatDateLabel(appt.localDate, "en")} as confirmed. Do you confirm?`
        : `${formatDateLabel(appt.localDate, "tr")} ${appt.localStart} randevusunu "onaylandı" olarak işaretleyeceğim. Onaylıyor musunuz?`;
    return {
      ok: true,
      ...(await preparePendingAction(tc, "voice_confirm_appointment", { appointmentId: appt.id }, summary, {
        entityType: "appointment",
        entityId: appt.id,
      })),
    };
  },
};

const usageDraftTool: ToolDef = {
  name: "voice_create_material_usage_draft",
  kind: "WRITE",
  description:
    "Hasta malzeme kullanımını TASLAK olarak hazırlar (onay gerekir; kesinleştirme YALNIZCA ekrandan). Ürün kimlikleri voice_get_inventory sonucundan.",
  schema: z.object({
    patientId: id,
    appointmentId: optId,
    branchId: optId,
    items: z
      .array(
        z.object({
          inventoryItemId: id,
          quantity: z.coerce.number().positive().max(1000),
          locationId: optId,
        }),
      )
      .min(1)
      .max(10),
  }),
  run: async (
    tc,
    a: {
      patientId: string;
      appointmentId?: string;
      branchId?: string;
      items: { inventoryItemId: string; quantity: number; locationId?: string }[];
    },
  ) => {
    if (!hasPermission(tc.ctx, "inventory.usage.create")) throw new AppError("FORBIDDEN");
    if (!a.appointmentId && !a.branchId) {
      return needs(
        "appointmentId",
        L(tc) === "en" ? "Which appointment is this for?" : "Hangi randevu için?",
      );
    }
    const patient = await patientName(tc, a.patientId);
    const stock = await getStockByLocation(tc.ctx, {});
    const names = a.items.map((i) => {
      const s = stock.find((r) => r.itemId === i.inventoryItemId);
      if (!s) throw new AppError("NOT_FOUND");
      return `${i.quantity} ${s.itemName}`;
    });
    const input = {
      patientId: a.patientId,
      appointmentId: a.appointmentId ?? null,
      branchId: a.branchId ?? null,
      items: a.items.map((i) => ({
        inventoryItemId: i.inventoryItemId,
        quantity: String(i.quantity),
        locationId: i.locationId ?? null,
      })),
    };
    const summary =
      L(tc) === "en"
        ? `I will save a DRAFT material usage for ${patient.name}: ${names.join(", ")}. It will not be finalised. Do you confirm?`
        : `${patient.name} için ${names.join(", ")} malzeme kullanımını TASLAK olarak kaydedeceğim; kesinleştirilmeyecek. Onaylıyor musunuz?`;
    return {
      ok: true,
      ...(await preparePendingAction(tc, "voice_create_material_usage_draft", input, summary, {
        entityType: "patient_material_usage",
        entityId: null,
      })),
    };
  },
};

// ---------------------------------------------------------------- yürütücüler (onay sonrası; normal iş servisleri)

const EXECUTORS: Record<string, Executor> = {
  voice_create_appointment: async (tc, i) => {
    const r = await createAppointment(tc.ctx, {
      patientId: i.patientId,
      doctorId: i.doctorId,
      branchId: i.branchId,
      serviceId: i.serviceId,
      start: i.start,
    });
    return {
      entityType: "appointment",
      entityId: r.id,
      code: r.status === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "BOOKED",
      meta: { appointmentId: r.id, doctorId: String(i.doctorId), branchId: String(i.branchId) },
    };
  },
  voice_reschedule_appointment: async (tc, i) => {
    await rescheduleAppointment(tc.ctx, i.appointmentId, { start: i.start });
    return {
      entityType: "appointment",
      entityId: String(i.appointmentId),
      code: "RESCHEDULED",
      meta: { appointmentId: String(i.appointmentId) },
    };
  },
  voice_cancel_appointment: async (tc, i) => {
    await cancelAppointment(tc.ctx, i.appointmentId, { reason: i.reason ?? undefined });
    return {
      entityType: "appointment",
      entityId: String(i.appointmentId),
      code: "CANCELLED",
      meta: { appointmentId: String(i.appointmentId) },
    };
  },
  voice_confirm_appointment: async (tc, i) => {
    await updateAppointmentStatus(tc.ctx, i.appointmentId, { status: "CONFIRMED" });
    return {
      entityType: "appointment",
      entityId: String(i.appointmentId),
      code: "CONFIRMED",
      meta: { appointmentId: String(i.appointmentId) },
    };
  },
  voice_create_material_usage_draft: async (tc, i) => {
    const items = (i.items as { inventoryItemId: string; quantity: string; locationId: string | null }[]).map(
      (x) => ({
        inventoryItemId: x.inventoryItemId,
        quantity: x.quantity,
        locationId: x.locationId ?? undefined,
      }),
    );
    const r = await recordMaterialUsage(tc.ctx, {
      patientId: i.patientId,
      appointmentId: i.appointmentId ?? undefined,
      branchId: i.branchId ?? undefined,
      items,
      finalize: false, // yüksek risk: kesinleştirme yalnızca ekrandan
    });
    return {
      entityType: "patient_material_usage",
      entityId: r.id,
      code: "DRAFT",
      meta: { patientUsageId: r.id },
    };
  },
};

function describeResult(lang: VoiceLanguage) {
  return (tool: string, r: ExecResult): string => {
    const en = lang === "en";
    switch (tool) {
      case "voice_create_appointment":
        return r.code === "PENDING_APPROVAL"
          ? en
            ? "The appointment was created and sent for the doctor's approval."
            : "Randevu oluşturuldu ve doktor onayına gönderildi."
          : en
            ? "The appointment was created."
            : "Randevu oluşturuldu.";
      case "voice_reschedule_appointment":
        return en ? "The appointment was rescheduled." : "Randevu taşındı.";
      case "voice_cancel_appointment":
        return en ? "The appointment was cancelled." : "Randevu iptal edildi.";
      case "voice_confirm_appointment":
        return en ? "The appointment was marked as confirmed." : "Randevu onaylandı olarak işaretlendi.";
      case "voice_create_material_usage_draft":
        return en
          ? "The material usage was saved as a draft. Please review and finalise it on screen."
          : "Malzeme kullanımı taslak olarak kaydedildi. Kesinleştirme için ekrandan kontrol edebilirsiniz.";
      default:
        return en ? "Done." : "Tamamlandı.";
    }
  };
}

// ---------------------------------------------------------------- KONTROL araçları

const confirmActionTool: ToolDef = {
  name: "voice_confirm_action",
  kind: "CONTROL",
  description:
    "Kullanıcı hazırlanan işlemi AÇIKÇA onayladıktan ('evet', 'onaylıyorum', 'tamam') SONRA çağır. Belirsiz yanıtta çağırma.",
  schema: z.object({ actionId: id }),
  run: async (tc, a: { actionId: string }) => ({
    ok: true,
    ...(await confirmPendingAction(tc, a.actionId, "VOICE", EXECUTORS, describeResult(L(tc)))),
  }),
};

const cancelActionTool: ToolDef = {
  name: "voice_cancel_action",
  kind: "CONTROL",
  description: "Kullanıcı hazırlanan işlemden vazgeçerse çağır.",
  schema: z.object({ actionId: id }),
  run: async (tc, a: { actionId: string }) => ({ ok: true, ...(await cancelPendingAction(tc, a.actionId)) }),
};

export const VOICE_TOOLS: ToolDef[] = [
  resolveDate,
  listBranchesTool,
  listServicesTool,
  listDoctorsTool,
  availabilityTool,
  todayTool,
  branchSummaryTool,
  appointmentTool,
  findPatientTool,
  inventoryTool,
  lowStockTool,
  expiringTool,
  createAppointmentTool,
  rescheduleTool,
  cancelTool,
  confirmAppointmentTool,
  usageDraftTool,
  confirmActionTool,
  cancelActionTool,
];
const BY_NAME = new Map(VOICE_TOOLS.map((t) => [t.name, t]));
export const voiceToolKind = (name: string): ToolKind | null => BY_NAME.get(name)?.kind ?? null;

/** Realtime oturumuna verilen işlev tanımları (Zod → JSON Schema). tenantId / userId parametresi YOK. */
export function realtimeToolDefinitions(): RealtimeTool[] {
  return VOICE_TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
    delete schema.$schema;
    return { type: "function", name: t.name, description: t.description, parameters: schema };
  });
}

/** UI onay düğmesi (açık tıklama) — sesli onayla aynı güvenlik kuralları (aynı kullanıcı + oturum + süre). */
export function confirmActionFromUi(tc: VoiceToolContext, actionId: unknown) {
  return confirmPendingAction(tc, actionId, "UI", EXECUTORS, describeResult(L(tc)));
}

export type VoiceToolResult = Record<string, unknown> & { ok: boolean };

/**
 * Araç yürütücüsü — bilinmeyen araç → UNSUPPORTED; girdi doğrulanır; alan hataları doğal dile çevrilir (güvenlik
 * ayrıntısı verilmez); beklenmeyen hata → "doğrulayamıyorum" (veri uydurulmaz). Metrikte döküm / hasta verisi yok.
 */
export async function runVoiceTool(
  tc: VoiceToolContext,
  name: string,
  rawArgs: unknown,
): Promise<VoiceToolResult> {
  const tool = BY_NAME.get(name);
  const started = Date.now();
  if (!tool) {
    logger.info("voice.tool", { tool: "unknown", ok: false, code: "UNSUPPORTED" });
    return { ok: false, error: "UNSUPPORTED", message: translateVoiceError("UNSUPPORTED", L(tc)) };
  }
  const parsed = tool.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    logger.info("voice.tool", { tool: name, ok: false, code: "VALIDATION", latencyMs: Date.now() - started });
    return { ok: false, error: "VALIDATION", message: translateVoiceError("VALIDATION", L(tc)) };
  }
  try {
    const out = (await tool.run(tc, parsed.data as never)) as VoiceToolResult;
    logger.info("voice.tool", { tool: name, ok: out.ok !== false, latencyMs: Date.now() - started });
    return out;
  } catch (e) {
    const code = isAppError(e) ? e.code : "TOOL_FAILED";
    if (!isAppError(e)) logger.error("voice.tool_failed", { tool: name, error: e });
    logger.info("voice.tool", { tool: name, ok: false, code, latencyMs: Date.now() - started });
    return { ok: false, error: code, message: translateVoiceError(code, L(tc)) };
  }
}
