import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  branches,
  doctorBranches,
  doctorProfiles,
  doctorRoomAssignments,
  doctorWorkingHours,
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
import { createUser, ensureUserRoleInScope } from "@/server/services/users";
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { emailSchema, nameSchema, phoneSchema, uuidSchema } from "@/server/validation";
import { passwordPolicy } from "@/server/security/password";

/**
 * Doktor profili (kullanıcıdan ayrı) ve doktor ↔ şube ataması.
 *
 * Yetki:
 *  - doctor.read: liste/profil. Şube kapsamlı kullanıcı yalnızca kendi şubesine atanmış doktorları görür.
 *  - doctor.manage (+ kiracı geneli kapsam): profil oluşturma/düzenleme, şube atama/kaldırma.
 *  - Yeni doktor KULLANICISI oluşturmak / mevcut kullanıcıya DOCTOR rolü eklemek mevcut yetki yükseltme kuralına
 *    tabidir: DOCTOR rolünün yetkileri (hasta sağlık verisi dahil) çağıranda yoksa reddedilir. Böylece sağlık
 *    verisine erişimi olmayan bir yönetici, kendine "doktor hesabı" açarak sağlık verisine ulaşamaz.
 */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
const duration = z.preprocess(
  (v) => (v === "" || v === undefined ? undefined : Number(v)),
  z.number().int().min(5).max(480).optional(),
);

export const doctorProfileSchema = z.object({
  title: optText(40),
  specialty: z.string().trim().min(2).max(120),
  subSpecialty: optText(120),
  licenseNumber: optText(60),
  bio: optText(2000),
  defaultAppointmentDurationMinutes: duration,
});

export const createDoctorSchema = z.discriminatedUnion("mode", [
  doctorProfileSchema.extend({ mode: z.literal("existing"), userId: uuidSchema }),
  doctorProfileSchema.extend({
    mode: z.literal("new"),
    email: emailSchema,
    firstName: nameSchema,
    lastName: nameSchema,
    phone: z.preprocess(blank, phoneSchema.optional()),
    password: passwordPolicy,
  }),
]);

export type DoctorListItem = {
  id: string;
  userId: string;
  displayName: string;
  title: string | null;
  specialty: string;
  active: boolean;
  branches: { id: string; name: string; active: boolean }[];
  workingDays: number[];
};

export const doctorDisplayName = (d: { title: string | null; firstName: string; lastName: string }) =>
  `${d.title ? `${d.title} ` : ""}${d.firstName} ${d.lastName}`;

function parseId(raw: unknown): string {
  const id = uuidSchema.safeParse(raw);
  if (!id.success) throw new AppError("NOT_FOUND");
  return id.data;
}

function requireDoctorManager(ctx: AuthContext) {
  requirePermission(ctx, "doctor.manage");
  if (!ctx.branchScope.all) throw new AppError("FORBIDDEN");
}

/**
 * Doktor bu kullanıcıya görünür mü? Kiracı geneli kullanıcı: evet. Şube kapsamlı: doktor, kullanıcının
 * şubelerinden en az birine atanmış olmalı. Görünmüyorsa NOT_FOUND (varlık sızdırılmaz).
 */
export async function loadVisibleDoctor(scope: TenantScope, ctx: AuthContext, doctorId: string) {
  const [row] = await scope.tx
    .select({
      id: doctorProfiles.id,
      userId: doctorProfiles.userId,
      title: doctorProfiles.title,
      specialty: doctorProfiles.specialty,
      subSpecialty: doctorProfiles.subSpecialty,
      licenseNumber: doctorProfiles.licenseNumber,
      bio: doctorProfiles.bio,
      defaultAppointmentDurationMinutes: doctorProfiles.defaultAppointmentDurationMinutes,
      active: doctorProfiles.active,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(doctorProfiles)
    .innerJoin(users, and(eq(users.id, doctorProfiles.userId), eq(users.tenantId, doctorProfiles.tenantId)))
    .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.id, doctorId)));
  if (!row) throw new AppError("NOT_FOUND");
  const assigned = await scope.tx
    .select({
      id: branches.id,
      name: branches.name,
      active: doctorBranches.active,
      timezone: branches.timezone,
    })
    .from(doctorBranches)
    .innerJoin(
      branches,
      and(eq(branches.id, doctorBranches.branchId), eq(branches.tenantId, doctorBranches.tenantId)),
    )
    .where(tenantWhere(doctorBranches, scope, eq(doctorBranches.doctorId, doctorId)))
    .orderBy(asc(branches.name));
  const isSelf = row.userId === ctx.userId;
  const visibleBranches = assigned.filter((b) => canAccessBranch(ctx, b.id));
  if (!ctx.branchScope.all && !visibleBranches.length && !isSelf) throw new AppError("NOT_FOUND");
  return {
    ...row,
    displayName: doctorDisplayName(row),
    branches: isSelf ? assigned : visibleBranches,
    isSelf,
  };
}

export async function listDoctors(ctx: AuthContext): Promise<DoctorListItem[]> {
  requirePermission(ctx, "doctor.read");
  return tenantQuery(ctx, async (scope) => {
    const rows = await scope.tx
      .select({
        id: doctorProfiles.id,
        userId: doctorProfiles.userId,
        title: doctorProfiles.title,
        specialty: doctorProfiles.specialty,
        active: doctorProfiles.active,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(doctorProfiles)
      .innerJoin(users, and(eq(users.id, doctorProfiles.userId), eq(users.tenantId, doctorProfiles.tenantId)))
      .where(tenantWhere(doctorProfiles, scope))
      .orderBy(asc(users.lastName), asc(users.firstName));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const links = await scope.tx
      .select({
        doctorId: doctorBranches.doctorId,
        id: branches.id,
        name: branches.name,
        active: doctorBranches.active,
      })
      .from(doctorBranches)
      .innerJoin(
        branches,
        and(eq(branches.id, doctorBranches.branchId), eq(branches.tenantId, doctorBranches.tenantId)),
      )
      .where(tenantWhere(doctorBranches, scope, inArray(doctorBranches.doctorId, ids)));
    const days = await scope.tx
      .select({
        doctorId: doctorWorkingHours.doctorId,
        branchId: doctorWorkingHours.branchId,
        day: doctorWorkingHours.dayOfWeek,
      })
      .from(doctorWorkingHours)
      .where(
        tenantWhere(
          doctorWorkingHours,
          scope,
          inArray(doctorWorkingHours.doctorId, ids),
          eq(doctorWorkingHours.active, true),
        ),
      );

    return rows
      .map((r) => {
        const bs = links.filter((l) => l.doctorId === r.id && canAccessBranch(ctx, l.id));
        return {
          id: r.id,
          userId: r.userId,
          displayName: doctorDisplayName(r),
          title: r.title,
          specialty: r.specialty,
          active: r.active,
          branches: bs.map(({ id, name, active }) => ({ id, name, active })),
          workingDays: [
            ...new Set(
              days.filter((d) => d.doctorId === r.id && canAccessBranch(ctx, d.branchId)).map((d) => d.day),
            ),
          ].sort(),
        };
      })
      .filter((d) => ctx.branchScope.all || d.branches.length > 0);
  });
}

export async function getDoctor(ctx: AuthContext, rawId: unknown) {
  const id = parseId(rawId);
  return tenantQuery(ctx, async (scope) => {
    const doctor = await loadVisibleDoctor(scope, ctx, id);
    if (!hasPermission(ctx, "doctor.read") && !(doctor.isSelf && hasPermission(ctx, "doctor.self.read"))) {
      throw new AppError("FORBIDDEN");
    }
    return doctor;
  });
}

/** DOCTOR rolüne sahip, henüz doktor profili olmayan kullanıcılar (mevcut kullanıcıyı doktor yapma). */
export async function listDoctorCandidates(ctx: AuthContext) {
  requireDoctorManager(ctx);
  return tenantQuery(ctx, (scope) =>
    scope.tx
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        isDoctorRole: sql<boolean>`exists (select 1 from kliniva.user_roles ur join kliniva.roles r on r.id = ur.role_id where ur.tenant_id = kliniva.users.tenant_id and ur.user_id = kliniva.users.id and r.key = 'DOCTOR')`,
      })
      .from(users)
      .where(
        tenantWhere(
          users,
          scope,
          eq(users.active, true),
          sql`not exists (select 1 from kliniva.doctor_profiles dp where dp.tenant_id = kliniva.users.tenant_id and dp.user_id = kliniva.users.id)`,
        ),
      )
      .orderBy(asc(users.lastName)),
  );
}

export async function createDoctor(
  ctx: AuthContext,
  input: unknown,
): Promise<{ id: string; userId: string }> {
  requireDoctorManager(ctx);
  const data = parseInput(createDoctorSchema, input);
  let userId: string;
  if (data.mode === "new") {
    // Kullanıcı + DOCTOR rolü (yetki yükseltme kuralı createUser içinde uygulanır). Profil girdisi zaten doğrulandı.
    userId = (
      await createUser(ctx, {
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        password: data.password,
        roles: [{ roleKey: "DOCTOR", branchId: null }],
      })
    ).id;
  } else {
    userId = data.userId;
  }

  return tenantQuery(ctx, async (scope) => {
    const [user] = await scope.tx
      .select({ id: users.id, active: users.active })
      .from(users)
      .where(tenantWhere(users, scope, eq(users.id, userId)));
    if (!user || !user.active) throw new AppError("NOT_FOUND");
    // DoctorProfile yalnızca DOCTOR rolündeki kullanıcı için; rol yoksa (yetki kuralıyla) eklenir.
    await ensureUserRoleInScope(scope, ctx, userId, "DOCTOR");
    const [row] = await scope.tx
      .insert(doctorProfiles)
      .values({
        tenantId: scope.tenantId,
        userId,
        title: data.title ?? null,
        specialty: data.specialty,
        subSpecialty: data.subSpecialty ?? null,
        licenseNumber: data.licenseNumber ?? null,
        bio: data.bio ?? null,
        defaultAppointmentDurationMinutes: data.defaultAppointmentDurationMinutes ?? 30,
      })
      .returning({ id: doctorProfiles.id })
      .catch((e) => {
        if (pgErrorInfo(e).code === PG_UNIQUE_VIOLATION) {
          throw new AppError("CONFLICT", { message: "Bu kullanıcının zaten bir doktor profili var." });
        }
        throw e;
      });
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_CREATED",
      entityType: "doctor",
      entityId: row!.id,
      metadata: { userId, mode: data.mode },
    });
    return { id: row!.id, userId };
  });
}

export async function updateDoctor(ctx: AuthContext, rawId: unknown, input: unknown): Promise<void> {
  requireDoctorManager(ctx);
  const id = parseId(rawId);
  const data = parseInput(doctorProfileSchema.partial().extend({ active: z.boolean().optional() }), input);
  await tenantQuery(ctx, async (scope) => {
    const res = await scope.tx
      .update(doctorProfiles)
      .set(data)
      .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.id, id)))
      .returning({ id: doctorProfiles.id });
    if (!res.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_UPDATED",
      entityType: "doctor",
      entityId: id,
      metadata: { fields: Object.keys(data).join(",") },
    });
  });
}

export async function assignDoctorBranch(
  ctx: AuthContext,
  rawDoctorId: unknown,
  rawBranchId: unknown,
): Promise<void> {
  requireDoctorManager(ctx);
  const doctorId = parseId(rawDoctorId);
  const branchId = parseId(rawBranchId);
  await tenantQuery(ctx, async (scope) => {
    const [doctor] = await scope.tx
      .select({ id: doctorProfiles.id })
      .from(doctorProfiles)
      .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.id, doctorId)));
    const [branch] = await scope.tx
      .select({ id: branches.id })
      .from(branches)
      .where(tenantWhere(branches, scope, eq(branches.id, branchId)));
    // Başka kiracının doktoru/şubesi bu kapsamda görünmez → NOT_FOUND (ayrıca bileşik FK DB'de engeller).
    if (!doctor || !branch) throw new AppError("NOT_FOUND");
    await scope.tx
      .insert(doctorBranches)
      .values({ tenantId: scope.tenantId, doctorId, branchId })
      .onConflictDoUpdate({
        target: [doctorBranches.doctorId, doctorBranches.branchId],
        set: { active: true },
      });
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_BRANCH_ASSIGNED",
      entityType: "doctor",
      entityId: doctorId,
      branchId,
    });
  });
}

/** Şube bağını kaldırır; o şubedeki çalışma blokları ve oda atamaları da (FK CASCADE) silinir — sayılar audit'e yazılır. */
export async function removeDoctorBranch(
  ctx: AuthContext,
  rawDoctorId: unknown,
  rawBranchId: unknown,
): Promise<void> {
  requireDoctorManager(ctx);
  const doctorId = parseId(rawDoctorId);
  const branchId = parseId(rawBranchId);
  await tenantQuery(ctx, async (scope) => {
    const [hours] = await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(doctorWorkingHours)
      .where(
        tenantWhere(
          doctorWorkingHours,
          scope,
          eq(doctorWorkingHours.doctorId, doctorId),
          eq(doctorWorkingHours.branchId, branchId),
        ),
      );
    const [assignments] = await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(doctorRoomAssignments)
      .where(
        tenantWhere(
          doctorRoomAssignments,
          scope,
          eq(doctorRoomAssignments.doctorId, doctorId),
          eq(doctorRoomAssignments.branchId, branchId),
        ),
      );
    const res = await scope.tx
      .delete(doctorBranches)
      .where(
        tenantWhere(
          doctorBranches,
          scope,
          eq(doctorBranches.doctorId, doctorId),
          eq(doctorBranches.branchId, branchId),
        ),
      )
      .returning({ id: doctorBranches.id });
    if (!res.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "DOCTOR_BRANCH_REMOVED",
      entityType: "doctor",
      entityId: doctorId,
      branchId,
      metadata: { removedWorkingHours: hours?.n ?? 0, removedRoomAssignments: assignments?.n ?? 0 },
    });
  });
}

/** Doktor portalı: oturumdaki kullanıcının doktor profili (yoksa NOT_FOUND). */
export async function loadSelfDoctorId(scope: TenantScope, ctx: AuthContext): Promise<string> {
  const [row] = await scope.tx
    .select({ id: doctorProfiles.id })
    .from(doctorProfiles)
    .where(tenantWhere(doctorProfiles, scope, eq(doctorProfiles.userId, ctx.userId)));
  if (!row) throw new AppError("NOT_FOUND");
  return row.id;
}
