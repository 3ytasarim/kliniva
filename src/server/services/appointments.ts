import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import {
  appointmentEvents,
  appointments,
  branches,
  clinicProfiles,
  clinicalServices,
  doctorBranches,
  doctorProfiles,
  doctorServices,
  patients,
  rooms,
  users,
} from "@/server/db/schema";
import { AppError, isAppError, type AppErrorCode } from "@/server/errors";
import { writeAudit, type AuditAction, type AuditMetadata } from "@/server/audit/audit";
import {
  actorOf,
  canAccessBranch,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import type { Permission } from "@/server/auth/permissions";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { loadVisiblePatient, touchPatientBranch } from "@/server/services/patients";
import { doctorDisplayName } from "@/server/services/doctors";
import { decryptField, encryptField } from "@/server/security/crypto";
import { PG_EXCLUSION_VIOLATION, PG_FOREIGN_KEY_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { computeAvailability, type Interval, type RoomInterval } from "@/server/scheduling/availability";
import {
  ACTIVE_STATUSES,
  canTransition,
  computeRoomHoldings,
  computeSlots,
  isReschedulable,
  nextStatuses,
  type AppointmentStatus,
  type DoctorDay,
  type Slot,
} from "@/server/scheduling/slots";
import {
  appointmentNotesInput,
  cancelAppointmentInput,
  createAppointmentInput,
  getAvailableSlotsInput,
  getDoctorAvailabilityInput,
  listAppointmentsInput,
  rescheduleAppointmentInput,
  updateAppointmentStatusInput,
} from "@/server/appointments/contracts";
import {
  DEFAULT_TIMEZONE,
  addDays,
  dateInZone,
  formatMinutes,
  isoDayOfWeek,
  localDateTimeOf,
  localTimeStatus,
  parseTime,
  zonedDateTimeToUtc,
} from "@/lib/time";
import type { AvailableSlot, AvailableSlotsResult, SlotReason } from "@/types/appointments";
import { uuidSchema } from "@/server/validation";
import { enqueueOutbox, type OutboxEventType } from "@/server/notifications/outbox";

/**
 * Randevu uygulama servisleri — HTTP / server action / (ileride) Voice AI bağımsız. Her çağrı oturumdaki
 * kullanıcının yetkisi + kiracı (RLS) + şube kapsamı + doktorun kendi kapsamıyla çalışır.
 *
 * GÜVENLİK KATMANLARI
 *  1. Servis: uygunluk hesabı (okuma) → tek sorguluk son kontrol → INSERT/UPDATE; anlamlı hata kodu.
 *  2. Veritabanı: doktor / oda / hasta için tstzrange exclusion constraint (eşzamanlı istekler dahil son savunma),
 *     durum makinesi tetikleyicisi, fiziksel silme yok, geçmiş yalnızca ekleme.
 *  Audit'e hasta adı / telefonu / not / iptal gerekçesi YAZILMAZ — yalnızca kimlikler, statü ve zamanlar.
 */

const UNIT_MS = 60_000;

function parseId(raw: unknown): string {
  const id = uuidSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND");
  return id.data;
}

const notesAad = (tenantId: string, id: string) => `appointment.notes:${tenantId}:${id}`;

const CONFLICT_CODES: AppErrorCode[] = [
  "APPOINTMENT_CONFLICT",
  "ROOM_APPOINTMENT_CONFLICT",
  "PATIENT_APPOINTMENT_CONFLICT",
  "SLOT_NOT_AVAILABLE",
];

function mapDbError(e: unknown): never {
  const info = pgErrorInfo(e);
  if (info.code === PG_EXCLUSION_VIOLATION) {
    if (info.constraint === "appointments_room_no_overlap") throw new AppError("ROOM_APPOINTMENT_CONFLICT");
    if (info.constraint === "appointments_patient_no_overlap")
      throw new AppError("PATIENT_APPOINTMENT_CONFLICT");
    throw new AppError("APPOINTMENT_CONFLICT");
  }
  if (info.code === PG_FOREIGN_KEY_VIOLATION) throw new AppError("NOT_FOUND");
  const msg = String(
    ((e as { cause?: { message?: unknown } })?.cause ?? (e as { message?: unknown }))?.message ?? "",
  );
  if (/KLINIVA_(INVALID_TRANSITION|IMMUTABLE)/.test(msg)) throw new AppError("INVALID_STATUS_TRANSITION");
  throw e;
}

// ---------------------------------------------------------------- yapılandırma + kapsam

type BookingConfig = {
  timezone: string;
  minNotice: number;
  maxDaysAhead: number;
  cancellationReasonRequired: boolean;
  step: number;
  approvalMode: "AUTO_ACCEPT" | "DOCTOR_APPROVAL";
};

async function bookingConfig(scope: TenantScope): Promise<BookingConfig> {
  const [p] = await scope.tx
    .select({
      tz: clinicProfiles.timezone,
      minNotice: clinicProfiles.minBookingNoticeMinutes,
      maxDays: clinicProfiles.maxBookingDaysAhead,
      cancelReq: clinicProfiles.cancellationReasonRequired,
      step: clinicProfiles.slotIntervalMinutes,
      approvalMode: clinicProfiles.appointmentApprovalMode,
    })
    .from(clinicProfiles)
    .where(tenantWhere(clinicProfiles, scope));
  return {
    timezone: p?.tz ?? DEFAULT_TIMEZONE,
    minNotice: p?.minNotice ?? 0,
    maxDaysAhead: p?.maxDays ?? 365,
    cancellationReasonRequired: p?.cancelReq ?? true,
    step: p?.step ?? 15,
    approvalMode: p?.approvalMode ?? "AUTO_ACCEPT",
  };
}

export async function selfDoctorId(scope: TenantScope, ctx: AuthContext): Promise<string | null> {
  const [row] = await scope.tx
    .select({ id: doctorProfiles.id })
    .from(doctorProfiles)
    .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.userId, ctx.userId)));
  return row?.id ?? null;
}

/**
 * Görünürlük koşulu: appointment.read → şube kapsamı; appointment.read.own → yalnızca kendi doktor kaydı.
 * İkisi de yoksa FORBIDDEN. Kapsam dışı kayıtlar sorguda hiç görünmez (ID ile istense de NOT_FOUND).
 */
async function visibility(scope: TenantScope, ctx: AuthContext): Promise<SQL | undefined> {
  const conds: SQL[] = [];
  let unrestricted = false;
  if (hasPermission(ctx, "appointment.read")) {
    if (ctx.branchScope.all) unrestricted = true;
    else {
      const ids = [...ctx.branchScope.branchIds];
      conds.push(ids.length ? inArray(appointments.branchId, ids) : sql`false`);
    }
  }
  if (hasPermission(ctx, "appointment.read.own")) {
    const self = await selfDoctorId(scope, ctx);
    if (self) conds.push(eq(appointments.doctorId, self));
  }
  if (unrestricted) return undefined;
  if (!hasPermission(ctx, "appointment.read") && !hasPermission(ctx, "appointment.read.own")) {
    throw new AppError("FORBIDDEN");
  }
  return conds.length ? or(...conds) : sql`false`;
}

export async function loadAccessibleAppointment(
  scope: TenantScope,
  ctx: AuthContext,
  rawId: unknown,
  opts: { forUpdate?: boolean } = {},
) {
  const id = parseId(rawId);
  const q = scope.tx
    .select()
    .from(appointments)
    .where(tenantWhere(appointments, scope, eq(appointments.id, id), await visibility(scope, ctx)));
  const [row] = opts.forUpdate ? await q.for("update") : await q;
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

/**
 * Bildirim merkezi için: verilen randevulardan kullanıcının HÂLÂ görebildikleri (aynı görünürlük kuralı) + hasta adı
 * ve yerel saat. Görünmeyen randevu sonuçta yer almaz → UI "Görüntüle" bağlantısı göstermez. Tek sorgu (N+1 yok).
 */
export async function visibleAppointmentSummaries(
  scope: TenantScope,
  ctx: AuthContext,
  ids: string[],
): Promise<Map<string, { patientName: string; localStart: string; localDate: string }>> {
  const out = new Map<string, { patientName: string; localStart: string; localDate: string }>();
  if (!ids.length) return out;
  if (!hasPermission(ctx, "appointment.read") && !hasPermission(ctx, "appointment.read.own")) return out;
  const rows = await scope.tx
    .select({
      id: appointments.id,
      start: appointments.scheduledStart,
      timezone: appointments.timezone,
      first: patients.firstName,
      last: patients.lastName,
    })
    .from(appointments)
    .innerJoin(
      patients,
      and(eq(patients.id, appointments.patientId), eq(patients.tenantId, appointments.tenantId)),
    )
    .where(tenantWhere(appointments, scope, inArray(appointments.id, ids), await visibility(scope, ctx)));
  for (const r of rows) {
    const local = localDateTimeOf(r.start, r.timezone);
    out.set(r.id, {
      patientName: `${r.first} ${r.last}`,
      localStart: formatMinutes(local.minutes),
      localDate: local.date,
    });
  }
  return out;
}

const eventSource = (ctx: AuthContext): "STAFF" | "DOCTOR" | "AI_VOICE" =>
  ctx.channel === "AI_VOICE" ? "AI_VOICE" : hasPermission(ctx, "appointment.read") ? "STAFF" : "DOCTOR";

async function addEvent(
  scope: TenantScope,
  ctx: AuthContext,
  appointmentId: string,
  type: (typeof appointmentEvents.$inferInsert)["type"],
  from: AppointmentStatus | null,
  to: AppointmentStatus | null,
  metadata: Record<string, string | number | boolean | null> = {},
) {
  await scope.tx.insert(appointmentEvents).values({
    tenantId: scope.tenantId,
    appointmentId,
    type,
    fromStatus: from,
    toStatus: to,
    actorUserId: ctx.userId,
    source: eventSource(ctx),
    metadataSafe: metadata,
  });
}

function apptMeta(a: {
  id: string;
  branchId: string;
  doctorId: string;
  serviceId: string | null;
  status: string;
}): AuditMetadata {
  return {
    appointmentId: a.id,
    branchId: a.branchId,
    doctorId: a.doctorId,
    serviceId: a.serviceId,
    status: a.status,
  };
}

async function audit(
  scope: TenantScope,
  ctx: AuthContext,
  action: AuditAction,
  a: Parameters<typeof apptMeta>[0],
  extra: AuditMetadata = {},
) {
  await writeAudit(scope, actorOf(ctx), {
    action,
    entityType: "appointment",
    entityId: a.id,
    branchId: a.branchId,
    metadata: { ...apptMeta(a), ...extra },
  });
}

/**
 * Randevu olayını AYNI transaction içinde outbox'a yazar (iş geri alınırsa olay da yok). Yük: yalnızca kimlikler +
 * zaman; hasta adı / telefon / not YOK — tüketici gerekli bilgiyi kendisi çözer.
 */
async function appointmentOutbox(
  scope: TenantScope,
  ctx: AuthContext,
  eventType: OutboxEventType,
  a: { id: string; doctorId: string; branchId: string },
  extra: Record<string, string | null> = {},
) {
  await enqueueOutbox(scope, {
    eventType,
    aggregateType: "appointment",
    aggregateId: a.id,
    payload: {
      appointmentId: a.id,
      doctorId: a.doctorId,
      branchId: a.branchId,
      actorUserId: ctx.userId,
      ...extra,
    },
  });
}

/** Çakışma reddi ayrı transaction'da audit'lenir (ana işlem geri alındığı için). */
async function withConflictAudit<T>(
  ctx: AuthContext,
  ids: { branchId: string; doctorId: string },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isAppError(e) && CONFLICT_CODES.includes(e.code)) {
      await tenantQuery(ctx, (scope) =>
        writeAudit(scope, actorOf(ctx), {
          action: "APPOINTMENT_CONFLICT",
          entityType: "appointment",
          entityId: null,
          branchId: ids.branchId,
          metadata: { branchId: ids.branchId, doctorId: ids.doctorId, code: e.code },
        }),
      ).catch(() => undefined);
    }
    throw e;
  }
}

// ---------------------------------------------------------------- günlük bağlam (sabit sayıda sorgu, N+1 yok)

type Clip = { allDay: true } | ({ allDay: false } & Interval);
type ApptBusy = {
  id: string;
  doctorId: string;
  roomId: string | null;
  patientId: string;
  start: Date;
  end: Date;
};

type DayContext = {
  date: string;
  timezone: string;
  dayStart: Date;
  dayEnd: Date;
  branchActive: boolean;
  branchHours: Interval[] | null;
  closures: Clip[];
  doctors: Map<string, DoctorDay>;
  rooms: { id: string; name: string; type: string }[];
  appts: ApptBusy[];
};

const tInterval = (r: { startTime: string; endTime: string }): Interval => ({
  start: parseTime(r.startTime)!,
  end: parseTime(r.endTime)!,
});

/**
 * Bir şube-günü için gereken her şey — SABİT 2 sorgu (şube + birleşik JSON sorgusu), doktor/oda sayısından
 * bağımsız (N+1 yok). Sorgular RLS altında; her alt sorguda kiracı filtresi ayrıca açıkça yazılıdır.
 * Randevular: o güne taşan aktif randevular (şubenin tümü + odak doktorun / hastanın başka şubelerdeki randevuları).
 */
async function loadDayContext(
  scope: TenantScope,
  branchId: string,
  date: string,
  focus: { doctorId?: string; patientId?: string; excludeId?: string },
): Promise<DayContext> {
  const [branch] = await scope.tx
    .select({
      active: branches.active,
      timezone: branches.timezone,
      hoursEnabled: branches.workingHoursEnabled,
    })
    .from(branches)
    .where(tenantWhere(branches, scope, eq(branches.id, branchId)));
  if (!branch) throw new AppError("NOT_FOUND");
  const tz = branch.timezone;
  const day = isoDayOfWeek(date);
  const dayStart = zonedDateTimeToUtc(date, 0, tz);
  const dayEnd = zonedDateTimeToUtc(addDays(date, 1), 0, tz);
  const t = scope.tenantId;
  const statuses = sql.join(
    ACTIVE_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  type Row = {
    hours: { enabled: boolean; s: string | null; e: string | null }[] | null;
    closures: { allDay: boolean; s: string | null; e: string | null }[] | null;
    working: { doctorId: string; s: string; e: string }[] | null;
    assignments:
      | {
          doctorId: string;
          roomId: string;
          roomName: string;
          dow: number | null;
          date: string | null;
          s: string;
          e: string;
        }[]
      | null;
    exceptions: { doctorId: string; allDay: boolean; s: string | null; e: string | null }[] | null;
    rooms: { id: string; name: string; type: string }[] | null;
    appts:
      | {
          id: string;
          doctorId: string;
          roomId: string | null;
          patientId: string;
          start: string;
          end: string;
        }[]
      | null;
  };
  const res = await scope.tx.execute<Row>(sql`
    select
      (select json_agg(json_build_object('enabled', h.enabled, 's', h.start_time, 'e', h.end_time))
         from kliniva.branch_working_hours h
        where h.tenant_id = ${t} and h.branch_id = ${branchId} and h.day_of_week = ${day}) as hours,
      (select json_agg(json_build_object('allDay', c.all_day, 's', c.start_time, 'e', c.end_time))
         from kliniva.branch_closures c
        where c.tenant_id = ${t} and c.branch_id = ${branchId} and c.date = ${date}::date) as closures,
      (select json_agg(json_build_object('doctorId', w.doctor_id, 's', w.start_time, 'e', w.end_time))
         from kliniva.doctor_working_hours w
         join kliniva.doctor_branches db
           on db.tenant_id = w.tenant_id and db.doctor_id = w.doctor_id and db.branch_id = w.branch_id
         join kliniva.doctor_profiles dp on dp.tenant_id = w.tenant_id and dp.id = w.doctor_id
        where w.tenant_id = ${t} and w.branch_id = ${branchId} and w.day_of_week = ${day}
          and w.active and db.active and dp.active) as working,
      (select json_agg(json_build_object('doctorId', a.doctor_id, 'roomId', a.room_id, 'roomName', r.name,
                                         'dow', a.day_of_week, 'date', a.effective_date,
                                         's', a.start_time, 'e', a.end_time))
         from kliniva.doctor_room_assignments a
         join kliniva.rooms r on r.tenant_id = a.tenant_id and r.id = a.room_id
        where a.tenant_id = ${t} and a.branch_id = ${branchId} and a.active and r.active
          and (a.day_of_week = ${day} or a.effective_date = ${date}::date)) as assignments,
      (select json_agg(json_build_object('doctorId', x.doctor_id, 'allDay', x.type = 'ALL_DAY',
                                         's', x.start_time, 'e', x.end_time))
         from kliniva.doctor_schedule_exceptions x
        where x.tenant_id = ${t} and x.date = ${date}::date
          and (x.branch_id is null or x.branch_id = ${branchId})) as exceptions,
      (select json_agg(json_build_object('id', r.id, 'name', r.name, 'type', r.type) order by r.name)
         from kliniva.rooms r
        where r.tenant_id = ${t} and r.branch_id = ${branchId} and r.active) as rooms,
      (select json_agg(json_build_object('id', ap.id, 'doctorId', ap.doctor_id, 'roomId', ap.room_id,
                                         'patientId', ap.patient_id, 'start', ap.scheduled_start,
                                         'end', ap.scheduled_end))
         from kliniva.appointments ap
        where ap.tenant_id = ${t} and ap.status in (${statuses})
          and ap.scheduled_start < ${dayEnd.toISOString()}::timestamptz
          and ap.scheduled_end > ${dayStart.toISOString()}::timestamptz
          and (ap.branch_id = ${branchId}
               or ap.doctor_id = ${focus.doctorId ?? null}::uuid
               or ap.patient_id = ${focus.patientId ?? null}::uuid)
          and (${focus.excludeId ?? null}::uuid is null or ap.id <> ${focus.excludeId ?? null}::uuid)) as appts
  `);
  const row = res.rows[0]!;

  let branchHours: Interval[] | null = null;
  if (branch.hoursEnabled) {
    const h = row.hours?.[0];
    branchHours = h && h.enabled && h.s && h.e ? [tInterval({ startTime: h.s, endTime: h.e })] : [];
  }
  const closures: Clip[] = (row.closures ?? []).map((c) =>
    c.allDay ? { allDay: true } : { allDay: false, ...tInterval({ startTime: c.s!, endTime: c.e! }) },
  );

  const doctors = new Map<string, DoctorDay>();
  const ensure = (doctorId: string) => {
    let d = doctors.get(doctorId);
    if (!d) {
      d = { doctorId, working: [], branchHours, exceptions: [], closures, weeklyRooms: [], datedRooms: [] };
      doctors.set(doctorId, d);
    }
    return d;
  };
  for (const w of row.working ?? [])
    ensure(w.doctorId).working.push(tInterval({ startTime: w.s, endTime: w.e }));
  for (const e of row.exceptions ?? []) {
    if (!doctors.has(e.doctorId)) continue;
    ensure(e.doctorId).exceptions.push(
      e.allDay ? { allDay: true } : { allDay: false, ...tInterval({ startTime: e.s!, endTime: e.e! }) },
    );
  }
  for (const a of row.assignments ?? []) {
    if (!doctors.has(a.doctorId)) continue;
    const r: RoomInterval = {
      ...tInterval({ startTime: a.s, endTime: a.e }),
      roomId: a.roomId,
      roomName: a.roomName,
    };
    if (a.date === date) ensure(a.doctorId).datedRooms.push(r);
    else if (a.dow === day) ensure(a.doctorId).weeklyRooms.push(r);
  }

  return {
    date,
    timezone: tz,
    dayStart,
    dayEnd,
    branchActive: branch.active,
    branchHours,
    closures,
    doctors,
    rooms: row.rooms ?? [],
    appts: (row.appts ?? []).map((a) => ({ ...a, start: new Date(a.start), end: new Date(a.end) })),
  };
}

/** Anı o günün yerel dakikasına çevirir (gün dışı → 0 / 1440). */
function toLocalMinute(dc: DayContext, instant: Date): number {
  if (instant <= dc.dayStart) return 0;
  if (instant >= dc.dayEnd) return 1440;
  return localDateTimeOf(instant, dc.timezone).minutes;
}

type ServiceSpec = {
  serviceId: string | null;
  duration: number;
  requiresRoom: boolean;
  allowedRoomTypes: string[] | null;
  offered: boolean;
};

async function resolveServiceSpec(
  scope: TenantScope,
  doctorId: string,
  serviceId: string | undefined,
  durationOverride: number | undefined,
): Promise<ServiceSpec> {
  const [doc] = await scope.tx
    .select({ duration: doctorProfiles.defaultAppointmentDurationMinutes })
    .from(doctorProfiles)
    .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.id, doctorId)));
  if (!doc) throw new AppError("NOT_FOUND");
  if (!serviceId) {
    return {
      serviceId: null,
      duration: durationOverride ?? doc.duration,
      requiresRoom: false,
      allowedRoomTypes: null,
      offered: true,
    };
  }
  const [svc] = await scope.tx
    .select({
      id: clinicalServices.id,
      duration: clinicalServices.defaultDurationMinutes,
      requiresRoom: clinicalServices.requiresRoom,
      types: clinicalServices.allowedRoomTypes,
      active: clinicalServices.active,
      override: doctorServices.durationMinutesOverride,
      offered: doctorServices.active,
    })
    .from(clinicalServices)
    .leftJoin(
      doctorServices,
      and(
        eq(doctorServices.tenantId, clinicalServices.tenantId),
        eq(doctorServices.serviceId, clinicalServices.id),
        eq(doctorServices.doctorId, doctorId),
      ),
    )
    .where(tenantWhere(clinicalServices, scope, eq(clinicalServices.id, serviceId)));
  if (!svc || !svc.active) throw new AppError("NOT_FOUND");
  return {
    serviceId: svc.id,
    duration: durationOverride ?? svc.override ?? svc.duration,
    requiresRoom: svc.requiresRoom,
    allowedRoomTypes: svc.types?.length ? svc.types : null,
    offered: svc.offered === true,
  };
}

type Computed = { reason: SlotReason; slots: Slot[]; local: AvailableSlot[] };

/**
 * Bağlamdan slot hesabı. earliestUtc: bu andan önce başlayan slot yok (şimdi + asgari süre).
 */
function computeInContext(
  dc: DayContext,
  doctorId: string,
  patientId: string | null,
  spec: ServiceSpec,
  step: number,
  earliestUtc: Date,
): Computed {
  const empty = (reason: SlotReason): Computed => ({ reason, slots: [], local: [] });
  if (!spec.offered) return empty("SERVICE_NOT_OFFERED");
  if (!dc.branchActive) return empty("INACTIVE");
  const me = dc.doctors.get(doctorId);
  if (!me || !me.working.length) return empty("NOT_WORKING");

  const segments = computeAvailability(me);
  if (!segments.length) {
    if (dc.closures.some((c) => c.allDay) || dc.branchHours?.length === 0) return empty("BRANCH_CLOSED");
    if (me.exceptions.length) return empty("DOCTOR_EXCEPTION");
    return empty(dc.closures.length ? "BRANCH_CLOSED" : "NOT_WORKING");
  }

  const span = (a: { start: Date; end: Date }): Interval => ({
    start: toLocalMinute(dc, a.start),
    end: toLocalMinute(dc, a.end),
  });
  const others = [...dc.doctors.values()].filter((d) => d.doctorId !== doctorId);
  const holdings = computeRoomHoldings(others);
  const allowed = spec.allowedRoomTypes;
  const roomCandidates = dc.rooms
    .filter((r) => !allowed || allowed.includes(r.type))
    .map((r) => ({
      roomId: r.id,
      roomName: r.name,
      busy: [
        ...dc.appts.filter((a) => a.roomId === r.id).map(span),
        ...holdings.filter((h) => h.roomId === r.id),
      ],
    }));

  let earliestStart = 0;
  if (earliestUtc >= dc.dayEnd) return empty("OUT_OF_RANGE");
  if (earliestUtc > dc.dayStart)
    earliestStart = toLocalMinute(dc, new Date(Math.ceil(earliestUtc.getTime() / UNIT_MS) * UNIT_MS));

  const base = {
    windows: segments,
    ownRooms: segments
      .filter((s) => s.roomId)
      .map((s) => ({ start: s.start, end: s.end, roomId: s.roomId! })),
    doctorBusy: dc.appts.filter((a) => a.doctorId === doctorId).map(span),
    patientBusy: patientId ? dc.appts.filter((a) => a.patientId === patientId).map(span) : [],
    duration: spec.duration,
    step,
    earliestStart,
    rooms: roomCandidates,
  };
  const slots = computeSlots({ ...base, requiresRoom: spec.requiresRoom });

  const local: AvailableSlot[] = [];
  const kept: Slot[] = [];
  for (const s of slots) {
    // Yaz saati geçişi: var olmayan / çift anlamlı yerel saatlerde slot üretilmez; gerçek süre tutmalı.
    if (localTimeStatus(dc.date, s.start, dc.timezone) !== "OK") continue;
    if (s.end < 1440 && localTimeStatus(dc.date, s.end, dc.timezone) !== "OK") continue;
    const startUtc = zonedDateTimeToUtc(dc.date, s.start, dc.timezone);
    const endUtc = s.end >= 1440 ? dc.dayEnd : zonedDateTimeToUtc(dc.date, s.end, dc.timezone);
    if (endUtc.getTime() - startUtc.getTime() !== spec.duration * UNIT_MS) continue;
    if (startUtc < earliestUtc) continue;
    kept.push(s);
    local.push({
      start: formatMinutes(s.start),
      end: formatMinutes(s.end),
      startUtc: startUtc.toISOString(),
      endUtc: endUtc.toISOString(),
      rooms: s.rooms,
    });
  }
  if (local.length) return { reason: "OK", slots: kept, local };
  if (spec.requiresRoom && computeSlots({ ...base, requiresRoom: false }).length) return empty("NO_ROOM");
  return empty("FULLY_BOOKED");
}

function bookingWindow(cfg: BookingConfig, now = new Date()) {
  return {
    earliest: new Date(now.getTime() + cfg.minNotice * UNIT_MS),
    latest: new Date(now.getTime() + cfg.maxDaysAhead * 24 * 3600_000),
  };
}

async function assertDoctorInBranch(scope: TenantScope, doctorId: string, branchId: string) {
  const [link] = await scope.tx
    .select({ id: doctorBranches.id })
    .from(doctorBranches)
    .where(
      tenantWhere(
        doctorBranches,
        scope,
        eq(doctorBranches.doctorId, doctorId),
        eq(doctorBranches.branchId, branchId),
      ),
    );
  if (!link) throw new AppError("NOT_FOUND");
}

/** Doktor (yalnızca kendi kapsamı) başka doktorun uygunluğunu / randevusunu göremez. */
async function assertDoctorVisible(scope: TenantScope, ctx: AuthContext, doctorId: string) {
  if (hasPermission(ctx, "appointment.read")) return;
  if ((await selfDoctorId(scope, ctx)) !== doctorId) throw new AppError("NOT_FOUND");
}

// ---------------------------------------------------------------- uygunluk

/**
 * Bir gün için uygun slotlar — UI'ın TEK yetkili müsaitlik kaynağı (istemci kendi hesaplamaz).
 * DoctorWorkingHours ∩ BranchWorkingHours − izinler − kapanışlar − mevcut randevular ∩ uygun oda.
 */
export async function getAvailableSlots(ctx: AuthContext, input: unknown): Promise<AvailableSlotsResult> {
  requirePermission(ctx, "appointment.availability.read");
  const data = parseInput(getAvailableSlotsInput, input);
  if (!canAccessBranch(ctx, data.branchId)) throw new AppError("NOT_FOUND");
  return tenantQuery(ctx, async (scope) => {
    await assertDoctorVisible(scope, ctx, data.doctorId);
    await assertDoctorInBranch(scope, data.doctorId, data.branchId);
    if (data.patientId) await loadVisiblePatient(scope, ctx, data.patientId);
    let excludeId: string | undefined;
    if (data.excludeAppointmentId) {
      const own = await loadAccessibleAppointment(scope, ctx, data.excludeAppointmentId);
      if (own.doctorId !== data.doctorId || own.branchId !== data.branchId) throw new AppError("NOT_FOUND");
      excludeId = own.id;
    }
    const cfg = await bookingConfig(scope);
    const spec = await resolveServiceSpec(scope, data.doctorId, data.serviceId, data.durationMinutes);
    const dc = await loadDayContext(scope, data.branchId, data.date, {
      doctorId: data.doctorId,
      patientId: data.patientId,
      excludeId,
    });
    const { earliest, latest } = bookingWindow(cfg);
    const outOfRange = dc.dayStart > latest;
    const r = outOfRange
      ? ({ reason: "OUT_OF_RANGE", local: [] } as const)
      : computeInContext(dc, data.doctorId, data.patientId ?? null, spec, cfg.step, earliest);
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_AVAILABILITY_VIEWED",
      entityType: "doctor_profile",
      entityId: data.doctorId,
      branchId: data.branchId,
      metadata: {
        doctorId: data.doctorId,
        branchId: data.branchId,
        serviceId: spec.serviceId,
        date: data.date,
      },
    });
    return {
      date: data.date,
      timezone: dc.timezone,
      branchId: data.branchId,
      doctorId: data.doctorId,
      serviceId: spec.serviceId,
      durationMinutes: spec.duration,
      requiresRoom: spec.requiresRoom,
      reason: r.reason,
      slots: [...r.local],
    };
  });
}

/** Birkaç günlük özet (tarih seçici için): gün başına uygun slot sayısı ve ilk slot. */
export async function getDoctorAvailability(ctx: AuthContext, input: unknown) {
  requirePermission(ctx, "appointment.availability.read");
  const data = parseInput(getDoctorAvailabilityInput, input);
  if (!canAccessBranch(ctx, data.branchId)) throw new AppError("NOT_FOUND");
  return tenantQuery(ctx, async (scope) => {
    await assertDoctorVisible(scope, ctx, data.doctorId);
    await assertDoctorInBranch(scope, data.doctorId, data.branchId);
    const cfg = await bookingConfig(scope);
    const spec = await resolveServiceSpec(scope, data.doctorId, data.serviceId, undefined);
    const { earliest, latest } = bookingWindow(cfg);
    const days: { date: string; reason: SlotReason; slotCount: number; firstSlot: string | null }[] = [];
    for (let i = 0; i < data.days; i++) {
      const date = addDays(data.fromDate, i);
      const dc = await loadDayContext(scope, data.branchId, date, { doctorId: data.doctorId });
      const r =
        dc.dayStart > latest
          ? { reason: "OUT_OF_RANGE" as const, local: [] }
          : computeInContext(dc, data.doctorId, null, spec, cfg.step, earliest);
      days.push({ date, reason: r.reason, slotCount: r.local.length, firstSlot: r.local[0]?.start ?? null });
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_AVAILABILITY_VIEWED",
      entityType: "doctor_profile",
      entityId: data.doctorId,
      branchId: data.branchId,
      metadata: {
        doctorId: data.doctorId,
        branchId: data.branchId,
        fromDate: data.fromDate,
        days: data.days,
      },
    });
    return { doctorId: data.doctorId, branchId: data.branchId, durationMinutes: spec.duration, days };
  });
}

// ---------------------------------------------------------------- oluşturma / taşıma

type Placement = { start: Date; end: Date; roomId: string | null; spec: ServiceSpec; timezone: string };

/**
 * Çağıran kilitleri almış olmalı. Önce açık çakışmalar (anlamlı kod), sonra slotun sunucu hesabında
 * gerçekten var olduğu doğrulanır. Son savunma: exclusion constraint.
 */
async function placeAppointment(
  scope: TenantScope,
  args: {
    branchId: string;
    doctorId: string;
    patientId: string;
    serviceId?: string;
    durationMinutes?: number;
    start: Date;
    roomId?: string;
    excludeId?: string;
  },
): Promise<Placement> {
  // Hızlı ret: istenen başlangıç anı zaten dolu mu (tek sorgu, süreden bağımsız)? Yarışı kaybeden eşzamanlı istekler
  // yapılandırma / hizmet / gün hesabına girmeden döner → bağlantı havuzu yük altında tükenmez.
  await assertStillFree(scope, {
    doctorId: args.doctorId,
    patientId: args.patientId,
    roomId: args.roomId ?? null,
    start: args.start,
    end: new Date(args.start.getTime() + UNIT_MS),
    excludeId: args.excludeId,
  });
  const cfg = await bookingConfig(scope);
  const now = new Date();
  if (args.start.getTime() < now.getTime()) throw new AppError("APPOINTMENT_IN_PAST");
  const { earliest, latest } = bookingWindow(cfg, now);
  if (args.start < earliest || args.start > latest) throw new AppError("BOOKING_OUT_OF_RANGE");

  const spec = await resolveServiceSpec(scope, args.doctorId, args.serviceId, args.durationMinutes);
  if (!spec.offered) {
    throw new AppError("VALIDATION", { fields: ["serviceId"], message: "Doktor bu hizmeti vermiyor." });
  }
  const end = new Date(args.start.getTime() + spec.duration * UNIT_MS);
  // Açık çakışmalar önce (tek sorgu, UTC): kazanan commit ettikten sonra yarışı kaybedenler ağır gün hesabına
  // girmeden hızla reddedilir.
  await assertStillFree(scope, {
    doctorId: args.doctorId,
    patientId: args.patientId,
    roomId: args.roomId ?? null,
    start: args.start,
    end,
    excludeId: args.excludeId,
  });

  const [tzRow] = await scope.tx
    .select({ tz: branches.timezone })
    .from(branches)
    .where(tenantWhere(branches, scope, eq(branches.id, args.branchId)));
  if (!tzRow) throw new AppError("NOT_FOUND");
  const date = dateInZone(args.start, tzRow.tz);
  const dc = await loadDayContext(scope, args.branchId, date, {
    doctorId: args.doctorId,
    patientId: args.patientId,
    excludeId: args.excludeId,
  });

  const computed = computeInContext(dc, args.doctorId, args.patientId, spec, cfg.step, earliest);
  const iso = args.start.toISOString();
  const idx = computed.local.findIndex((s) => s.startUtc === iso);
  if (idx < 0) {
    // Ön kontrol ile gün bağlamı arasında başka bir istek commit ettiyse: doğru çakışma kodu.
    const iv = { start: args.start.getTime(), end: end.getTime() };
    const clash = (x: ApptBusy) => x.start.getTime() < iv.end && x.end.getTime() > iv.start;
    if (dc.appts.some((x) => x.patientId === args.patientId && clash(x)))
      throw new AppError("PATIENT_APPOINTMENT_CONFLICT");
    if (dc.appts.some((x) => x.doctorId === args.doctorId && clash(x)))
      throw new AppError("APPOINTMENT_CONFLICT");
    if (spec.requiresRoom) {
      const noRoom = computeInContext(
        dc,
        args.doctorId,
        args.patientId,
        { ...spec, requiresRoom: false },
        cfg.step,
        earliest,
      );
      if (noRoom.local.some((s) => s.startUtc === iso)) throw new AppError("ROOM_APPOINTMENT_CONFLICT");
    }
    throw new AppError("SLOT_NOT_AVAILABLE");
  }
  const slot = computed.local[idx]!;
  let roomId: string | null = null;
  if (args.roomId) {
    if (!slot.rooms.some((r) => r.roomId === args.roomId)) throw new AppError("ROOM_APPOINTMENT_CONFLICT");
    roomId = args.roomId;
  } else {
    roomId = slot.rooms[0]?.roomId ?? null;
    if (spec.requiresRoom && !roomId) throw new AppError("ROOM_APPOINTMENT_CONFLICT");
  }
  return { start: args.start, end, roomId, spec, timezone: dc.timezone };
}

/**
 * Kilit altındaki son kontrol — TEK sorgu: yeni aralıkla örtüşen aktif randevu (aynı doktor / hasta / oda).
 * Ağır uygunluk hesabı kilitten ÖNCE ayrı bir okuma transaction'ında yapılır; kilitli bölüm kısa tutulur
 * (eşzamanlı yoğun istekte bağlantı havuzu tükenmez). Son savunma yine exclusion constraint'tir.
 */
async function assertStillFree(
  scope: TenantScope,
  a: {
    doctorId: string;
    patientId: string;
    roomId: string | null;
    start: Date;
    end: Date;
    excludeId?: string;
  },
) {
  const hits = await scope.tx
    .select({
      doctorId: appointments.doctorId,
      patientId: appointments.patientId,
      roomId: appointments.roomId,
    })
    .from(appointments)
    .where(
      tenantWhere(
        appointments,
        scope,
        inArray(appointments.status, ACTIVE_STATUSES),
        lt(appointments.scheduledStart, a.end),
        gt(appointments.scheduledEnd, a.start),
        or(
          eq(appointments.doctorId, a.doctorId),
          eq(appointments.patientId, a.patientId),
          a.roomId ? eq(appointments.roomId, a.roomId) : undefined,
        ),
        a.excludeId ? ne(appointments.id, a.excludeId) : undefined,
      ),
    );
  if (hits.some((h) => h.patientId === a.patientId)) throw new AppError("PATIENT_APPOINTMENT_CONFLICT");
  if (hits.some((h) => h.doctorId === a.doctorId)) throw new AppError("APPOINTMENT_CONFLICT");
  if (a.roomId && hits.some((h) => h.roomId === a.roomId)) throw new AppError("ROOM_APPOINTMENT_CONFLICT");
}

export async function createAppointment(
  ctx: AuthContext,
  input: unknown,
): Promise<{ id: string; status: AppointmentStatus }> {
  requirePermission(ctx, "appointment.create");
  const data = parseInput(createAppointmentInput, input);
  if (!canAccessBranch(ctx, data.branchId)) throw new AppError("NOT_FOUND");
  return withConflictAudit(ctx, data, async () => {
    // 1) Okuma: kapsam + hasta görünürlüğü + slotun sunucu hesabında var olduğu (anlamlı hata kodları).
    const { patientId, p } = await tenantQuery(ctx, async (scope) => {
      await assertDoctorInBranch(scope, data.doctorId, data.branchId);
      const patient = await loadVisiblePatient(scope, ctx, data.patientId);
      const placed = await placeAppointment(scope, {
        branchId: data.branchId,
        doctorId: data.doctorId,
        patientId: patient.id,
        serviceId: data.serviceId,
        durationMinutes: data.durationMinutes,
        start: new Date(data.start),
        roomId: data.roomId,
      });
      return { patientId: patient.id, p: placed };
    });
    // 2) Yazma: tek sorguluk son kontrol (kesinleşmiş çakışmalar → anlamlı kod) + INSERT. Eşzamanlı yarışı
    //    exclusion constraint'lar veritabanında çözer (bekleyen istemci gidiş-dönüşü olmadan); 23P01 → çakışma kodu.
    return tenantQuery(ctx, async (scope) => {
      await assertStillFree(scope, {
        doctorId: data.doctorId,
        patientId,
        roomId: p.roomId,
        start: p.start,
        end: p.end,
      });
      const id = randomUUID();
      // Onay modu: DOCTOR_APPROVAL → PENDING_APPROVAL (slot TUTAR). Doktorun kendi oluşturduğu randevu onay beklemez.
      const cfg = await bookingConfig(scope);
      const self = cfg.approvalMode === "DOCTOR_APPROVAL" ? await selfDoctorId(scope, ctx) : null;
      const status: AppointmentStatus =
        cfg.approvalMode === "DOCTOR_APPROVAL" && self !== data.doctorId ? "PENDING_APPROVAL" : "BOOKED";
      await scope.tx
        .insert(appointments)
        .values({
          id,
          tenantId: scope.tenantId,
          branchId: data.branchId,
          patientId,
          doctorId: data.doctorId,
          roomId: p.roomId,
          serviceId: p.spec.serviceId,
          status,
          scheduledStart: p.start,
          scheduledEnd: p.end,
          timezone: p.timezone,
          durationMinutes: p.spec.duration,
          // Sesli asistan kanalı sunucu bağlamından (istemci girdisinden değil).
          source: ctx.channel === "AI_VOICE" ? "AI_VOICE" : data.source,
          notesEncrypted: data.notes ? encryptField(data.notes, notesAad(scope.tenantId, id)) : null,
          createdByUserId: ctx.userId,
        })
        .catch(mapDbError);
      await touchPatientBranch(scope, patientId, data.branchId);
      await addEvent(scope, ctx, id, "CREATED", null, status, {
        start: p.start.toISOString(),
        end: p.end.toISOString(),
        roomId: p.roomId,
      });
      await audit(
        scope,
        ctx,
        "APPOINTMENT_CREATED",
        {
          id,
          branchId: data.branchId,
          doctorId: data.doctorId,
          serviceId: p.spec.serviceId,
          status,
        },
        { roomId: p.roomId, start: p.start.toISOString(), hasNotes: Boolean(data.notes) },
      );
      await appointmentOutbox(
        scope,
        ctx,
        status === "PENDING_APPROVAL" ? "APPOINTMENT_APPROVAL_REQUESTED" : "APPOINTMENT_CREATED",
        { id, doctorId: data.doctorId, branchId: data.branchId },
      );
      return { id, status };
    });
  });
}

/**
 * Taşıma — yeni slot önce doğrulanır; yazma tek transaction'da (kilit + son kontrol + UPDATE). Eski slot yalnızca
 * yeni yer başarıyla alınırsa boşalır (UPDATE atomik; çakışmada hiçbir şey değişmez).
 */
export async function rescheduleAppointment(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "appointment.reschedule");
  const data = parseInput(rescheduleAppointmentInput, input);
  const pre = await tenantQuery(ctx, (scope) => loadAccessibleAppointment(scope, ctx, rawId));
  if (!canAccessBranch(ctx, pre.branchId)) throw new AppError("NOT_FOUND");
  if (!isReschedulable(pre.status)) throw new AppError("INVALID_STATUS_TRANSITION");
  await withConflictAudit(ctx, pre, async () => {
    const p = await tenantQuery(ctx, (scope) =>
      placeAppointment(scope, {
        branchId: pre.branchId,
        doctorId: pre.doctorId,
        patientId: pre.patientId,
        serviceId: pre.serviceId ?? undefined,
        durationMinutes: pre.durationMinutes,
        start: new Date(data.start),
        roomId: data.roomId,
        excludeId: pre.id,
      }),
    );
    await tenantQuery(ctx, async (scope) => {
      // Randevu satırı kilitlenir (aynı randevuya eşzamanlı ikinci taşıma bekler); çakışmayı constraint çözer.
      const a = await loadAccessibleAppointment(scope, ctx, pre.id, { forUpdate: true });
      if (!isReschedulable(a.status)) throw new AppError("INVALID_STATUS_TRANSITION");
      if (a.scheduledStart.getTime() !== pre.scheduledStart.getTime())
        throw new AppError("SLOT_NOT_AVAILABLE");
      await assertStillFree(scope, {
        doctorId: a.doctorId,
        patientId: a.patientId,
        roomId: p.roomId,
        start: p.start,
        end: p.end,
        excludeId: a.id,
      });
      await scope.tx
        .update(appointments)
        .set({
          scheduledStart: p.start,
          scheduledEnd: p.end,
          roomId: p.roomId,
          timezone: p.timezone,
          updatedByUserId: ctx.userId,
          updatedAt: new Date(),
        })
        .where(tenantWhere(appointments, scope, eq(appointments.id, a.id)))
        .catch(mapDbError);
      const meta = {
        oldStart: a.scheduledStart.toISOString(),
        oldEnd: a.scheduledEnd.toISOString(),
        newStart: p.start.toISOString(),
        newEnd: p.end.toISOString(),
        oldRoomId: a.roomId,
        newRoomId: p.roomId,
      };
      await addEvent(scope, ctx, a.id, "RESCHEDULED", a.status, a.status, meta);
      await audit(scope, ctx, "APPOINTMENT_RESCHEDULED", a, meta);
      await appointmentOutbox(scope, ctx, "APPOINTMENT_RESCHEDULED", a, {
        oldStart: meta.oldStart,
        newStart: meta.newStart,
      });
    });
  });
}

// ---------------------------------------------------------------- durum geçişleri

const STATUS_RULES: Record<
  "CONFIRMED" | "CHECKED_IN" | "IN_PROGRESS" | "COMPLETED" | "NO_SHOW",
  {
    permission: Permission;
    event: "CONFIRMED" | "CHECKED_IN" | "STARTED" | "COMPLETED" | "NO_SHOW";
    audit: AuditAction;
    stamp: "confirmedAt" | "checkedInAt" | "startedAt" | "completedAt" | "noShowAt";
  }
> = {
  CONFIRMED: {
    permission: "appointment.update",
    event: "CONFIRMED",
    audit: "APPOINTMENT_CONFIRMED",
    stamp: "confirmedAt",
  },
  CHECKED_IN: {
    permission: "appointment.checkin",
    event: "CHECKED_IN",
    audit: "APPOINTMENT_CHECKED_IN",
    stamp: "checkedInAt",
  },
  IN_PROGRESS: {
    permission: "appointment.start",
    event: "STARTED",
    audit: "APPOINTMENT_STARTED",
    stamp: "startedAt",
  },
  COMPLETED: {
    permission: "appointment.complete",
    event: "COMPLETED",
    audit: "APPOINTMENT_COMPLETED",
    stamp: "completedAt",
  },
  NO_SHOW: {
    permission: "appointment.no_show",
    event: "NO_SHOW",
    audit: "APPOINTMENT_NO_SHOW",
    stamp: "noShowAt",
  },
};

/** Durum geçişi (serbest string güncellemesi yok): izin + geçiş tablosu + DB tetikleyicisi. */
export async function updateAppointmentStatus(
  ctx: AuthContext,
  rawId: unknown,
  input: unknown,
): Promise<void> {
  const data = parseInput(updateAppointmentStatusInput, input);
  const rule = STATUS_RULES[data.status];
  requirePermission(ctx, rule.permission);
  await tenantQuery(ctx, async (scope) => {
    const a = await loadAccessibleAppointment(scope, ctx, rawId, { forUpdate: true });
    if (!canTransition(a.status, data.status)) throw new AppError("INVALID_STATUS_TRANSITION");
    if (data.status === "NO_SHOW" && a.scheduledStart.getTime() > Date.now()) {
      throw new AppError("INVALID_STATUS_TRANSITION", {
        message: "Randevu saati gelmeden 'gelmedi' olarak işaretlenemez.",
      });
    }
    const now = new Date();
    await scope.tx
      .update(appointments)
      .set({ status: data.status, [rule.stamp]: now, updatedByUserId: ctx.userId, updatedAt: now })
      .where(tenantWhere(appointments, scope, eq(appointments.id, a.id)))
      .catch(mapDbError);
    await addEvent(scope, ctx, a.id, rule.event, a.status, data.status);
    await audit(scope, ctx, rule.audit, { ...a, status: data.status });
    // Bildirim: onay → doktor; check-in → doktor ("hasta giriş yaptı"). Aynı geçiş ikinci kez yapılamaz
    // (durum makinesi) + bildirim tekilleştirme → yinelenen bildirim yok.
    if (data.status === "CHECKED_IN") await appointmentOutbox(scope, ctx, "APPOINTMENT_CHECKED_IN", a);
    if (data.status === "CONFIRMED") await appointmentOutbox(scope, ctx, "APPOINTMENT_CONFIRMED", a);
  });
}

export async function cancelAppointment(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "appointment.cancel");
  const data = parseInput(cancelAppointmentInput, input);
  await tenantQuery(ctx, async (scope) => {
    const cfg = await bookingConfig(scope);
    if (cfg.cancellationReasonRequired && !data.reason) {
      throw new AppError("VALIDATION", { fields: ["reason"], message: "İptal gerekçesi zorunludur." });
    }
    const a = await loadAccessibleAppointment(scope, ctx, rawId, { forUpdate: true });
    if (!canTransition(a.status, "CANCELLED")) throw new AppError("INVALID_STATUS_TRANSITION");
    const now = new Date();
    await scope.tx
      .update(appointments)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: ctx.userId,
        cancellationReason: data.reason ?? null,
        updatedByUserId: ctx.userId,
        updatedAt: now,
      })
      .where(tenantWhere(appointments, scope, eq(appointments.id, a.id)))
      .catch(mapDbError);
    // Gerekçe serbest metindir → geçmişe / audit'e YAZILMAZ (yalnızca randevu kaydında).
    await addEvent(scope, ctx, a.id, "CANCELLED", a.status, "CANCELLED", {
      reasonProvided: Boolean(data.reason),
    });
    await audit(
      scope,
      ctx,
      "APPOINTMENT_CANCELLED",
      { ...a, status: "CANCELLED" },
      { reasonProvided: Boolean(data.reason) },
    );
    // İptal gerekçesi outbox'a / bildirime YAZILMAZ.
    await appointmentOutbox(scope, ctx, "APPOINTMENT_CANCELLED", a);
  });
}

// ---------------------------------------------------------------- doktor onayı

/**
 * Doktor YALNIZCA KENDİ onay bekleyen randevusunu onaylar / reddeder. Başka doktorun randevusu (görünür olsa bile)
 * NOT_FOUND. Resepsiyon bu izne sahip değildir (FORBIDDEN). Satır kilitlenir; eşzamanlı ikinci karar geçiş
 * tablosunda reddedilir.
 */
async function loadOwnPending(scope: TenantScope, ctx: AuthContext, rawId: unknown) {
  const self = await selfDoctorId(scope, ctx);
  if (!self) throw new AppError("NOT_FOUND");
  const id = parseId(rawId);
  const [a] = await scope.tx
    .select()
    .from(appointments)
    .where(tenantWhere(appointments, scope, eq(appointments.id, id), eq(appointments.doctorId, self)))
    .for("update");
  if (!a) throw new AppError("NOT_FOUND");
  if (a.status !== "PENDING_APPROVAL") throw new AppError("INVALID_STATUS_TRANSITION");
  return a;
}

export async function approveAppointment(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "appointment.approve_own");
  await tenantQuery(ctx, async (scope) => {
    const a = await loadOwnPending(scope, ctx, rawId);
    const now = new Date();
    await scope.tx
      .update(appointments)
      .set({ status: "BOOKED", approvalExpiresAt: null, updatedByUserId: ctx.userId, updatedAt: now })
      .where(tenantWhere(appointments, scope, eq(appointments.id, a.id)))
      .catch(mapDbError);
    await addEvent(scope, ctx, a.id, "APPROVED", "PENDING_APPROVAL", "BOOKED");
    await audit(scope, ctx, "APPOINTMENT_APPROVED", { ...a, status: "BOOKED" });
    await appointmentOutbox(scope, ctx, "APPOINTMENT_APPROVED", a);
  });
}

/** Ret → CANCELLED: slot (exclusion constraint aktif listesi dışında kaldığı için) hemen yeniden müsait. */
export async function declineAppointment(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "appointment.decline_own");
  await tenantQuery(ctx, async (scope) => {
    const a = await loadOwnPending(scope, ctx, rawId);
    const now = new Date();
    await scope.tx
      .update(appointments)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: ctx.userId,
        approvalExpiresAt: null,
        updatedByUserId: ctx.userId,
        updatedAt: now,
      })
      .where(tenantWhere(appointments, scope, eq(appointments.id, a.id)))
      .catch(mapDbError);
    await addEvent(scope, ctx, a.id, "DECLINED", "PENDING_APPROVAL", "CANCELLED");
    await audit(scope, ctx, "APPOINTMENT_DECLINED", { ...a, status: "CANCELLED" });
    await appointmentOutbox(scope, ctx, "APPOINTMENT_DECLINED", a);
  });
}

/** Doktor portalı: KENDİ onay bekleyen randevuları (yakından uzağa). */
export async function listMyPendingApprovals(ctx: AuthContext): Promise<AppointmentListItem[]> {
  requirePermission(ctx, "appointment.approve_own");
  return tenantQuery(ctx, async (scope) => {
    const self = await selfDoctorId(scope, ctx);
    if (!self) return [];
    const rows = await baseListQuery(scope)
      .where(
        tenantWhere(
          appointments,
          scope,
          eq(appointments.doctorId, self),
          eq(appointments.status, "PENDING_APPROVAL"),
        ),
      )
      .orderBy(asc(appointments.scheduledStart))
      .limit(100);
    return rows.map((r) => toListItem(r));
  });
}

/** Operasyon notu (tıbbi kayıt DEĞİL) — şifreli; audit'e içerik yazılmaz. */
export async function updateAppointmentNotes(
  ctx: AuthContext,
  rawId: unknown,
  input: unknown,
): Promise<void> {
  requirePermission(ctx, "appointment.update");
  const data = parseInput(appointmentNotesInput, input);
  await tenantQuery(ctx, async (scope) => {
    const a = await loadAccessibleAppointment(scope, ctx, rawId, { forUpdate: true });
    if (!isReschedulable(a.status) && a.status !== "CHECKED_IN" && a.status !== "IN_PROGRESS") {
      throw new AppError("INVALID_STATUS_TRANSITION");
    }
    await scope.tx
      .update(appointments)
      .set({
        notesEncrypted: data.notes ? encryptField(data.notes, notesAad(scope.tenantId, a.id)) : null,
        updatedByUserId: ctx.userId,
        updatedAt: new Date(),
      })
      .where(tenantWhere(appointments, scope, eq(appointments.id, a.id)))
      .catch(mapDbError);
    await addEvent(scope, ctx, a.id, "NOTES_UPDATED", a.status, a.status);
    await audit(scope, ctx, "APPOINTMENT_UPDATED", a, { notesChanged: true });
  });
}

// ---------------------------------------------------------------- okuma

export type AppointmentListItem = {
  id: string;
  status: AppointmentStatus;
  start: string;
  end: string;
  timezone: string;
  localDate: string;
  localStart: string;
  localEnd: string;
  durationMinutes: number;
  patient: { id: string; name: string; patientNumber: string };
  doctor: { id: string; name: string };
  branch: { id: string; name: string };
  room: { id: string; name: string } | null;
  service: { id: string; name: string } | null;
};

const listColumns = {
  id: appointments.id,
  status: appointments.status,
  start: appointments.scheduledStart,
  end: appointments.scheduledEnd,
  timezone: appointments.timezone,
  durationMinutes: appointments.durationMinutes,
  patientId: appointments.patientId,
  patientFirst: patients.firstName,
  patientLast: patients.lastName,
  patientNumber: patients.patientNumber,
  doctorId: appointments.doctorId,
  doctorTitle: doctorProfiles.title,
  doctorFirst: users.firstName,
  doctorLast: users.lastName,
  branchId: appointments.branchId,
  branchName: branches.name,
  roomId: appointments.roomId,
  roomName: rooms.name,
  serviceId: appointments.serviceId,
  serviceName: clinicalServices.name,
};

function baseListQuery(scope: TenantScope) {
  return scope.tx
    .select(listColumns)
    .from(appointments)
    .innerJoin(
      patients,
      and(eq(patients.id, appointments.patientId), eq(patients.tenantId, appointments.tenantId)),
    )
    .innerJoin(
      doctorProfiles,
      and(eq(doctorProfiles.id, appointments.doctorId), eq(doctorProfiles.tenantId, appointments.tenantId)),
    )
    .innerJoin(users, and(eq(users.id, doctorProfiles.userId), eq(users.tenantId, doctorProfiles.tenantId)))
    .innerJoin(
      branches,
      and(eq(branches.id, appointments.branchId), eq(branches.tenantId, appointments.tenantId)),
    )
    .leftJoin(rooms, and(eq(rooms.id, appointments.roomId), eq(rooms.tenantId, appointments.tenantId)))
    .leftJoin(
      clinicalServices,
      and(
        eq(clinicalServices.id, appointments.serviceId),
        eq(clinicalServices.tenantId, appointments.tenantId),
      ),
    );
}

function toListItem(
  r: Awaited<ReturnType<ReturnType<typeof baseListQuery>["execute"]>>[number],
): AppointmentListItem {
  const ls = localDateTimeOf(r.start, r.timezone);
  const le = localDateTimeOf(r.end, r.timezone);
  return {
    id: r.id,
    status: r.status,
    start: r.start.toISOString(),
    end: r.end.toISOString(),
    timezone: r.timezone,
    localDate: ls.date,
    localStart: formatMinutes(ls.minutes),
    localEnd: le.date === ls.date ? formatMinutes(le.minutes) : "24:00",
    durationMinutes: r.durationMinutes,
    patient: { id: r.patientId, name: `${r.patientFirst} ${r.patientLast}`, patientNumber: r.patientNumber },
    doctor: {
      id: r.doctorId,
      name: doctorDisplayName({ title: r.doctorTitle, firstName: r.doctorFirst, lastName: r.doctorLast }),
    },
    branch: { id: r.branchId, name: r.branchName },
    room: r.roomId && r.roomName ? { id: r.roomId, name: r.roomName } : null,
    service: r.serviceId && r.serviceName ? { id: r.serviceId, name: r.serviceName } : null,
  };
}

const MAX_WINDOW_DAYS = 42;

/** Takvim listesi — tarih penceresi zorunlu (en fazla 42 gün), şube / doktor / statü filtresi. */
export async function listAppointments(ctx: AuthContext, input: unknown): Promise<AppointmentListItem[]> {
  const data = parseInput(listAppointmentsInput, input);
  if (data.to < data.from || addDays(data.from, MAX_WINDOW_DAYS) < data.to) {
    throw new AppError("VALIDATION", { fields: ["to"] });
  }
  if (data.branchId && !canAccessBranch(ctx, data.branchId)) return [];
  return tenantQuery(ctx, async (scope) => {
    const vis = await visibility(scope, ctx);
    let tz = (await bookingConfig(scope)).timezone;
    if (data.branchId) {
      const [b] = await scope.tx
        .select({ tz: branches.timezone })
        .from(branches)
        .where(tenantWhere(branches, scope, eq(branches.id, data.branchId)));
      if (!b) return [];
      tz = b.tz;
    }
    const from = zonedDateTimeToUtc(data.from, 0, tz);
    const to = zonedDateTimeToUtc(addDays(data.to, 1), 0, tz);
    const rows = await baseListQuery(scope)
      .where(
        tenantWhere(
          appointments,
          scope,
          vis,
          lt(appointments.scheduledStart, to),
          gt(appointments.scheduledEnd, from),
          data.branchId ? eq(appointments.branchId, data.branchId) : undefined,
          data.doctorId ? eq(appointments.doctorId, data.doctorId) : undefined,
          data.patientId ? eq(appointments.patientId, data.patientId) : undefined,
          data.status ? eq(appointments.status, data.status) : undefined,
        ),
      )
      .orderBy(asc(appointments.scheduledStart))
      .limit(2000);
    return rows.map(toListItem);
  });
}

export type AppointmentAction =
  "CONFIRMED" | "CHECKED_IN" | "IN_PROGRESS" | "COMPLETED" | "NO_SHOW" | "CANCEL" | "RESCHEDULE";

export type AppointmentDetail = AppointmentListItem & {
  notes: string | null;
  source: string;
  createdAt: string;
  cancellationReason: string | null;
  serviceId: string | null;
  actions: AppointmentAction[];
  /** Onay bekleyen randevu + görüntüleyen bu randevunun KENDİ doktoru + onay izni. */
  canDecideApproval: boolean;
  history: {
    id: string;
    type: string;
    fromStatus: string | null;
    toStatus: string | null;
    actorName: string | null;
    createdAt: string;
    metadata: Record<string, string | number | boolean | null>;
  }[];
};

function allowedActions(ctx: AuthContext, status: AppointmentStatus, start: Date): AppointmentAction[] {
  const out: AppointmentAction[] = [];
  for (const to of nextStatuses(status)) {
    if (to === "CANCELLED") {
      if (hasPermission(ctx, "appointment.cancel")) out.push("CANCEL");
    } else if (to in STATUS_RULES) {
      const rule = STATUS_RULES[to as keyof typeof STATUS_RULES];
      if (to === "NO_SHOW" && start.getTime() > Date.now()) continue;
      if (hasPermission(ctx, rule.permission)) out.push(to as AppointmentAction);
    }
  }
  if (isReschedulable(status) && hasPermission(ctx, "appointment.reschedule")) out.push("RESCHEDULE");
  return out;
}

export async function getAppointment(ctx: AuthContext, rawId: unknown): Promise<AppointmentDetail> {
  return tenantQuery(ctx, async (scope) => {
    const a = await loadAccessibleAppointment(scope, ctx, rawId);
    const [row] = await baseListQuery(scope).where(
      tenantWhere(appointments, scope, eq(appointments.id, a.id)),
    );
    const history = await scope.tx
      .select({
        id: appointmentEvents.id,
        type: appointmentEvents.type,
        fromStatus: appointmentEvents.fromStatus,
        toStatus: appointmentEvents.toStatus,
        createdAt: appointmentEvents.createdAt,
        metadata: appointmentEvents.metadataSafe,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(appointmentEvents)
      .leftJoin(
        users,
        and(eq(users.id, appointmentEvents.actorUserId), eq(users.tenantId, appointmentEvents.tenantId)),
      )
      .where(tenantWhere(appointmentEvents, scope, eq(appointmentEvents.appointmentId, a.id)))
      .orderBy(asc(appointmentEvents.createdAt));
    await audit(scope, ctx, "APPOINTMENT_VIEWED", a);
    const canDecideApproval =
      a.status === "PENDING_APPROVAL" &&
      hasPermission(ctx, "appointment.approve_own") &&
      (await selfDoctorId(scope, ctx)) === a.doctorId;
    return {
      ...toListItem(row!),
      notes: a.notesEncrypted ? decryptField(a.notesEncrypted, notesAad(scope.tenantId, a.id)) : null,
      source: a.source,
      createdAt: a.createdAt.toISOString(),
      cancellationReason: a.cancellationReason,
      serviceId: a.serviceId,
      actions: allowedActions(ctx, a.status, a.scheduledStart),
      canDecideApproval,
      history: history.map((h) => ({
        id: h.id,
        type: h.type,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        actorName: h.firstName ? `${h.firstName} ${h.lastName}` : null,
        createdAt: h.createdAt.toISOString(),
        metadata: h.metadata,
      })),
    };
  });
}

/** Hasta dosyası: yaklaşan + geçmiş randevular (şube / doktor kapsamına göre). */
export async function listPatientAppointments(ctx: AuthContext, rawPatientId: unknown) {
  return tenantQuery(ctx, async (scope) => {
    const patient = await loadVisiblePatient(scope, ctx, rawPatientId);
    const vis = await visibility(scope, ctx);
    const rows = await baseListQuery(scope)
      .where(tenantWhere(appointments, scope, vis, eq(appointments.patientId, patient.id)))
      .orderBy(desc(appointments.scheduledStart))
      .limit(200);
    const now = Date.now();
    const items = rows.map(toListItem);
    const open = (s: AppointmentStatus) =>
      s === "BOOKED" || s === "CONFIRMED" || s === "CHECKED_IN" || s === "IN_PROGRESS" || s === "DRAFT";
    return {
      upcoming: items.filter((i) => open(i.status) && new Date(i.end).getTime() >= now).reverse(),
      past: items.filter((i) => !(open(i.status) && new Date(i.end).getTime() >= now)),
    };
  });
}

/** Klinik saat dilimine göre bugünün tarihi (takvim varsayılanı). */
export async function clinicToday(ctx: AuthContext): Promise<string> {
  return tenantQuery(ctx, async (scope) => dateInZone(new Date(), (await bookingConfig(scope)).timezone));
}

/** Bugünün randevuları (klinik saat dilimi). Doktor yalnızca kendi randevularını görür. */
export async function getTodayAppointments(ctx: AuthContext, opts: { branchId?: string } = {}) {
  const today = await tenantQuery(ctx, async (scope) =>
    dateInZone(new Date(), (await bookingConfig(scope)).timezone),
  );
  const items = await listAppointments(ctx, { from: today, to: today, branchId: opts.branchId });
  return { today, items };
}

export type AppointmentStats = {
  date: string;
  total: number;
  upcoming: number;
  waiting: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  noShow: number;
};

/** Panel kartları: bugünün sayıları (yetkisiz şube verisi sayılmaz). */
export async function getAppointmentStats(
  ctx: AuthContext,
  opts: { branchId?: string } = {},
): Promise<AppointmentStats> {
  const { today, items } = await getTodayAppointments(ctx, opts);
  const count = (...s: AppointmentStatus[]) => items.filter((i) => s.includes(i.status)).length;
  return {
    date: today,
    total: items.filter((i) => i.status !== "CANCELLED").length,
    upcoming: count("BOOKED", "CONFIRMED"),
    waiting: count("CHECKED_IN"),
    inProgress: count("IN_PROGRESS"),
    completed: count("COMPLETED"),
    cancelled: count("CANCELLED"),
    noShow: count("NO_SHOW"),
  };
}

export type { AppointmentStatus };
