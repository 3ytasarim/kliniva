import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { branchClosures, branchWorkingHours, branches, rooms } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import {
  actorOf,
  branchFilter,
  canAccessBranch,
  requireBranchAccess,
  requirePermission,
  type AuthContext,
} from "@/server/auth/authz";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { emailSchema, nameSchema, phoneSchema, uuidSchema } from "@/server/validation";
import { parseInput } from "@/server/services/parse";
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { isValidDate, isValidTimeZone, parseTime } from "@/lib/time";

/**
 * Şube, şube çalışma saatleri, şube kapanışları ve oda servisi.
 *  - Şube kapsamlı kullanıcı (BRANCH_MANAGER) yalnızca atandığı şubeleri görür; diğerleri NOT_FOUND.
 *  - Şube oluşturma / düzenleme / kapatma kiracı geneli yönetimdir (branch.manage + tüm şubeler kapsamı).
 *  - Oda yönetimi room.manage + ilgili şubeye erişim ister. Silme yok: pasifleştirme.
 */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
const codeSchema = z.preprocess(
  blank,
  z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,20}$/, "invalid code")
    .optional(),
);
const boolish = z.preprocess((v) => v === true || v === "true" || v === "on" || v === "1", z.boolean());

export const ROOM_TYPES = [
  "EXAMINATION",
  "PROCEDURE",
  "TREATMENT",
  "LASER",
  "CONSULTATION",
  "SURGERY",
  "OTHER",
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const branchInputSchema = z.object({
  name: nameSchema,
  code: codeSchema,
  city: z.string().trim().min(1).max(80),
  district: optText(80),
  address: optText(300),
  phone: z.preprocess(blank, phoneSchema.optional()),
  email: z.preprocess(blank, emailSchema.optional()),
  timezone: z.preprocess(blank, z.string().refine(isValidTimeZone, "invalid timezone").optional()),
});

export const roomInputSchema = z.object({
  branchId: uuidSchema,
  name: nameSchema,
  code: codeSchema,
  type: z.preprocess(blank, z.enum(ROOM_TYPES).optional()),
  floor: optText(20),
  description: optText(300),
});

const timeString = z.string().refine((v) => parseTime(v) !== null, "invalid time");

export const branchHoursSchema = z
  .array(
    z
      .object({
        dayOfWeek: z.coerce.number().int().min(1).max(7),
        enabled: boolish,
        startTime: z.preprocess(blank, timeString.optional()),
        endTime: z.preprocess(blank, timeString.optional()),
      })
      .refine(
        (d) => !d.enabled || (d.startTime && d.endTime && parseTime(d.startTime)! < parseTime(d.endTime)!),
        "invalid range",
      ),
  )
  .length(7)
  .refine((days) => new Set(days.map((d) => d.dayOfWeek)).size === 7, "duplicate day");

export const branchClosureSchema = z
  .object({
    branchId: uuidSchema,
    date: z.string().refine(isValidDate, "invalid date"),
    allDay: boolish,
    startTime: z.preprocess(blank, timeString.optional()),
    endTime: z.preprocess(blank, timeString.optional()),
    reason: optText(200),
  })
  .refine((c) => c.allDay || (c.startTime && c.endTime && parseTime(c.startTime)! < parseTime(c.endTime)!), {
    message: "invalid range",
    path: ["startTime"],
  });

function mapUnique(e: unknown, field: string): never {
  if (pgErrorInfo(e).code === PG_UNIQUE_VIOLATION) {
    throw new AppError("CONFLICT", {
      fields: [field],
      message: "Bu ad veya kod bu kapsamda zaten kullanılıyor.",
    });
  }
  throw e;
}

function requireTenantWideManager(ctx: AuthContext) {
  requirePermission(ctx, "branch.manage");
  if (!ctx.branchScope.all) throw new AppError("FORBIDDEN");
}

/** Formda alan gönderildiyse boş değer "temizle" (null) demektir; hiç gönderilmediyse dokunulmaz. */
function clearable(input: unknown, key: string, value: string | undefined): string | null | undefined {
  const present = typeof input === "object" && input !== null && key in input;
  return present ? (value ?? null) : undefined;
}

function parseId(raw: unknown): string {
  const id = uuidSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND");
  return id.data;
}

// ---------------------------------------------------------------- şubeler

export async function listBranches(ctx: AuthContext) {
  requirePermission(ctx, "branch.read");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({
        id: branches.id,
        name: branches.name,
        code: branches.code,
        city: branches.city,
        district: branches.district,
        address: branches.address,
        phone: branches.phone,
        email: branches.email,
        timezone: branches.timezone,
        active: branches.active,
        workingHoursEnabled: branches.workingHoursEnabled,
      })
      .from(branches)
      .where(tenantWhere(branches, scope, branchFilter(ctx, branches.id)))
      .orderBy(asc(branches.name)),
  );
}

/** Liste ekranı: oda / doktor sayıları ve açık gün sayısı ile. */
export async function listBranchesWithStats(ctx: AuthContext) {
  requirePermission(ctx, "branch.read");
  return tenantQuery(ctx, async (scope) => {
    const rows = await scope.tx
      .select({
        id: branches.id,
        name: branches.name,
        code: branches.code,
        city: branches.city,
        district: branches.district,
        active: branches.active,
        workingHoursEnabled: branches.workingHoursEnabled,
        roomCount: sql<number>`(select count(*)::int from kliniva.rooms r where r.tenant_id = kliniva.branches.tenant_id and r.branch_id = kliniva.branches.id and r.active)`,
        doctorCount: sql<number>`(select count(*)::int from kliniva.doctor_branches db join kliniva.doctor_profiles dp on dp.id = db.doctor_id and dp.tenant_id = db.tenant_id where db.tenant_id = kliniva.branches.tenant_id and db.branch_id = kliniva.branches.id and db.active and dp.active)`,
        openDays: sql<number>`(select count(*)::int from kliniva.branch_working_hours h where h.tenant_id = kliniva.branches.tenant_id and h.branch_id = kliniva.branches.id and h.enabled)`,
      })
      .from(branches)
      .where(tenantWhere(branches, scope, branchFilter(ctx, branches.id)))
      .orderBy(asc(branches.name));
    return rows;
  });
}

export async function getBranch(ctx: AuthContext, rawId: unknown) {
  requirePermission(ctx, "branch.read");
  const id = parseId(rawId);
  if (!canAccessBranch(ctx, id)) throw new AppError("NOT_FOUND");
  return tenantQuery(ctx, async (scope) => {
    const [row] = await scope.tx
      .select()
      .from(branches)
      .where(tenantWhere(branches, scope, eq(branches.id, id)));
    if (!row) throw new AppError("NOT_FOUND");
    const hours = await scope.tx
      .select()
      .from(branchWorkingHours)
      .where(tenantWhere(branchWorkingHours, scope, eq(branchWorkingHours.branchId, id)))
      .orderBy(asc(branchWorkingHours.dayOfWeek));
    return { ...row, hours };
  });
}

export async function createBranch(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requireTenantWideManager(ctx);
  const data = parseInput(branchInputSchema, input);
  return tenantQuery(ctx, async (scope) => {
    const [row] = await scope.tx
      .insert(branches)
      .values({ ...data, tenantId: scope.tenantId })
      .returning({ id: branches.id })
      .catch((e) => mapUnique(e, "code"));
    await writeAudit(scope, actorOf(ctx), {
      action: "BRANCH_CREATED",
      entityType: "branch",
      entityId: row!.id,
      branchId: row!.id,
    });
    return { id: row!.id };
  });
}

export async function updateBranch(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requireTenantWideManager(ctx);
  const id = parseId(rawId);
  const data = parseInput(branchInputSchema.partial(), input);
  await tenantQuery(ctx, async (scope) => {
    const res = await scope.tx
      .update(branches)
      .set({ ...data, code: clearable(input, "code", data.code) })
      .where(tenantWhere(branches, scope, eq(branches.id, id)))
      .returning({ id: branches.id })
      .catch((e) => mapUnique(e, "code"));
    if (!res.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "BRANCH_UPDATED",
      entityType: "branch",
      entityId: id,
      branchId: id,
      metadata: { fields: Object.keys(data).join(",") },
    });
  });
}

export async function setBranchActive(ctx: AuthContext, rawId: unknown, active: boolean): Promise<void> {
  requireTenantWideManager(ctx);
  const id = parseId(rawId);
  await tenantQuery(ctx, async (scope) => {
    const res = await scope.tx
      .update(branches)
      .set({ active })
      .where(tenantWhere(branches, scope, eq(branches.id, id)))
      .returning({ id: branches.id });
    if (!res.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: active ? "BRANCH_UPDATED" : "BRANCH_DEACTIVATED",
      entityType: "branch",
      entityId: id,
      branchId: id,
      metadata: { active },
    });
  });
}

/** 7 günün tamamı tek seferde yazılır (şube + gün benzersiz). */
export async function setBranchWorkingHours(
  ctx: AuthContext,
  rawId: unknown,
  input: { enabled: unknown; days: unknown },
): Promise<void> {
  requireTenantWideManager(ctx);
  const id = parseId(rawId);
  const days = parseInput(branchHoursSchema, input.days);
  const enabled = parseInput(boolish, input.enabled);
  await tenantQuery(ctx, async (scope) => {
    const res = await scope.tx
      .update(branches)
      .set({ workingHoursEnabled: enabled })
      .where(tenantWhere(branches, scope, eq(branches.id, id)))
      .returning({ id: branches.id });
    if (!res.length) throw new AppError("NOT_FOUND");
    for (const d of days) {
      const values = {
        tenantId: scope.tenantId,
        branchId: id,
        dayOfWeek: d.dayOfWeek,
        enabled: d.enabled,
        startTime: d.enabled ? d.startTime! : null,
        endTime: d.enabled ? d.endTime! : null,
      };
      await scope.tx
        .insert(branchWorkingHours)
        .values(values)
        .onConflictDoUpdate({
          target: [branchWorkingHours.branchId, branchWorkingHours.dayOfWeek],
          set: { enabled: values.enabled, startTime: values.startTime, endTime: values.endTime },
        });
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "BRANCH_WORKING_HOURS_UPDATED",
      entityType: "branch",
      entityId: id,
      branchId: id,
      metadata: { enabled, openDays: days.filter((d) => d.enabled).length },
    });
  });
}

// ---------------------------------------------------------------- şube kapanışları

export async function listBranchClosures(ctx: AuthContext, rawBranchId: unknown, fromDate?: string) {
  requirePermission(ctx, "branch.read");
  const branchId = parseId(rawBranchId);
  if (!canAccessBranch(ctx, branchId)) throw new AppError("NOT_FOUND");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select()
      .from(branchClosures)
      .where(
        tenantWhere(
          branchClosures,
          scope,
          eq(branchClosures.branchId, branchId),
          fromDate && isValidDate(fromDate) ? sql`${branchClosures.date} >= ${fromDate}` : undefined,
        ),
      )
      .orderBy(asc(branchClosures.date)),
  );
}

export async function createBranchClosure(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requireTenantWideManager(ctx);
  const data = parseInput(branchClosureSchema, input);
  return tenantQuery(ctx, async (scope) => {
    await assertBranch(scope, data.branchId);
    const [row] = await scope.tx
      .insert(branchClosures)
      .values({
        tenantId: scope.tenantId,
        branchId: data.branchId,
        date: data.date,
        allDay: data.allDay,
        startTime: data.allDay ? null : data.startTime!,
        endTime: data.allDay ? null : data.endTime!,
        reason: data.reason ?? null,
      })
      .returning({ id: branchClosures.id });
    await writeAudit(scope, actorOf(ctx), {
      action: "BRANCH_CLOSURE_CREATED",
      entityType: "branch_closure",
      entityId: row!.id,
      branchId: data.branchId,
      metadata: { date: data.date, allDay: data.allDay },
    });
    return { id: row!.id };
  });
}

export async function deleteBranchClosure(ctx: AuthContext, rawId: unknown): Promise<void> {
  requireTenantWideManager(ctx);
  const id = parseId(rawId);
  await tenantQuery(ctx, async (scope) => {
    const res = await scope.tx
      .delete(branchClosures)
      .where(tenantWhere(branchClosures, scope, eq(branchClosures.id, id)))
      .returning({ branchId: branchClosures.branchId });
    if (!res.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "BRANCH_CLOSURE_DELETED",
      entityType: "branch_closure",
      entityId: id,
      branchId: res[0]!.branchId,
    });
  });
}

async function assertBranch(scope: TenantScope, branchId: string) {
  const [b] = await scope.tx
    .select({ id: branches.id })
    .from(branches)
    .where(tenantWhere(branches, scope, eq(branches.id, branchId)));
  if (!b) throw new AppError("NOT_FOUND");
}

// ---------------------------------------------------------------- odalar

export async function listRooms(
  ctx: AuthContext,
  opts: { branchId?: string; includeInactive?: boolean } = {},
) {
  requirePermission(ctx, "room.read");
  const branchId = opts.branchId && uuidSchema.safeParse(opts.branchId).success ? opts.branchId : undefined;
  if (branchId && !canAccessBranch(ctx, branchId)) return [];
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({
        id: rooms.id,
        branchId: rooms.branchId,
        branchName: branches.name,
        name: rooms.name,
        code: rooms.code,
        type: rooms.type,
        floor: rooms.floor,
        description: rooms.description,
        active: rooms.active,
      })
      .from(rooms)
      .innerJoin(branches, and(eq(branches.id, rooms.branchId), eq(branches.tenantId, rooms.tenantId)))
      .where(
        tenantWhere(
          rooms,
          scope,
          branchFilter(ctx, rooms.branchId),
          branchId ? eq(rooms.branchId, branchId) : undefined,
          opts.includeInactive ? undefined : eq(rooms.active, true),
        ),
      )
      .orderBy(asc(branches.name), asc(rooms.name)),
  );
}

export async function createRoom(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "room.manage");
  const data = parseInput(roomInputSchema, input);
  requireBranchAccess(ctx, data.branchId);
  return tenantQuery(ctx, async (scope) => {
    // Bileşik FK (tenant_id, branch_id) başka kiracının şubesine oda eklemeyi DB seviyesinde de engeller;
    // burada da açıkça kontrol edilir ki hata "bulunamadı" olarak dönsün.
    await assertBranch(scope, data.branchId);
    const [row] = await scope.tx
      .insert(rooms)
      .values({ ...data, type: data.type ?? "OTHER", tenantId: scope.tenantId })
      .returning({ id: rooms.id })
      .catch((e) => mapUnique(e, "name"));
    await writeAudit(scope, actorOf(ctx), {
      action: "ROOM_CREATED",
      entityType: "room",
      entityId: row!.id,
      branchId: data.branchId,
    });
    return { id: row!.id };
  });
}

async function loadRoomForManage(scope: TenantScope, ctx: AuthContext, id: string) {
  const [room] = await scope.tx
    .select()
    .from(rooms)
    .where(tenantWhere(rooms, scope, eq(rooms.id, id)));
  if (!room || !canAccessBranch(ctx, room.branchId)) throw new AppError("NOT_FOUND");
  return room;
}

export async function updateRoom(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "room.manage");
  const id = parseId(rawId);
  // Oda başka şubeye taşınamaz (oda atamaları şubeye bağlıdır).
  const data = parseInput(roomInputSchema.omit({ branchId: true }).partial(), input);
  await tenantQuery(ctx, async (scope) => {
    const room = await loadRoomForManage(scope, ctx, id);
    await scope.tx
      .update(rooms)
      .set({ ...data, code: clearable(input, "code", data.code) })
      .where(tenantWhere(rooms, scope, eq(rooms.id, id)))
      .catch((e) => mapUnique(e, "name"));
    await writeAudit(scope, actorOf(ctx), {
      action: "ROOM_UPDATED",
      entityType: "room",
      entityId: id,
      branchId: room.branchId,
      metadata: { fields: Object.keys(data).join(",") },
    });
  });
}

export async function setRoomActive(ctx: AuthContext, rawId: unknown, active: boolean): Promise<void> {
  requirePermission(ctx, "room.manage");
  const id = parseId(rawId);
  await tenantQuery(ctx, async (scope) => {
    const room = await loadRoomForManage(scope, ctx, id);
    await scope.tx
      .update(rooms)
      .set({ active })
      .where(tenantWhere(rooms, scope, eq(rooms.id, id)));
    await writeAudit(scope, actorOf(ctx), {
      action: active ? "ROOM_UPDATED" : "ROOM_DEACTIVATED",
      entityType: "room",
      entityId: id,
      branchId: room.branchId,
      metadata: { active },
    });
  });
}

/** Seçim listeleri için: kullanıcının erişebildiği aktif şubeler. */
export async function accessibleBranchOptions(ctx: AuthContext) {
  requirePermission(ctx, "branch.read");
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({ id: branches.id, name: branches.name, timezone: branches.timezone })
      .from(branches)
      .where(tenantWhere(branches, scope, branchFilter(ctx, branches.id), eq(branches.active, true)))
      .orderBy(asc(branches.name)),
  );
}
