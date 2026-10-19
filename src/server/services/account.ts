import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import { actorOf, type AuthContext } from "@/server/auth/authz";
import { hashPassword, passwordPolicy, verifyPassword } from "@/server/security/password";
import { tenantQuery, tenantWhere } from "@/server/tenant/tenant-query";
import { parseInput } from "@/server/services/parse";
import { revokeOtherSessions } from "@/server/services/mfa";

/**
 * Kullanıcının kendi parolasını değiştirmesi (geçici parolayla ilk girişte zorunlu). Mevcut parola doğrulanır;
 * yeni parola politikaya uymalı ve eskisiyle aynı olmamalı. Diğer oturumlar iptal edilir.
 */
const changeInput = z
  .object({
    currentPassword: z.string().min(1, "Mevcut parolayı girin.").max(256),
    newPassword: passwordPolicy,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Yeni parolalar eşleşmiyor.",
    path: ["confirmPassword"],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: "Yeni parola mevcut paroladan farklı olmalı.",
    path: ["newPassword"],
  });

export async function changeOwnPassword(ctx: AuthContext, input: unknown): Promise<void> {
  const data = parseInput(changeInput, input);
  const newHash = await hashPassword(data.newPassword);
  await tenantQuery(ctx, async (scope) => {
    const [u] = await scope.tx
      .select({ hash: users.passwordHash })
      .from(users)
      .where(tenantWhere(users, scope, eq(users.id, ctx.userId)));
    if (!u) throw new AppError("NOT_FOUND");
    if (!(await verifyPassword(u.hash, data.currentPassword))) {
      throw new AppError("VALIDATION", { fields: ["currentPassword"], message: "Mevcut parola hatalı." });
    }
    await scope.tx
      .update(users)
      .set({
        passwordHash: newHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(tenantWhere(users, scope, eq(users.id, ctx.userId)));
    await writeAudit(scope, actorOf(ctx), {
      action: "PASSWORD_CHANGED",
      entityType: "user",
      entityId: ctx.userId,
      metadata: { wasTemporary: ctx.user.mustChangePassword },
    });
  });
  await revokeOtherSessions(ctx);
}
