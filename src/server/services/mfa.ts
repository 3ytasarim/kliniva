import "server-only";
import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { sessions, users } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { writeAudit } from "@/server/audit/audit";
import { actorOf, type AuthContext } from "@/server/auth/authz";
import { mfaSecretAad } from "@/server/auth/login";
import { decryptField, encryptField } from "@/server/security/crypto";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/server/security/totp";
import { tenantQuery, tenantWhere } from "@/server/tenant/tenant-query";

/**
 * TOTP tabanlı MFA kurulumu (kullanıcının kendisi için).
 *  1. startMfaEnrollment: yeni sır üretilir, ŞİFRELİ saklanır, two_factor_enabled = false kalır.
 *  2. confirmMfaEnrollment: kullanıcı uygulamadaki kodu girer → doğrulanırsa etkinleşir.
 * Etkin MFA'yı kapatma akışı bu sprintte YOK (bypass/arka kapı oluşturmamak için; Sprint 1'de yeniden doğrulama +
 * yönetici onayıyla eklenecek).
 */
export async function startMfaEnrollment(ctx: AuthContext): Promise<{ secret: string; uri: string }> {
  return tenantQuery(ctx, async (scope) => {
    const [user] = await scope.tx
      .select({ enabled: users.twoFactorEnabled, email: users.email, username: users.username })
      .from(users)
      .where(tenantWhere(users, scope, eq(users.id, ctx.userId)));
    if (!user) throw new AppError("NOT_FOUND");
    if (user.enabled) throw new AppError("CONFLICT");
    const secret = generateTotpSecret();
    await scope.tx
      .update(users)
      .set({
        twoFactorSecretEncrypted: encryptField(secret, mfaSecretAad(scope.tenantId, ctx.userId)),
        twoFactorLastUsedStep: null,
      })
      .where(tenantWhere(users, scope, eq(users.id, ctx.userId)));
    await writeAudit(scope, actorOf(ctx), {
      action: "MFA_ENROLLMENT_STARTED",
      entityType: "user",
      entityId: ctx.userId,
    });
    return { secret, uri: otpauthUri({ secret, account: user.email ?? user.username ?? ctx.userId, issuer: "Kliniva AI" }) };
  });
}

export async function confirmMfaEnrollment(ctx: AuthContext, code: unknown): Promise<void> {
  const codeStr = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  await tenantQuery(ctx, async (scope) => {
    const [user] = await scope.tx
      .select({ enabled: users.twoFactorEnabled, secret: users.twoFactorSecretEncrypted })
      .from(users)
      .where(tenantWhere(users, scope, eq(users.id, ctx.userId)));
    if (!user || !user.secret) throw new AppError("VALIDATION", { fields: ["code"] });
    if (user.enabled) throw new AppError("CONFLICT");
    const step = verifyTotp(decryptField(user.secret, mfaSecretAad(scope.tenantId, ctx.userId)), codeStr);
    if (step === null) {
      await writeAudit(scope, actorOf(ctx), {
        action: "MFA_FAILED",
        entityType: "user",
        entityId: ctx.userId,
      });
      throw new AppError("VALIDATION", { fields: ["code"] });
    }
    await scope.tx
      .update(users)
      .set({ twoFactorEnabled: true, twoFactorLastUsedStep: step })
      .where(tenantWhere(users, scope, eq(users.id, ctx.userId)));
    await writeAudit(scope, actorOf(ctx), {
      action: "MFA_ENABLED",
      entityType: "user",
      entityId: ctx.userId,
    });
  });
}

/** Bu oturum dışındaki tüm oturumları sunucuda iptal eder. */
export async function revokeOtherSessions(ctx: AuthContext): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.tenantId, ctx.tenantId),
        eq(sessions.userId, ctx.userId),
        ne(sessions.id, ctx.sessionId),
        isNull(sessions.revokedAt),
      ),
    );
  await tenantQuery(ctx, (scope) =>
    writeAudit(scope, actorOf(ctx), {
      action: "SESSION_REVOKED_ALL",
      entityType: "user",
      entityId: ctx.userId,
    }),
  );
}
