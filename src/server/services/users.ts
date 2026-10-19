import "server-only";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { branches, permissions, rolePermissions, roles, userRoles, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import { actorOf, requirePermission, type AuthContext } from "@/server/auth/authz";
import { ROLE_KEYS, type Permission, type RoleKey } from "@/server/auth/permissions";
import { revokeAllUserSessions } from "@/server/auth/session";
import { hashPassword, passwordPolicy } from "@/server/security/password";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { emailSchema, nameSchema, normalizeEmail, phoneSchema, uuidSchema } from "@/server/validation";
import { parseInput } from "@/server/services/parse";
import { usernameSchema } from "@/server/auth/login-id";

/**
 * Kullanıcı ve rol yönetimi.
 * Yetki yükseltme koruması: bir kullanıcı yalnızca KENDİ sahip olduğu yetkilerin alt kümesini içeren rolleri
 * atayabilir; kiracı geneli atama yalnızca kiracı geneli kullanıcıya açıktır; PLATFORM_SUPER_ADMIN kiracı
 * içinden hiçbir zaman atanamaz.
 */
const roleAssignmentSchema = z.object({
  roleKey: z.enum(ROLE_KEYS),
  branchId: z.preprocess((v) => (v === "" ? null : v), uuidSchema.nullable()),
});

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
export const createUserSchema = z
  .object({
    email: z.preprocess(blankToUndefined, emailSchema.optional()),
    username: z.preprocess(blankToUndefined, usernameSchema.optional()),
    firstName: nameSchema,
    lastName: nameSchema,
    phone: z.preprocess((v) => (v === "" ? undefined : v), phoneSchema.optional()),
    password: passwordPolicy,
    roles: z.array(roleAssignmentSchema).min(1).max(10),
  })
  .refine((d) => d.email || d.username, {
    message: "E-posta ya da kullanıcı adı girin.",
    path: ["username"],
  });

export async function listUsers(ctx: AuthContext) {
  requirePermission(ctx, "user.read");
  return tenantQuery(ctx, async (scope) => {
    const rows = await scope.tx
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        active: users.active,
        twoFactorEnabled: users.twoFactorEnabled,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(tenantWhere(users, scope))
      .orderBy(asc(users.lastName));
    const assignments = await scope.tx
      .select({ userId: userRoles.userId, roleKey: roles.key, branchId: userRoles.branchId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(tenantWhere(userRoles, scope));
    return rows.map((u) => ({
      ...u,
      roles: assignments
        .filter((a) => a.userId === u.id)
        .map((a) => ({ roleKey: a.roleKey, branchId: a.branchId })),
    }));
  });
}

export async function resolveAssignableRoles(
  scope: TenantScope,
  ctx: AuthContext,
  assignments: { roleKey: RoleKey; branchId: string | null }[],
) {
  const keys = [...new Set(assignments.map((a) => a.roleKey))];
  if (keys.includes("PLATFORM_SUPER_ADMIN")) throw new AppError("FORBIDDEN");

  const rows = await scope.tx
    .select({ id: roles.id, key: roles.key, permission: permissions.key })
    .from(roles)
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(inArray(roles.key, keys), or(isNull(roles.tenantId), eq(roles.tenantId, scope.tenantId))));

  const roleIds = new Map<string, string>();
  for (const r of rows) {
    roleIds.set(r.key, r.id);
    if (r.permission && !ctx.permissions.has(r.permission as Permission)) throw new AppError("FORBIDDEN");
  }
  if (roleIds.size !== keys.length) throw new AppError("VALIDATION", { fields: ["roles"] });

  const branchIds = [...new Set(assignments.map((a) => a.branchId).filter((b): b is string => !!b))];
  for (const a of assignments) {
    if (a.branchId === null && !ctx.branchScope.all) throw new AppError("FORBIDDEN");
    if (a.branchId && !ctx.branchScope.all && !ctx.branchScope.branchIds.has(a.branchId)) {
      throw new AppError("FORBIDDEN");
    }
  }
  if (branchIds.length) {
    const found = await scope.tx
      .select({ id: branches.id })
      .from(branches)
      .where(tenantWhere(branches, scope, inArray(branches.id, branchIds)));
    if (found.length !== branchIds.length) throw new AppError("NOT_FOUND");
  }
  return assignments.map((a) => ({ roleId: roleIds.get(a.roleKey)!, branchId: a.branchId }));
}

export async function createUser(ctx: AuthContext, input: unknown): Promise<{ id: string }> {
  requirePermission(ctx, "user.manage");
  const data = parseInput(createUserSchema, input);
  const passwordHash = await hashPassword(data.password);
  return tenantQuery(ctx, async (scope) => {
    const resolved = await resolveAssignableRoles(scope, ctx, data.roles);
    const emailNormalized = data.email ? normalizeEmail(data.email) : null;
    const usernameNormalized = data.username ?? null;
    if (emailNormalized) {
      const [existing] = await scope.tx
        .select({ id: users.id })
        .from(users)
        .where(tenantWhere(users, scope, eq(users.emailNormalized, emailNormalized)));
      if (existing) throw new AppError("CONFLICT", { fields: ["email"] });
    }
    if (usernameNormalized) {
      const [existing] = await scope.tx
        .select({ id: users.id })
        .from(users)
        .where(tenantWhere(users, scope, eq(users.usernameNormalized, usernameNormalized)));
      if (existing) {
        throw new AppError("CONFLICT", { fields: ["username"], message: "Bu kullanıcı adı kullanılıyor." });
      }
    }

    const [user] = await scope.tx
      .insert(users)
      .values({
        tenantId: scope.tenantId,
        email: data.email?.trim() ?? null,
        emailNormalized,
        username: usernameNormalized,
        usernameNormalized,
        passwordHash,
        // Yönetici tarafından verilen parola geçicidir: kullanıcı ilk girişte değiştirir.
        mustChangePassword: true,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone ?? null,
      })
      .returning({ id: users.id });
    await scope.tx
      .insert(userRoles)
      .values(resolved.map((r) => ({ tenantId: scope.tenantId, userId: user!.id, ...r })));

    const actor = actorOf(ctx);
    await writeAudit(scope, actor, { action: "USER_CREATED", entityType: "user", entityId: user!.id });
    await writeAudit(scope, actor, {
      action: "PERMISSION_CHANGED",
      entityType: "user",
      entityId: user!.id,
      metadata: { roles: data.roles.map((r) => r.roleKey).join(",") },
    });
    return { id: user!.id };
  });
}

export async function setUserRoles(ctx: AuthContext, rawUserId: unknown, input: unknown): Promise<void> {
  requirePermission(ctx, "user.manage");
  const userId = uuidSchema.safeParse(rawUserId);
  if (!userId.success) throw new AppError("NOT_FOUND");
  const assignments = parseInput(z.array(roleAssignmentSchema).min(1).max(10), input);
  if (userId.data === ctx.userId) throw new AppError("FORBIDDEN"); // kendi yetkisini değiştiremez
  await tenantQuery(ctx, async (scope) => {
    const [target] = await scope.tx
      .select({ id: users.id })
      .from(users)
      .where(tenantWhere(users, scope, eq(users.id, userId.data)));
    if (!target) throw new AppError("NOT_FOUND");
    const resolved = await resolveAssignableRoles(scope, ctx, assignments);
    await scope.tx.delete(userRoles).where(tenantWhere(userRoles, scope, eq(userRoles.userId, target.id)));
    await scope.tx
      .insert(userRoles)
      .values(resolved.map((r) => ({ tenantId: scope.tenantId, userId: target.id, ...r })));
    await writeAudit(scope, actorOf(ctx), {
      action: "PERMISSION_CHANGED",
      entityType: "user",
      entityId: target.id,
      metadata: { roles: assignments.map((r) => r.roleKey).join(",") },
    });
  });
}

export async function setUserActive(ctx: AuthContext, rawUserId: unknown, active: boolean): Promise<void> {
  requirePermission(ctx, "user.manage");
  const userId = uuidSchema.safeParse(rawUserId);
  if (!userId.success) throw new AppError("NOT_FOUND");
  if (userId.data === ctx.userId) throw new AppError("FORBIDDEN");
  await tenantQuery(ctx, async (scope) => {
    const res = await scope.tx
      .update(users)
      .set({ active })
      .where(tenantWhere(users, scope, eq(users.id, userId.data)))
      .returning({ id: users.id });
    if (!res.length) throw new AppError("NOT_FOUND");
    await writeAudit(scope, actorOf(ctx), {
      action: "PERMISSION_CHANGED",
      entityType: "user",
      entityId: userId.data,
      metadata: { active },
    });
  });
  if (!active) await revokeAllUserSessions(ctx.tenantId, userId.data);
}

/**
 * Kullanıcıya (yoksa) rol ekler — aynı yetki yükseltme kuralı (resolveAssignableRoles) uygulanır.
 * Doktor oluşturma akışı tarafından kullanılır; çağıran transaction içinde çalışır.
 */
export async function ensureUserRoleInScope(
  scope: TenantScope,
  ctx: AuthContext,
  userId: string,
  roleKey: RoleKey,
): Promise<boolean> {
  const [existing] = await scope.tx
    .select({ id: userRoles.id })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(tenantWhere(userRoles, scope, eq(userRoles.userId, userId), eq(roles.key, roleKey)));
  if (existing) return false;
  const [resolved] = await resolveAssignableRoles(scope, ctx, [{ roleKey, branchId: null }]);
  await scope.tx.insert(userRoles).values({ tenantId: scope.tenantId, userId, ...resolved! });
  await writeAudit(scope, actorOf(ctx), {
    action: "PERMISSION_CHANGED",
    entityType: "user",
    entityId: userId,
    metadata: { addedRole: roleKey },
  });
  return true;
}
