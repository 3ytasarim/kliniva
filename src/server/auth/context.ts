import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { permissions, rolePermissions, roles, tenants, userRoles, users } from "@/server/db/schema";
import { runInTenant } from "@/server/tenant/tenant-query";
import { resolveSession, revokeSessionById } from "@/server/auth/session";
import type { AuthContext } from "@/server/auth/authz";
import type { Permission, RoleKey } from "@/server/auth/permissions";
import type { RequestMeta } from "@/server/security/request-meta";

/**
 * Oturum token'ından AuthContext üretir. Her istekte yeniden hesaplanır: rol/yetki değişikliği, kullanıcının
 * pasifleştirilmesi veya kiracının askıya alınması bir sonraki istekte hemen etkili olur.
 *
 * MFA bekleyen oturum (MFA_PENDING) hiçbir korunan kaynağa erişemez → null.
 */
export async function authenticate(
  token: string | null | undefined,
  meta: RequestMeta,
): Promise<AuthContext | null> {
  const session = await resolveSession(token);
  if (!session || session.state !== "ACTIVE") return null;
  return buildContext(session.id, session.tenantId, session.userId, meta);
}

export async function buildContext(
  sessionId: string,
  tenantId: string,
  userId: string,
  meta: RequestMeta,
): Promise<AuthContext | null> {
  const [tenant] = await getDb()
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant || tenant.status !== "ACTIVE") {
    await revokeSessionById(sessionId);
    return null;
  }

  const ctx = await runInTenant(tenantId, async (scope) => {
    const [user] = await scope.tx
      .select({
        id: users.id,
        active: users.active,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        twoFactorEnabled: users.twoFactorEnabled,
      })
      .from(users)
      .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, userId)));
    if (!user || !user.active) return null;

    const rows = await scope.tx
      .select({ roleKey: roles.key, branchId: userRoles.branchId, permission: permissions.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(and(eq(userRoles.tenantId, scope.tenantId), eq(userRoles.userId, userId)));

    const roleKeys = new Set<RoleKey>();
    const perms = new Set<Permission>();
    const branchIds = new Set<string>();
    let allBranches = false;
    for (const r of rows) {
      roleKeys.add(r.roleKey as RoleKey);
      if (r.permission) perms.add(r.permission as Permission);
      if (r.branchId) branchIds.add(r.branchId);
      else allBranches = true;
    }

    return {
      tenantId,
      userId,
      sessionId,
      roles: [...roleKeys],
      permissions: perms,
      branchScope: allBranches ? { all: true } : { all: false, branchIds },
      meta,
      user: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        twoFactorEnabled: user.twoFactorEnabled,
      },
    } satisfies AuthContext;
  });

  if (!ctx) await revokeSessionById(sessionId);
  return ctx;
}
