import "server-only";
import { inArray, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { AppError } from "@/server/errors";
import type { AuditActor } from "@/server/audit/audit";
import type { Permission, RoleKey } from "@/server/auth/permissions";
import type { RequestMeta } from "@/server/security/request-meta";

/**
 * Sunucuda doğrulanmış kimlik bağlamı. YALNIZCA authenticate() üretir (oturum token'ından).
 * tenantId istemciden asla alınmaz.
 */
export type BranchScope = { all: true } | { all: false; branchIds: ReadonlySet<string> };

export type AuthContext = {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly RoleKey[];
  readonly permissions: ReadonlySet<Permission>;
  readonly branchScope: BranchScope;
  readonly meta: RequestMeta;
  /**
   * İsteğin kanalı — YALNIZCA sunucu atar (sesli asistan araç yürütücüsü). Audit kaynağı ve randevu kaynağı buradan
   * türetilir; model / istemci bu alanı belirleyemez.
   */
  readonly channel?: "AI_VOICE" | "AI_CHAT";
  readonly user: { firstName: string; lastName: string; email: string; twoFactorEnabled: boolean };
};

export const hasPermission = (ctx: AuthContext, perm: Permission) => ctx.permissions.has(perm);

/** Yetki yoksa FORBIDDEN fırlatır. Her okuma/mutasyon servisinin ilk satırıdır. */
export function requirePermission(ctx: AuthContext, ...perms: Permission[]): void {
  for (const p of perms) {
    if (!ctx.permissions.has(p)) throw new AppError("FORBIDDEN");
  }
}

export function canAccessBranch(ctx: AuthContext, branchId: string | null | undefined): boolean {
  if (ctx.branchScope.all) return true;
  // Şube kapsamlı kullanıcı, şubesiz (kiracı geneli) kayıtları göremez.
  if (!branchId) return false;
  return ctx.branchScope.branchIds.has(branchId);
}

export function requireBranchAccess(ctx: AuthContext, branchId: string | null | undefined): void {
  if (!canAccessBranch(ctx, branchId)) throw new AppError("FORBIDDEN");
}

/** Liste sorgularına eklenecek şube filtresi (kiracı geneli kullanıcıda filtre yok). */
export function branchFilter(ctx: AuthContext, column: PgColumn): SQL | undefined {
  if (ctx.branchScope.all) return undefined;
  const ids = [...ctx.branchScope.branchIds];
  // Hiç şubesi olmayan şube-kapsamlı kullanıcı hiçbir şey görmez.
  return inArray(column, ids.length ? ids : ["00000000-0000-4000-8000-000000000000"]);
}

export function actorOf(ctx: AuthContext, source?: AuditActor["source"]): AuditActor {
  return {
    userId: ctx.userId,
    source: source ?? ctx.channel ?? "USER",
    meta: ctx.meta,
  };
}
