import "server-only";
import { and, asc, eq, gte, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  branchClosures,
  branchWorkingHours,
  branches,
  clinicProfiles,
  doctorBranches,
  doctorProfiles,
  doctorRoomAssignments,
  doctorScheduleExceptions,
  doctorWorkingHours,
  rooms,
  users,
} from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import {
  actorOf,
  canAccessBranch,
  hasPermission,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { doctorDisplayName, loadSelfDoctorId, loadVisibleDoctor } from "@/server/services/doctors";
import { PG_EXCLUSION_VIOLATION, PG_FOREIGN_KEY_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import {
  computeAvailability,
  overlaps,
  subtract,
  type AvailabilitySegment,
  type Interval,
  type RoomInterval,
} from "@/server/scheduling/availability";
import {
  DEFAULT_TIMEZONE,
  addDays,
  dateInZone,
  dayName,
  formatMinutes,
  isValidDate,
  isoDayOfWeek,
  parseTime,
  toHHMM,
  zonedDateTimeToUtc,
} from "@/lib/time";
import { uuidSchema } from "@/server/validation";

/**
 * Doktor çalışma planı + oda atamaları + izinler + müsaitlik temeli.
 *
 * ÇAKIŞMA MOTORU (iki katman):
 *  1. Transaction içinde advisory lock (doktor ve/veya oda başına) + örtüşme sorgusu → kullanıcıya anlamlı mesaj.
 *     Haftalık ↔ tarihli çapraz kontroller (exclusion constraint ile ifade edilemeyen) bu katmandadır; kilit
 *     sayesinde eşzamanlı iki istek birbirini görür.
 *  2. PostgreSQL exclusion constraint'leri (0004_scheduling_security.sql) → aynı türdeki örtüşmeler (aynı
 *     doktor/gün, aynı oda/gün, aynı oda/tarih …) veritabanında imkânsız. 23P01 → *_SCHEDULE_CONFLICT.
 *
 * Kurallar:
 *  - Doktor aynı gün içinde (hangi şube olursa olsun) örtüşen iki çalışma bloğuna sahip olamaz.
 *  - Oda ataması, doktorun o gün o şubedeki bir çalışma bloğunun İÇİNDE olmalıdır.
 *  - Aynı oda aynı anda iki doktora atanamaz (haftalık↔haftalık, tarihli↔tarihli, haftalık↔tarihli).
 *  - Tarihli override, doktorun o tarih/saatteki haftalık oda atamasının yerine geçer.
 *  - Aralıklar yarı açık: 09:00–12:00 ile 12:00–15:00 çakışmaz.
 *  - Çakışma mesajları yalnızca AYNI kiracının verisini içerir (sorgular RLS altında).
 */
const timeString = z.string().refine((v) => parseTime(v) !== null, "invalid time");
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const rangeRefine = <T extends { startTime: string; endTime: string }>(v: T) =>
  parseTime(v.startTime)! < parseTime(v.endTime)!;

export const workingHourSchema = z
  .object({
    doctorId: uuidSchema,
    branchId: uuidSchema,
    dayOfWeek: z.coerce.number().int().min(1).max(7),
    startTime: timeString,
    endTime: timeString,
    roomId: z.preprocess(blank, uuidSchema.optional()),
  })
  .refine(rangeRefine, { message: "invalid range", path: ["endTime"] });

export const roomAssignmentSchema = z
  .object({
    doctorId: uuidSchema,
    branchId: uuidSchema,
    roomId: uuidSchema,
    dayOfWeek: z.preprocess(blank, z.coerce.number().int().min(1).max(7).optional()),
    effectiveDate: z.preprocess(blank, z.string().refine(isValidDate, "invalid date").optional()),
    startTime: timeString,
    endTime: timeString,
  })
  .refine(rangeRefine, { message: "invalid range", path: ["endTime"] })
  .refine((v) => (v.dayOfWeek === undefined) !== (v.effectiveDate === undefined), {
    message: "either dayOfWeek or effectiveDate",
    path: ["dayOfWeek"],
  });

export const exceptionSchema = z
  .object({
    doctorId: uuidSchema,
    branchId: z.preprocess(blank, uuidSchema.optional()),
    date: z.string().refine(isValidDate, "invalid date"),
    type: z.enum(["ALL_DAY", "TIME_RANGE"]),
    startTime: z.preprocess(blank, timeString.optional()),
    endTime: z.preprocess(blank, timeString.optional()),
    reason: z.preprocess(blank, z.string().trim().max(200).optional()),
  })
  .refine(
    (v) =>
      v.type === "ALL_DAY"
        ? !v.startTime && !v.endTime
        : Boolean(v.startTime && v.endTime && parseTime(v.startTime)! < parseTime(v.endTime)!),
    { message: "invalid range", path: ["startTime"] },
  );

const toInterval = (r: { startTime: string; endTime: string }): Interval => ({
  start: parseTime(r.startTime)!,
  end: parseTime(r.endTime)!,
});
const span = (i: Interval) => `${formatMinutes(i.start)}–${formatMinutes(i.end)}`;

function parseId(raw: unknown): string {
  const id = uuidSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND");
  return id.data;
}

// ---------------------------------------------------------------- yetki

/** Plan yönetimi: doctor.schedule.manage + ilgili şubeye erişim (şube müdürü yalnızca kendi şubesi). */
function requireScheduleManage(ctx: AuthContext, branchId: string | null) {
  requirePermission(ctx, "doctor.schedule.manage");
  if (branchId === null ? !ctx.branchScope.all : !canAccessBranch(ctx, branchId)) {
    // Başka şubenin varlığını sızdırmamak için NOT_FOUND.
    throw new AppError("NOT_FOUND");
  }
}

/** Plan görüntüleme: doctor.schedule.read veya (kendi planı ise) doctor.self.read. */
async function loadDoctorForRead(scope: TenantScope, ctx: AuthContext, doctorId: string) {
  const doctor = await loadVisibleDoctor(scope, ctx, doctorId);
  const allowed =
    hasPermission(ctx, "doctor.schedule.read") || (doctor.isSelf && hasPermission(ctx, "doctor.self.read"));
  if (!allowed) throw new AppError("FORBIDDEN");
  return doctor;
}

async function lock(scope: TenantScope, ...keys: string[]) {
  // Deterministik sıra → kilitlenme (deadlock) önlenir. Kilitler transaction sonunda kendiliğinden bırakılır.
  for (const key of [...new Set(keys)].sort()) {
    await scope.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.tenantId}:${key}`}, 0))`,
    );
  }
}

function mapDbConflict(e: unknown): never {
  const info = pgErrorInfo(e);
  if (info.code === PG_EXCLUSION_VIOLATION) {
    if (info.constraint?.startsWith("dra_room_")) throw new AppError("ROOM_SCHEDULE_CONFLICT");
    throw new AppError("DOCTOR_SCHEDULE_CONFLICT");
  }
  if (info.code === PG_FOREIGN_KEY_VIOLATION) throw new AppError("NOT_FOUND");
  throw e;
}

// ---------------------------------------------------------------- yardımcı sorgular

async function doctorBranchLink(scope: TenantScope, doctorId: string, branchId: string) {
  const [link] = await scope.tx
    .select({
      active: doctorBranches.active,
      doctorActive: doctorProfiles.active,
      branchActive: branches.active,
    })
    .from(doctorBranches)
    .innerJoin(
      doctorProfiles,
      and(
        eq(doctorProfiles.id, doctorBranches.doctorId),
        eq(doctorProfiles.tenantId, doctorBranches.tenantId),
      ),
    )
    .innerJoin(
      branches,
      and(eq(branches.id, doctorBranches.branchId), eq(branches.tenantId, doctorBranches.tenantId)),
    )
    .where(
      tenantWhere(
        doctorBranches,
        scope,
        eq(doctorBranches.doctorId, doctorId),
        eq(doctorBranches.branchId, branchId),
      ),
    );
  if (!link) {
    throw new AppError("VALIDATION", { fields: ["branchId"], message: "Doktor bu şubeye atanmamış." });
  }
  if (!link.active || !link.doctorActive || !link.branchActive) {
    throw new AppError("VALIDATION", {
      fields: ["branchId"],
      message: "Doktor, şube veya atama aktif değil.",
    });
  }
}

async function doctorName(scope: TenantScope, doctorId: string): Promise<string> {
  const [d] = await scope.tx
    .select({ title: doctorProfiles.title, firstName: users.firstName, lastName: users.lastName })
    .from(doctorProfiles)
    .innerJoin(users, and(eq(users.id, doctorProfiles.userId), eq(users.tenantId, doctorProfiles.tenantId)))
    .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.id, doctorId)));
  return d ? doctorDisplayName(d) : "Doktor";
}

async function assertNoDoctorHourOverlap(
  scope: TenantScope,
  doctorId: string,
  day: number,
  interval: Interval,
  excludeId?: string,
) {
  const rows = await scope.tx
    .select({
      id: doctorWorkingHours.id,
      startTime: doctorWorkingHours.startTime,
      endTime: doctorWorkingHours.endTime,
      branchName: branches.name,
    })
    .from(doctorWorkingHours)
    .innerJoin(
      branches,
      and(eq(branches.id, doctorWorkingHours.branchId), eq(branches.tenantId, doctorWorkingHours.tenantId)),
    )
    .where(
      tenantWhere(
        doctorWorkingHours,
        scope,
        eq(doctorWorkingHours.doctorId, doctorId),
        eq(doctorWorkingHours.dayOfWeek, day),
        eq(doctorWorkingHours.active, true),
        excludeId ? ne(doctorWorkingHours.id, excludeId) : undefined,
      ),
    );
  const clash = rows.find((r) => overlaps(toInterval(r), interval));
  if (clash) {
    const name = await doctorName(scope, doctorId);
    throw new AppError("DOCTOR_SCHEDULE_CONFLICT", {
      message: `${name} bu saatte (${dayName(day)} ${span(toInterval(clash))}) ${clash.branchName} şubesinde çalışıyor.`,
    });
  }
}

/** Oda atamasının doktorun o şube/gündeki bir çalışma bloğunun içinde olduğunu doğrular. */
async function assertWithinWorkingHours(
  scope: TenantScope,
  doctorId: string,
  branchId: string,
  day: number,
  interval: Interval,
) {
  const blocks = await scope.tx
    .select({ startTime: doctorWorkingHours.startTime, endTime: doctorWorkingHours.endTime })
    .from(doctorWorkingHours)
    .where(
      tenantWhere(
        doctorWorkingHours,
        scope,
        eq(doctorWorkingHours.doctorId, doctorId),
        eq(doctorWorkingHours.branchId, branchId),
        eq(doctorWorkingHours.dayOfWeek, day),
        eq(doctorWorkingHours.active, true),
      ),
    );
  const contained = blocks.some((b) => {
    const i = toInterval(b);
    return i.start <= interval.start && i.end >= interval.end;
  });
  if (!contained) {
    throw new AppError("VALIDATION", {
      fields: ["startTime"],
      message: `Oda ataması, doktorun ${dayName(day)} günü bu şubedeki çalışma saatleri içinde olmalı.`,
    });
  }
}

type AssignmentDraft = {
  doctorId: string;
  branchId: string;
  roomId: string;
  dayOfWeek: number | null;
  effectiveDate: string | null;
  interval: Interval;
};

/**
 * Oda ve doktor çakışmalarını kontrol eder (çağıran oda + doktor kilitlerini almış olmalı).
 *  - Aynı oda: aynı gün haftalık / aynı tarih tarihli / haftalık↔tarihli (diğer doktorun override'larıyla taşınan
 *    süre düşülerek).
 *  - Aynı doktor: aynı türde örtüşen başka oda ataması.
 */
async function assertNoAssignmentConflicts(scope: TenantScope, draft: AssignmentDraft, excludeId?: string) {
  const day = draft.dayOfWeek ?? isoDayOfWeek(draft.effectiveDate!);
  const today = new Date().toISOString().slice(0, 10);

  const roomRows = await scope.tx
    .select({
      id: doctorRoomAssignments.id,
      doctorId: doctorRoomAssignments.doctorId,
      dayOfWeek: doctorRoomAssignments.dayOfWeek,
      effectiveDate: doctorRoomAssignments.effectiveDate,
      startTime: doctorRoomAssignments.startTime,
      endTime: doctorRoomAssignments.endTime,
    })
    .from(doctorRoomAssignments)
    .where(
      tenantWhere(
        doctorRoomAssignments,
        scope,
        eq(doctorRoomAssignments.roomId, draft.roomId),
        eq(doctorRoomAssignments.active, true),
        excludeId ? ne(doctorRoomAssignments.id, excludeId) : undefined,
        draft.dayOfWeek !== null
          ? or(
              eq(doctorRoomAssignments.dayOfWeek, day),
              and(
                isNotNull(doctorRoomAssignments.effectiveDate),
                gte(doctorRoomAssignments.effectiveDate, today),
              ),
            )
          : or(
              eq(doctorRoomAssignments.dayOfWeek, day),
              eq(doctorRoomAssignments.effectiveDate, draft.effectiveDate!),
            ),
      ),
    );

  for (const r of roomRows) {
    if (r.doctorId === draft.doctorId) continue; // aynı doktorun override'ı kendi haftalık atamasının yerine geçer
    const other = toInterval(r);
    let clash: Interval | null = null;
    if (draft.dayOfWeek !== null && r.dayOfWeek !== null) {
      clash = overlaps(other, draft.interval) ? other : null;
    } else if (draft.dayOfWeek === null && r.effectiveDate !== null) {
      clash = overlaps(other, draft.interval) ? other : null;
    } else if (draft.dayOfWeek !== null && r.effectiveDate !== null) {
      // yeni haftalık ↔ gelecekteki tarihli (yalnızca aynı haftanın günü)
      if (isoDayOfWeek(r.effectiveDate) === day && overlaps(other, draft.interval)) clash = other;
    } else if (draft.dayOfWeek === null && r.dayOfWeek !== null) {
      // yeni tarihli ↔ diğer doktorun haftalık ataması; o doktorun o tarihteki override'larıyla boşalan süre düşülür
      const moved = await scope.tx
        .select({ startTime: doctorRoomAssignments.startTime, endTime: doctorRoomAssignments.endTime })
        .from(doctorRoomAssignments)
        .where(
          tenantWhere(
            doctorRoomAssignments,
            scope,
            eq(doctorRoomAssignments.doctorId, r.doctorId),
            eq(doctorRoomAssignments.effectiveDate, draft.effectiveDate!),
            eq(doctorRoomAssignments.active, true),
          ),
        );
      const stillThere = subtract([other], moved.map(toInterval));
      const hit = stillThere.find((i) => overlaps(i, draft.interval));
      clash = hit ?? null;
    }
    if (clash) {
      const name = await doctorName(scope, r.doctorId);
      const when = r.effectiveDate ? `${r.effectiveDate} ` : "";
      throw new AppError("ROOM_SCHEDULE_CONFLICT", {
        message: `Bu oda ${when}${span(clash)} arasında ${name} tarafından kullanılıyor.`,
      });
    }
  }

  // Doktor: aynı türde örtüşen başka oda ataması (farklı oda dahil).
  const doctorRows = await scope.tx
    .select({
      startTime: doctorRoomAssignments.startTime,
      endTime: doctorRoomAssignments.endTime,
      roomName: rooms.name,
      branchName: branches.name,
    })
    .from(doctorRoomAssignments)
    .innerJoin(
      rooms,
      and(eq(rooms.id, doctorRoomAssignments.roomId), eq(rooms.tenantId, doctorRoomAssignments.tenantId)),
    )
    .innerJoin(
      branches,
      and(
        eq(branches.id, doctorRoomAssignments.branchId),
        eq(branches.tenantId, doctorRoomAssignments.tenantId),
      ),
    )
    .where(
      tenantWhere(
        doctorRoomAssignments,
        scope,
        eq(doctorRoomAssignments.doctorId, draft.doctorId),
        eq(doctorRoomAssignments.active, true),
        excludeId ? ne(doctorRoomAssignments.id, excludeId) : undefined,
        draft.dayOfWeek !== null
          ? eq(doctorRoomAssignments.dayOfWeek, draft.dayOfWeek)
          : eq(doctorRoomAssignments.effectiveDate, draft.effectiveDate!),
      ),
    );
  const self = doctorRows.find((r) => overlaps(toInterval(r), draft.interval));
  if (self) {
    const name = await doctorName(scope, draft.doctorId);
    throw new AppError("DOCTOR_SCHEDULE_CONFLICT", {
      message: `${name} bu saatte (${span(toInterval(self))}) ${self.branchName} şubesinde ${self.roomName} odasında.`,
    });
  }
}

async function assertRoomUsable(scope: TenantScope, roomId: string, branchId: string) {
  const [room] = await scope.tx
    .select({ branchId: rooms.branchId, active: rooms.active })
    .from(rooms)
    .where(tenantWhere(rooms, scope, eq(rooms.id, roomId)));
  if (!room) throw new AppError("NOT_FOUND");
  if (room.branchId !== branchId) {
    throw new AppError("VALIDATION", { fields: ["roomId"], message: "Oda seçilen şubeye ait değil." });
  }
  if (!room.active) throw new AppError("VALIDATION", { fields: ["roomId"], message: "Oda aktif değil." });
}

async function insertAssignment(
  scope: TenantScope,
  draft: AssignmentDraft,
  excludeId?: string,
): Promise<string> {
  await assertRoomUsable(scope, draft.roomId, draft.branchId);
  const day = draft.dayOfWeek ?? isoDayOfWeek(draft.effectiveDate!);
  await assertWithinWorkingHours(scope, draft.doctorId, draft.branchId, day, draft.interval);
  await assertNoAssignmentConflicts(scope, draft, excludeId);
  const [row] = await scope.tx
    .insert(doctorRoomAssignments)
    .values({
      tenantId: scope.tenantId,
      doctorId: draft.doctorId,
      branchId: draft.branchId,
      roomId: draft.roomId,
      dayOfWeek: draft.dayOfWeek,
      effectiveDate: draft.effectiveDate,
      startTime: formatMinutes(draft.interval.start),
      endTime: formatMinutes(draft.interval.end),
    })
    .returning({ id: doctorRoomAssignments.id })
    .catch(mapDbConflict);
  return row!.id;
}

// ---------------------------------------------------------------- çalışma blokları

export async function addWorkingHour(
  ctx: AuthContext,
  input: unknown,
): Promise<{ id: string; roomAssignmentId?: string }> {
  const data = parseInput(workingHourSchema, input);
  requireScheduleManage(ctx, data.branchId);
  const interval = toInterval(data);
  return tenantQuery(ctx, async (scope) => {
    await lock(scope, `doctor:${data.doctorId}`, ...(data.roomId ? [`room:${data.roomId}`] : []));
    await doctorBranchLink(scope, data.doctorId, data.branchId);
    await assertNoDoctorHourOverlap(scope, data.doctorId, data.dayOfWeek, interval);
    const [row] = await scope.tx
      .insert(doctorWorkingHours)
      .values({
        tenantId: scope.tenantId,
        doctorId: data.doctorId,
        branchId: data.branchId,
        dayOfWeek: data.dayOfWeek,
        startTime: data.startTime,
        endTime: data.endTime,
      })
      .returning({ id: doctorWorkingHours.id })
      .catch(mapDbConflict);
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_SCHEDULE_CREATED",
      entityType: "doctor_working_hour",
      entityId: row!.id,
      branchId: data.branchId,
      metadata: {
        doctorId: data.doctorId,
        dayOfWeek: data.dayOfWeek,
        start: data.startTime,
        end: data.endTime,
      },
    });
    let roomAssignmentId: string | undefined;
    if (data.roomId) {
      roomAssignmentId = await insertAssignment(scope, {
        doctorId: data.doctorId,
        branchId: data.branchId,
        roomId: data.roomId,
        dayOfWeek: data.dayOfWeek,
        effectiveDate: null,
        interval,
      });
      await writeAudit(scope, actorOf(ctx), {
        action: "DOCTOR_ROOM_ASSIGNED",
        entityType: "doctor_room_assignment",
        entityId: roomAssignmentId,
        branchId: data.branchId,
        metadata: { doctorId: data.doctorId, roomId: data.roomId, dayOfWeek: data.dayOfWeek },
      });
    }
    return { id: row!.id, roomAssignmentId };
  });
}

async function loadWorkingHour(scope: TenantScope, id: string) {
  const [row] = await scope.tx
    .select()
    .from(doctorWorkingHours)
    .where(tenantWhere(doctorWorkingHours, scope, eq(doctorWorkingHours.id, id)));
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

export async function updateWorkingHour(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "doctor.schedule.manage");
  const id = parseId(rawId);
  const data = parseInput(
    z
      .object({ startTime: timeString, endTime: timeString })
      .refine(rangeRefine, { message: "invalid range", path: ["endTime"] }),
    input,
  );
  const interval = toInterval(data);
  await tenantQuery(ctx, async (scope) => {
    const current = await loadWorkingHour(scope, id);
    requireScheduleManage(ctx, current.branchId);
    await lock(scope, `doctor:${current.doctorId}`);
    await assertNoDoctorHourOverlap(scope, current.doctorId, current.dayOfWeek, interval, id);
    // Bu bloktaki haftalık oda atamaları yeni aralığın dışında kalamaz.
    const assigned = await scope.tx
      .select({ startTime: doctorRoomAssignments.startTime, endTime: doctorRoomAssignments.endTime })
      .from(doctorRoomAssignments)
      .where(
        tenantWhere(
          doctorRoomAssignments,
          scope,
          eq(doctorRoomAssignments.doctorId, current.doctorId),
          eq(doctorRoomAssignments.branchId, current.branchId),
          eq(doctorRoomAssignments.dayOfWeek, current.dayOfWeek),
          eq(doctorRoomAssignments.active, true),
        ),
      );
    const old = toInterval(current);
    const inBlock = assigned.map(toInterval).filter((a) => a.start >= old.start && a.end <= old.end);
    if (inBlock.some((a) => a.start < interval.start || a.end > interval.end)) {
      throw new AppError("CONFLICT", {
        message:
          "Bu bloktaki oda atamaları yeni saat aralığının dışında kalıyor. Önce oda atamalarını güncelleyin.",
      });
    }
    await scope.tx
      .update(doctorWorkingHours)
      .set({ startTime: data.startTime, endTime: data.endTime })
      .where(tenantWhere(doctorWorkingHours, scope, eq(doctorWorkingHours.id, id)))
      .catch(mapDbConflict);
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_SCHEDULE_UPDATED",
      entityType: "doctor_working_hour",
      entityId: id,
      branchId: current.branchId,
      metadata: { doctorId: current.doctorId, start: data.startTime, end: data.endTime },
    });
  });
}

/** Bloğu siler; bloğun içindeki haftalık oda atamaları da silinir (sayı audit'e yazılır). */
export async function deleteWorkingHour(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "doctor.schedule.manage");
  const id = parseId(rawId);
  await tenantQuery(ctx, async (scope) => {
    const current = await loadWorkingHour(scope, id);
    requireScheduleManage(ctx, current.branchId);
    await lock(scope, `doctor:${current.doctorId}`);
    const assigned = await scope.tx
      .select({
        id: doctorRoomAssignments.id,
        startTime: doctorRoomAssignments.startTime,
        endTime: doctorRoomAssignments.endTime,
      })
      .from(doctorRoomAssignments)
      .where(
        tenantWhere(
          doctorRoomAssignments,
          scope,
          eq(doctorRoomAssignments.doctorId, current.doctorId),
          eq(doctorRoomAssignments.branchId, current.branchId),
          eq(doctorRoomAssignments.dayOfWeek, current.dayOfWeek),
        ),
      );
    const block = toInterval(current);
    const inside = assigned.filter((a) => {
      const i = toInterval(a);
      return i.start >= block.start && i.end <= block.end;
    });
    for (const a of inside) {
      await scope.tx
        .delete(doctorRoomAssignments)
        .where(tenantWhere(doctorRoomAssignments, scope, eq(doctorRoomAssignments.id, a.id)));
    }
    await scope.tx
      .delete(doctorWorkingHours)
      .where(tenantWhere(doctorWorkingHours, scope, eq(doctorWorkingHours.id, id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_SCHEDULE_DELETED",
      entityType: "doctor_working_hour",
      entityId: id,
      branchId: current.branchId,
      metadata: { doctorId: current.doctorId, removedRoomAssignments: inside.length },
    });
  });
}

// ---------------------------------------------------------------- oda atamaları

export async function addRoomAssignment(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  const data = parseInput(roomAssignmentSchema, input);
  requireScheduleManage(ctx, data.branchId);
  return tenantQuery(ctx, async (scope) => {
    await lock(scope, `doctor:${data.doctorId}`, `room:${data.roomId}`);
    await doctorBranchLink(scope, data.doctorId, data.branchId);
    const id = await insertAssignment(scope, {
      doctorId: data.doctorId,
      branchId: data.branchId,
      roomId: data.roomId,
      dayOfWeek: data.dayOfWeek ?? null,
      effectiveDate: data.effectiveDate ?? null,
      interval: toInterval(data),
    });
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_ROOM_ASSIGNED",
      entityType: "doctor_room_assignment",
      entityId: id,
      branchId: data.branchId,
      metadata: {
        doctorId: data.doctorId,
        roomId: data.roomId,
        dayOfWeek: data.dayOfWeek ?? null,
        effectiveDate: data.effectiveDate ?? null,
      },
    });
    return { id };
  });
}

async function loadAssignment(scope: TenantScope, id: string) {
  const [row] = await scope.tx
    .select()
    .from(doctorRoomAssignments)
    .where(tenantWhere(doctorRoomAssignments, scope, eq(doctorRoomAssignments.id, id)));
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

/** Atamanın odasını değiştirir (aynı zaman aralığı) — tüm çakışma kuralları yeniden uygulanır. */
export async function changeAssignmentRoom(
  ctx: AuthContext,
  rawId: unknown,
  rawRoomId: unknown,
): Promise<void> {
  requirePermission(ctx, "doctor.schedule.manage");
  const id = parseId(rawId);
  const roomId = parseId(rawRoomId);
  await tenantQuery(ctx, async (scope) => {
    const current = await loadAssignment(scope, id);
    requireScheduleManage(ctx, current.branchId);
    await lock(scope, `doctor:${current.doctorId}`, `room:${roomId}`, `room:${current.roomId}`);
    const draft: AssignmentDraft = {
      doctorId: current.doctorId,
      branchId: current.branchId,
      roomId,
      dayOfWeek: current.dayOfWeek,
      effectiveDate: current.effectiveDate,
      interval: toInterval(current),
    };
    await assertRoomUsable(scope, roomId, current.branchId);
    await assertNoAssignmentConflicts(scope, draft, id);
    await scope.tx
      .update(doctorRoomAssignments)
      .set({ roomId })
      .where(tenantWhere(doctorRoomAssignments, scope, eq(doctorRoomAssignments.id, id)))
      .catch(mapDbConflict);
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_ROOM_CHANGED",
      entityType: "doctor_room_assignment",
      entityId: id,
      branchId: current.branchId,
      metadata: { doctorId: current.doctorId, fromRoomId: current.roomId, toRoomId: roomId },
    });
  });
}

export async function deleteRoomAssignment(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "doctor.schedule.manage");
  const id = parseId(rawId);
  await tenantQuery(ctx, async (scope) => {
    const current = await loadAssignment(scope, id);
    requireScheduleManage(ctx, current.branchId);
    await scope.tx
      .delete(doctorRoomAssignments)
      .where(tenantWhere(doctorRoomAssignments, scope, eq(doctorRoomAssignments.id, id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_ROOM_UNASSIGNED",
      entityType: "doctor_room_assignment",
      entityId: id,
      branchId: current.branchId,
      metadata: { doctorId: current.doctorId, roomId: current.roomId },
    });
  });
}

// ---------------------------------------------------------------- izinler / çalışmama

export async function addScheduleException(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  const data = parseInput(exceptionSchema, input);
  requireScheduleManage(ctx, data.branchId ?? null);
  return tenantQuery(ctx, async (scope) => {
    const [doctor] = await scope.tx
      .select({ id: doctorProfiles.id })
      .from(doctorProfiles)
      .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.id, data.doctorId)));
    if (!doctor) throw new AppError("NOT_FOUND");
    if (data.branchId) await doctorBranchLink(scope, data.doctorId, data.branchId);
    const [row] = await scope.tx
      .insert(doctorScheduleExceptions)
      .values({
        tenantId: scope.tenantId,
        doctorId: data.doctorId,
        branchId: data.branchId ?? null,
        date: data.date,
        type: data.type,
        startTime: data.type === "TIME_RANGE" ? data.startTime! : null,
        endTime: data.type === "TIME_RANGE" ? data.endTime! : null,
        reason: data.reason ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: doctorScheduleExceptions.id })
      .catch(mapDbConflict);
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_EXCEPTION_CREATED",
      entityType: "doctor_schedule_exception",
      entityId: row!.id,
      branchId: data.branchId ?? null,
      // Neden (reason) serbest metin olabilir → audit'e YAZILMAZ.
      metadata: { doctorId: data.doctorId, date: data.date, type: data.type },
    });
    return { id: row!.id };
  });
}

export async function deleteScheduleException(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "doctor.schedule.manage");
  const id = parseId(rawId);
  await tenantQuery(ctx, async (scope) => {
    const [row] = await scope.tx
      .select()
      .from(doctorScheduleExceptions)
      .where(tenantWhere(doctorScheduleExceptions, scope, eq(doctorScheduleExceptions.id, id)));
    if (!row) throw new AppError("NOT_FOUND");
    requireScheduleManage(ctx, row.branchId);
    await scope.tx
      .delete(doctorScheduleExceptions)
      .where(tenantWhere(doctorScheduleExceptions, scope, eq(doctorScheduleExceptions.id, id)));
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_EXCEPTION_DELETED",
      entityType: "doctor_schedule_exception",
      entityId: id,
      branchId: row.branchId,
      metadata: { doctorId: row.doctorId, date: row.date },
    });
  });
}

// ---------------------------------------------------------------- okuma (müsaitlik temeli)

export async function getDoctorWorkingWindowsInScope(
  scope: TenantScope,
  doctorId: string,
  branchId?: string,
) {
  return scope.tx
    .select({
      id: doctorWorkingHours.id,
      branchId: doctorWorkingHours.branchId,
      branchName: branches.name,
      dayOfWeek: doctorWorkingHours.dayOfWeek,
      startTime: doctorWorkingHours.startTime,
      endTime: doctorWorkingHours.endTime,
    })
    .from(doctorWorkingHours)
    .innerJoin(
      branches,
      and(eq(branches.id, doctorWorkingHours.branchId), eq(branches.tenantId, doctorWorkingHours.tenantId)),
    )
    .where(
      tenantWhere(
        doctorWorkingHours,
        scope,
        eq(doctorWorkingHours.doctorId, doctorId),
        eq(doctorWorkingHours.active, true),
        branchId ? eq(doctorWorkingHours.branchId, branchId) : undefined,
      ),
    )
    .orderBy(asc(doctorWorkingHours.dayOfWeek), asc(doctorWorkingHours.startTime));
}

export async function getDoctorRoomAssignmentsInScope(
  scope: TenantScope,
  doctorId: string,
  opts: { branchId?: string; fromDate?: string } = {},
) {
  return scope.tx
    .select({
      id: doctorRoomAssignments.id,
      branchId: doctorRoomAssignments.branchId,
      roomId: doctorRoomAssignments.roomId,
      roomName: rooms.name,
      roomActive: rooms.active,
      dayOfWeek: doctorRoomAssignments.dayOfWeek,
      effectiveDate: doctorRoomAssignments.effectiveDate,
      startTime: doctorRoomAssignments.startTime,
      endTime: doctorRoomAssignments.endTime,
    })
    .from(doctorRoomAssignments)
    .innerJoin(
      rooms,
      and(eq(rooms.id, doctorRoomAssignments.roomId), eq(rooms.tenantId, doctorRoomAssignments.tenantId)),
    )
    .where(
      tenantWhere(
        doctorRoomAssignments,
        scope,
        eq(doctorRoomAssignments.doctorId, doctorId),
        eq(doctorRoomAssignments.active, true),
        opts.branchId ? eq(doctorRoomAssignments.branchId, opts.branchId) : undefined,
        opts.fromDate
          ? or(
              isNull(doctorRoomAssignments.effectiveDate),
              gte(doctorRoomAssignments.effectiveDate, opts.fromDate),
            )
          : undefined,
      ),
    )
    .orderBy(
      asc(doctorRoomAssignments.dayOfWeek),
      asc(doctorRoomAssignments.effectiveDate),
      asc(doctorRoomAssignments.startTime),
    );
}

export async function getDoctorScheduleExceptionsInScope(
  scope: TenantScope,
  doctorId: string,
  fromDate?: string,
) {
  return scope.tx
    .select()
    .from(doctorScheduleExceptions)
    .where(
      tenantWhere(
        doctorScheduleExceptions,
        scope,
        eq(doctorScheduleExceptions.doctorId, doctorId),
        fromDate ? gte(doctorScheduleExceptions.date, fromDate) : undefined,
      ),
    )
    .orderBy(asc(doctorScheduleExceptions.date));
}

export async function getBranchClosuresInScope(scope: TenantScope, branchId: string, date?: string) {
  return scope.tx
    .select()
    .from(branchClosures)
    .where(
      tenantWhere(
        branchClosures,
        scope,
        eq(branchClosures.branchId, branchId),
        date ? eq(branchClosures.date, date) : undefined,
      ),
    )
    .orderBy(asc(branchClosures.date));
}

/** Klinik saat dilimi (profil yoksa varsayılan). */
async function clinicTimezone(scope: TenantScope): Promise<string> {
  const [p] = await scope.tx
    .select({ tz: clinicProfiles.timezone })
    .from(clinicProfiles)
    .where(tenantWhere(clinicProfiles, scope));
  return p?.tz ?? DEFAULT_TIMEZONE;
}

export type AvailabilityWindow = {
  start: string;
  end: string;
  startUtc: string;
  endUtc: string;
  roomId: string | null;
  roomName: string | null;
};

export type AvailabilityResult = {
  doctorId: string;
  branchId: string;
  branchName: string;
  date: string;
  timezone: string;
  windows: AvailabilityWindow[];
  reason: "OK" | "NOT_WORKING" | "DOCTOR_EXCEPTION" | "BRANCH_CLOSED" | "INACTIVE";
};

/** Kapsam içi müsaitlik hesabı (yetki kontrolü çağıranda). */
export async function resolveAvailabilityInScope(
  scope: TenantScope,
  doctorId: string,
  branchId: string,
  date: string,
): Promise<AvailabilityResult> {
  const [link] = await scope.tx
    .select({
      active: doctorBranches.active,
      doctorActive: doctorProfiles.active,
      branchActive: branches.active,
      branchName: branches.name,
      timezone: branches.timezone,
      hoursEnabled: branches.workingHoursEnabled,
    })
    .from(doctorBranches)
    .innerJoin(
      doctorProfiles,
      and(
        eq(doctorProfiles.id, doctorBranches.doctorId),
        eq(doctorProfiles.tenantId, doctorBranches.tenantId),
      ),
    )
    .innerJoin(
      branches,
      and(eq(branches.id, doctorBranches.branchId), eq(branches.tenantId, doctorBranches.tenantId)),
    )
    .where(
      tenantWhere(
        doctorBranches,
        scope,
        eq(doctorBranches.doctorId, doctorId),
        eq(doctorBranches.branchId, branchId),
      ),
    );
  if (!link) throw new AppError("NOT_FOUND");
  const base = { doctorId, branchId, branchName: link.branchName, date, timezone: link.timezone };
  if (!link.active || !link.doctorActive || !link.branchActive)
    return { ...base, windows: [], reason: "INACTIVE" };

  const day = isoDayOfWeek(date);
  const working = (await getDoctorWorkingWindowsInScope(scope, doctorId, branchId))
    .filter((w) => w.dayOfWeek === day)
    .map(toInterval);
  if (!working.length) return { ...base, windows: [], reason: "NOT_WORKING" };

  let branchHours: Interval[] | null = null;
  if (link.hoursEnabled) {
    const [h] = await scope.tx
      .select()
      .from(branchWorkingHours)
      .where(
        tenantWhere(
          branchWorkingHours,
          scope,
          eq(branchWorkingHours.branchId, branchId),
          eq(branchWorkingHours.dayOfWeek, day),
        ),
      );
    branchHours =
      h && h.enabled && h.startTime && h.endTime
        ? [toInterval({ startTime: h.startTime, endTime: h.endTime })]
        : [];
  }

  const exceptions = (await getDoctorScheduleExceptionsInScope(scope, doctorId))
    .filter((e) => e.date === date && (e.branchId === null || e.branchId === branchId))
    .map((e) =>
      e.type === "ALL_DAY"
        ? ({ allDay: true } as const)
        : ({ allDay: false, ...toInterval({ startTime: e.startTime!, endTime: e.endTime! }) } as const),
    );
  const closures = (await getBranchClosuresInScope(scope, branchId, date)).map((c) =>
    c.allDay
      ? ({ allDay: true } as const)
      : ({ allDay: false, ...toInterval({ startTime: c.startTime!, endTime: c.endTime! }) } as const),
  );
  const assignments = (await getDoctorRoomAssignmentsInScope(scope, doctorId, { branchId })).filter(
    (a) => a.roomActive,
  );
  const toRoom = (a: (typeof assignments)[number]): RoomInterval => ({
    ...toInterval(a),
    roomId: a.roomId,
    roomName: a.roomName,
  });

  const segments: AvailabilitySegment[] = computeAvailability({
    working,
    branchHours,
    exceptions,
    closures,
    weeklyRooms: assignments.filter((a) => a.dayOfWeek === day).map(toRoom),
    datedRooms: assignments.filter((a) => a.effectiveDate === date).map(toRoom),
  });

  const reason: AvailabilityResult["reason"] = segments.length
    ? "OK"
    : closures.some((c) => c.allDay) || branchHours?.length === 0
      ? "BRANCH_CLOSED"
      : exceptions.length
        ? "DOCTOR_EXCEPTION"
        : closures.length
          ? "BRANCH_CLOSED"
          : "NOT_WORKING";

  return {
    ...base,
    reason,
    windows: segments.map((s) => ({
      start: formatMinutes(s.start),
      end: formatMinutes(s.end),
      startUtc: zonedDateTimeToUtc(date, s.start, link.timezone).toISOString(),
      endUtc: zonedDateTimeToUtc(date, s.end, link.timezone).toISOString(),
      roomId: s.roomId,
      roomName: s.roomName,
    })),
  };
}

/**
 * Müsaitlik temeli: çalışma saatleri − izinler − kapanışlar, oda atamalarıyla bölünmüş pencereler.
 * Sprint 2'de randevular bu pencerelerden düşülecek. tenantId her zaman oturumdan gelir.
 */
export async function resolveDoctorAvailabilityBase(
  ctx: AuthContext,
  input: { doctorId: unknown; branchId: unknown; date: unknown },
): Promise<AvailabilityResult> {
  const doctorId = parseId(input.doctorId);
  const branchId = parseId(input.branchId);
  if (typeof input.date !== "string" || !isValidDate(input.date)) {
    throw new AppError("VALIDATION", { fields: ["date"] });
  }
  const date = input.date;
  return tenantQuery(ctx, async (scope) => {
    const doctor = await loadDoctorForRead(scope, ctx, doctorId);
    if (!doctor.isSelf && !canAccessBranch(ctx, branchId)) throw new AppError("NOT_FOUND");
    return resolveAvailabilityInScope(scope, doctorId, branchId, date);
  });
}

/** Planlama ekranı: doktorun tüm planı (şube kapsamına göre filtrelenir). */
export async function getDoctorSchedule(ctx: AuthContext, rawDoctorId: unknown) {
  const doctorId = parseId(rawDoctorId);
  return tenantQuery(ctx, async (scope) => {
    const doctor = await loadDoctorForRead(scope, ctx, doctorId);
    const tz = await clinicTimezone(scope);
    const today = dateInZone(new Date(), tz);
    const visible = (branchId: string | null) =>
      doctor.isSelf || branchId === null || canAccessBranch(ctx, branchId);
    const working = (await getDoctorWorkingWindowsInScope(scope, doctorId)).filter((w) =>
      visible(w.branchId),
    );
    const assignments = (await getDoctorRoomAssignmentsInScope(scope, doctorId, { fromDate: today })).filter(
      (a) => visible(a.branchId),
    );
    const exceptions = (await getDoctorScheduleExceptionsInScope(scope, doctorId, today)).filter((e) =>
      visible(e.branchId),
    );
    return {
      doctor,
      today,
      timezone: tz,
      working: working.map((w) => ({ ...w, startTime: toHHMM(w.startTime), endTime: toHHMM(w.endTime) })),
      assignments: assignments.map((a) => ({
        ...a,
        startTime: toHHMM(a.startTime),
        endTime: toHHMM(a.endTime),
      })),
      exceptions: exceptions.map((e) => ({
        ...e,
        startTime: e.startTime ? toHHMM(e.startTime) : null,
        endTime: e.endTime ? toHHMM(e.endTime) : null,
      })),
    };
  });
}

export async function getDoctorWorkingWindows(ctx: AuthContext, rawDoctorId: unknown) {
  return (await getDoctorSchedule(ctx, rawDoctorId)).working;
}
export async function getDoctorRoomAssignments(ctx: AuthContext, rawDoctorId: unknown) {
  return (await getDoctorSchedule(ctx, rawDoctorId)).assignments;
}
export async function getDoctorScheduleExceptions(ctx: AuthContext, rawDoctorId: unknown) {
  return (await getDoctorSchedule(ctx, rawDoctorId)).exceptions;
}
export async function getBranchClosures(ctx: AuthContext, rawBranchId: unknown, date?: string) {
  requirePermission(ctx, "branch.read");
  const branchId = parseId(rawBranchId);
  if (!canAccessBranch(ctx, branchId)) throw new AppError("NOT_FOUND");
  return tenantQuery(ctx, (scope) =>
    getBranchClosuresInScope(scope, branchId, date && isValidDate(date) ? date : undefined),
  );
}

/** Doktor portalı (/doctor): kendi bugünkü ve yaklaşan planı. Yalnızca doctor.self.read. */
export async function getMyDoctorOverview(ctx: AuthContext, days = 14) {
  requirePermission(ctx, "doctor.self.read");
  return tenantQuery(ctx, async (scope) => {
    const doctorId = await loadSelfDoctorId(scope, ctx);
    const doctor = await loadVisibleDoctor(scope, ctx, doctorId);
    const tz = await clinicTimezone(scope);
    const today = dateInZone(new Date(), tz);
    const activeBranches = doctor.branches.filter((b) => b.active);
    const upcoming: AvailabilityResult[] = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i);
      for (const b of activeBranches) {
        const r = await resolveAvailabilityInScope(scope, doctorId, b.id, date);
        if (r.windows.length || r.reason === "DOCTOR_EXCEPTION" || r.reason === "BRANCH_CLOSED")
          upcoming.push(r);
      }
    }
    const exceptions = await getDoctorScheduleExceptionsInScope(scope, doctorId, today);
    return {
      doctor: { id: doctor.id, displayName: doctor.displayName, specialty: doctor.specialty },
      today,
      timezone: tz,
      todayItems: upcoming.filter((u) => u.date === today),
      upcoming: upcoming.filter((u) => u.date !== today && u.windows.length),
      exceptions: exceptions.map((e) => ({
        id: e.id,
        date: e.date,
        type: e.type,
        startTime: e.startTime ? toHHMM(e.startTime) : null,
        endTime: e.endTime ? toHHMM(e.endTime) : null,
        reason: e.reason,
      })),
    };
  });
}
