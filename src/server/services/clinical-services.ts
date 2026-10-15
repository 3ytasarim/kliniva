import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  branches,
  clinicalServices,
  doctorBranches,
  doctorProfiles,
  doctorServices,
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
import { doctorDisplayName, loadVisibleDoctor } from "@/server/services/doctors";
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { ROOM_TYPES } from "@/server/services/org";
import { uuidSchema } from "@/server/validation";

/**
 * Klinik hizmetleri (işlem tipleri) ve doktor ↔ hizmet eşleşmesi.
 * Randevu süresi: istek > doktor override'ı > hizmet varsayılanı. Oda gereksinimi ve izinli oda tipleri hizmetten gelir.
 */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const serviceInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.preprocess(blank, z.string().trim().max(30).optional()),
  description: z.preprocess(blank, z.string().trim().max(500).optional()),
  defaultDurationMinutes: z.coerce.number().int().min(5).max(480),
  requiresRoom: z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean()),
  allowedRoomTypes: z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]),
    z.array(z.enum(ROOM_TYPES)).max(ROOM_TYPES.length),
  ),
  active: z.preprocess(
    (v) => (v === undefined ? true : v === true || v === "on" || v === "true"),
    z.boolean(),
  ),
});

export const doctorServicesSchema = z.object({
  doctorId: uuidSchema,
  services: z
    .array(
      z.object({
        serviceId: uuidSchema,
        durationMinutesOverride: z.preprocess(blank, z.coerce.number().int().min(5).max(480).optional()),
      }),
    )
    .max(200),
});

function parseId(raw: unknown): string {
  const id = uuidSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND");
  return id.data;
}

const mapUnique = (e: unknown): never => {
  if (pgErrorInfo(e).code === PG_UNIQUE_VIOLATION) {
    throw new AppError("CONFLICT", { message: "Aynı ad veya kodla bir hizmet zaten var." });
  }
  throw e;
};

export type ClinicalServiceItem = {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  defaultDurationMinutes: number;
  requiresRoom: boolean;
  allowedRoomTypes: string[];
  active: boolean;
};

const serviceColumns = {
  id: clinicalServices.id,
  name: clinicalServices.name,
  code: clinicalServices.code,
  description: clinicalServices.description,
  defaultDurationMinutes: clinicalServices.defaultDurationMinutes,
  requiresRoom: clinicalServices.requiresRoom,
  allowedRoomTypes: clinicalServices.allowedRoomTypes,
  active: clinicalServices.active,
};

export async function listClinicalServices(
  ctx: AuthContext,
  opts: { activeOnly?: boolean } = {},
): Promise<ClinicalServiceItem[]> {
  requirePermission(ctx, "service.read");
  const rows = await tenantQuery(ctx, (scope) =>
    scope.tx
      .select(serviceColumns)
      .from(clinicalServices)
      .where(
        tenantWhere(clinicalServices, scope, opts.activeOnly ? eq(clinicalServices.active, true) : undefined),
      )
      .orderBy(asc(clinicalServices.name)),
  );
  return rows.map((r) => ({ ...r, allowedRoomTypes: r.allowedRoomTypes ?? [] }));
}

export async function createClinicalService(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "service.manage");
  const data = parseInput(serviceInputSchema, input);
  return tenantQuery(ctx, async (scope) => {
    const [row] = await scope.tx
      .insert(clinicalServices)
      .values({
        tenantId: scope.tenantId,
        name: data.name,
        code: data.code ?? null,
        description: data.description ?? null,
        defaultDurationMinutes: data.defaultDurationMinutes,
        requiresRoom: data.requiresRoom,
        allowedRoomTypes: data.allowedRoomTypes.length ? data.allowedRoomTypes : null,
        active: data.active,
      })
      .returning({ id: clinicalServices.id })
      .catch(mapUnique);
    await writeAudit(scope, actorOf(ctx), {
      action: "CLINICAL_SERVICE_CREATED",
      entityType: "clinical_service",
      entityId: row!.id,
      metadata: { durationMinutes: data.defaultDurationMinutes, requiresRoom: data.requiresRoom },
    });
    return { id: row!.id };
  });
}

export async function updateClinicalService(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "service.manage");
  const id = parseId(rawId);
  const data = parseInput(serviceInputSchema, input);
  await tenantQuery(ctx, async (scope) => {
    const updated = await scope.tx
      .update(clinicalServices)
      .set({
        name: data.name,
        code: data.code ?? null,
        description: data.description ?? null,
        defaultDurationMinutes: data.defaultDurationMinutes,
        requiresRoom: data.requiresRoom,
        allowedRoomTypes: data.allowedRoomTypes.length ? data.allowedRoomTypes : null,
        active: data.active,
        updatedAt: new Date(),
      })
      .where(tenantWhere(clinicalServices, scope, eq(clinicalServices.id, id)))
      .returning({ id: clinicalServices.id })
      .catch(mapUnique);
    if (!updated.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "CLINICAL_SERVICE_UPDATED",
      entityType: "clinical_service",
      entityId: id,
      metadata: { active: data.active, durationMinutes: data.defaultDurationMinutes },
    });
  });
}

export type DoctorServiceItem = ClinicalServiceItem & {
  durationMinutesOverride: number | null;
  effectiveDurationMinutes: number;
};

async function doctorServicesInScope(scope: TenantScope, doctorId: string): Promise<DoctorServiceItem[]> {
  const rows = await scope.tx
    .select({ ...serviceColumns, durationMinutesOverride: doctorServices.durationMinutesOverride })
    .from(doctorServices)
    .innerJoin(
      clinicalServices,
      and(
        eq(clinicalServices.id, doctorServices.serviceId),
        eq(clinicalServices.tenantId, doctorServices.tenantId),
      ),
    )
    .where(
      tenantWhere(
        doctorServices,
        scope,
        eq(doctorServices.doctorId, doctorId),
        eq(doctorServices.active, true),
      ),
    )
    .orderBy(asc(clinicalServices.name));
  return rows.map((r) => ({
    ...r,
    allowedRoomTypes: r.allowedRoomTypes ?? [],
    effectiveDurationMinutes: r.durationMinutesOverride ?? r.defaultDurationMinutes,
  }));
}

/** Doktorun verdiği (aktif) hizmetler. */
export async function listDoctorServices(
  ctx: AuthContext,
  rawDoctorId: unknown,
): Promise<DoctorServiceItem[]> {
  requirePermission(ctx, "service.read");
  const doctorId = parseId(rawDoctorId);
  return tenantQuery(ctx, async (scope) => {
    await loadVisibleDoctor(scope, ctx, doctorId);
    return doctorServicesInScope(scope, doctorId);
  });
}

/** Doktor-hizmet eşleşmesini verilen listeyle eşitler (listede olmayanlar pasifleşir — silinmez). */
export async function setDoctorServices(ctx: AuthContext, input: unknown): Promise<void> {
  requirePermission(ctx, "service.manage");
  const data = parseInput(doctorServicesSchema, input);
  await tenantQuery(ctx, async (scope) => {
    await loadVisibleDoctor(scope, ctx, data.doctorId);
    const ids = [...new Set(data.services.map((s) => s.serviceId))];
    if (ids.length) {
      const found = await scope.tx
        .select({ id: clinicalServices.id })
        .from(clinicalServices)
        .where(tenantWhere(clinicalServices, scope, inArray(clinicalServices.id, ids)));
      if (found.length !== ids.length) throw new AppError("NOT_FOUND");
    }
    await scope.tx
      .update(doctorServices)
      .set({ active: false, updatedAt: new Date() })
      .where(tenantWhere(doctorServices, scope, eq(doctorServices.doctorId, data.doctorId)));
    for (const s of data.services) {
      await scope.tx
        .insert(doctorServices)
        .values({
          tenantId: scope.tenantId,
          doctorId: data.doctorId,
          serviceId: s.serviceId,
          durationMinutesOverride: s.durationMinutesOverride ?? null,
          active: true,
        })
        .onConflictDoUpdate({
          target: [doctorServices.tenantId, doctorServices.doctorId, doctorServices.serviceId],
          set: {
            active: true,
            durationMinutesOverride: s.durationMinutesOverride ?? null,
            updatedAt: new Date(),
          },
        });
    }
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_SERVICES_UPDATED",
      entityType: "doctor_profile",
      entityId: data.doctorId,
      metadata: { serviceCount: ids.length },
    });
  });
}

export type BookableDoctor = { id: string; name: string; specialty: string };

/**
 * Randevu ekranı: şubede aktif olan (ve hizmet verildiyse o hizmeti veren) doktorlar. Kapsam dışı şube → boş.
 * Doktor rolü (yalnızca kendi randevuları) yalnızca kendini görür.
 */
export async function listBookableDoctors(
  ctx: AuthContext,
  input: { branchId: unknown; serviceId?: unknown },
): Promise<BookableDoctor[]> {
  if (!hasPermission(ctx, "appointment.availability.read")) requirePermission(ctx, "appointment.create");
  const branchId = parseId(input.branchId);
  if (!canAccessBranch(ctx, branchId)) return [];
  const serviceId = input.serviceId ? parseId(input.serviceId) : null;
  return tenantQuery(ctx, async (scope) => {
    const rows = await scope.tx
      .select({
        id: doctorProfiles.id,
        userId: doctorProfiles.userId,
        title: doctorProfiles.title,
        specialty: doctorProfiles.specialty,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(doctorBranches)
      .innerJoin(
        doctorProfiles,
        and(
          eq(doctorProfiles.id, doctorBranches.doctorId),
          eq(doctorProfiles.tenantId, doctorBranches.tenantId),
        ),
      )
      .innerJoin(users, and(eq(users.id, doctorProfiles.userId), eq(users.tenantId, doctorProfiles.tenantId)))
      .innerJoin(
        branches,
        and(eq(branches.id, doctorBranches.branchId), eq(branches.tenantId, doctorBranches.tenantId)),
      )
      .where(
        tenantWhere(
          doctorBranches,
          scope,
          eq(doctorBranches.branchId, branchId),
          eq(doctorBranches.active, true),
          eq(doctorProfiles.active, true),
          eq(branches.active, true),
        ),
      )
      .orderBy(asc(users.lastName), asc(users.firstName));
    let list = rows;
    if (!hasPermission(ctx, "appointment.read")) list = list.filter((r) => r.userId === ctx.userId);
    if (serviceId) {
      const offered = await scope.tx
        .select({ doctorId: doctorServices.doctorId })
        .from(doctorServices)
        .where(
          tenantWhere(
            doctorServices,
            scope,
            eq(doctorServices.serviceId, serviceId),
            eq(doctorServices.active, true),
          ),
        );
      const set = new Set(offered.map((o) => o.doctorId));
      list = list.filter((r) => set.has(r.id));
    }
    return list.map((r) => ({ id: r.id, name: doctorDisplayName(r), specialty: r.specialty }));
  });
}
