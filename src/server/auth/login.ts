import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { tenants, users } from "@/server/db/schema";
import { writeAudit, type AuditActor } from "@/server/audit/audit";
import { runInTenant } from "@/server/tenant/tenant-query";
import { decryptField } from "@/server/security/crypto";
import { verifyAgainstDummy, verifyPassword } from "@/server/security/password";
import { clearHits, isRateLimited, recordHit, RULES } from "@/server/security/rate-limit";
import { verifyTotp } from "@/server/security/totp";
import { logger } from "@/server/log/logger";
import { normalizeEmail, slugSchema } from "@/server/validation";
import { isEmailLike, normalizeUsername } from "@/server/auth/login-id";
import type { RequestMeta } from "@/server/security/request-meta";
import {
  createSession,
  resolveSession,
  revokeSessionById,
  revokeSessionByToken,
} from "@/server/auth/session";

/**
 * Giriş akışı. Tüm başarısızlıklar istemciye AYNI genel hatayla döner (kullanıcı/klinik keşfi yok).
 * Sıra: hız sınırı → klinik → kullanıcı → Argon2id doğrulama → (MFA) → yeni oturum (fixation koruması).
 */
export const loginInputSchema = z.object({
  tenantSlug: slugSchema,
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; mfaRequired: boolean }
  | { ok: false; code: "INVALID_CREDENTIALS" | "RATE_LIMITED" };

const INVALID = { ok: false, code: "INVALID_CREDENTIALS" } as const;
const RATE_LIMITED = { ok: false, code: "RATE_LIMITED" } as const;

export const mfaSecretAad = (tenantId: string, userId: string) => `user.totp:${tenantId}:${userId}`;

export async function login(
  raw: unknown,
  meta: RequestMeta,
  opts: { previousToken?: string | null } = {},
): Promise<LoginResult> {
  const parsed = loginInputSchema.safeParse(raw);
  if (!parsed.success) return INVALID;
  const { tenantSlug, password } = parsed.data;
  // Giriş kimliği: @ içeriyorsa e-posta, değilse kullanıcı adı (ikisi de klinik içinde benzersiz).
  const byEmail = isEmailLike(parsed.data.email);
  const loginId = byEmail ? normalizeEmail(parsed.data.email) : normalizeUsername(parsed.data.email);

  const ipSubject = meta.ipHash ?? "no-ip";
  const accountSubject = `${tenantSlug}:${loginId}`;
  if (
    (await isRateLimited(RULES.loginPerAccount, accountSubject)) ||
    (await isRateLimited(RULES.loginPerIp, ipSubject))
  ) {
    logger.warn("auth.login_rate_limited", { ipHash: meta.ipHash });
    return RATE_LIMITED;
  }

  const fail = async (tenantId: string | null, reason: string, userId: string | null = null) => {
    await recordHit(RULES.loginPerAccount, accountSubject);
    await recordHit(RULES.loginPerIp, ipSubject);
    if (tenantId) {
      const actor: AuditActor = { userId, source: "USER", meta };
      await runInTenant(tenantId, (scope) =>
        writeAudit(scope, actor, {
          action: "LOGIN_FAILED",
          entityType: "user",
          entityId: userId,
          metadata: { reason },
        }),
      );
    }
    logger.info("auth.login_failed", { reason, ipHash: meta.ipHash });
    return INVALID;
  };

  const [tenant] = await getDb()
    .select({ id: tenants.id, status: tenants.status })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug));
  if (!tenant || tenant.status !== "ACTIVE") {
    await verifyAgainstDummy(password);
    return fail(null, tenant ? "TENANT_SUSPENDED" : "UNKNOWN_TENANT");
  }

  const user = await runInTenant(tenant.id, async (scope) => {
    const [row] = await scope.tx
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        active: users.active,
        twoFactorEnabled: users.twoFactorEnabled,
      })
      .from(users)
      .where(
        and(
          eq(users.tenantId, scope.tenantId),
          byEmail ? eq(users.emailNormalized, loginId) : eq(users.usernameNormalized, loginId),
        ),
      );
    return row;
  });

  if (!user) {
    await verifyAgainstDummy(password);
    return fail(tenant.id, "UNKNOWN_USER");
  }
  // Parola her durumda doğrulanır (pasif kullanıcıda da) → yanıt süresi durum sızdırmaz.
  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!user.active) return fail(tenant.id, "USER_DISABLED", user.id);
  if (!passwordOk) return fail(tenant.id, "BAD_PASSWORD", user.id);

  // Başarılı: hesap sayacı temizlenir; istemcinin getirdiği eski oturum (varsa) iptal edilir; YENİ token üretilir.
  await clearHits(RULES.loginPerAccount, accountSubject);
  await revokeSessionByToken(opts.previousToken);
  const state = user.twoFactorEnabled ? "MFA_PENDING" : "ACTIVE";
  const session = await createSession({ tenantId: tenant.id, userId: user.id, state, meta });

  await runInTenant(tenant.id, async (scope) => {
    if (state === "ACTIVE") {
      await scope.tx
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, user.id)));
    }
    await writeAudit(
      scope,
      { userId: user.id, source: "USER", meta },
      {
        action: "LOGIN_SUCCESS",
        entityType: "user",
        entityId: user.id,
        metadata: { mfaPending: state !== "ACTIVE" },
      },
    );
  });

  return { ok: true, token: session.token, expiresAt: session.expiresAt, mfaRequired: state !== "ACTIVE" };
}

export type MfaResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; code: "INVALID_CODE" | "RATE_LIMITED" | "SESSION_INVALID" };

/**
 * İkinci adım: MFA_PENDING oturumu + TOTP kodu → yeni ACTIVE oturum (token yeniden döner).
 * Bypass yolu yoktur: MFA etkin kullanıcı ACTIVE oturuma yalnızca geçerli kodla ulaşır.
 */
export async function verifyMfaLogin(
  pendingToken: string | null | undefined,
  code: unknown,
  meta: RequestMeta,
): Promise<MfaResult> {
  const session = await resolveSession(pendingToken);
  if (!session || session.state !== "MFA_PENDING") return { ok: false, code: "SESSION_INVALID" };
  if (await isRateLimited(RULES.mfaPerSession, session.id)) {
    await revokeSessionById(session.id);
    return { ok: false, code: "RATE_LIMITED" };
  }
  const codeStr = typeof code === "string" ? code.replace(/\s+/g, "") : "";

  const accepted = await runInTenant(session.tenantId, async (scope) => {
    const [user] = await scope.tx
      .select({
        secret: users.twoFactorSecretEncrypted,
        enabled: users.twoFactorEnabled,
        active: users.active,
        lastStep: users.twoFactorLastUsedStep,
      })
      .from(users)
      .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, session.userId)));
    if (!user || !user.active || !user.enabled || !user.secret) return false;
    const secret = decryptField(user.secret, mfaSecretAad(scope.tenantId, session.userId));
    const step = verifyTotp(secret, codeStr, { lastUsedStep: user.lastStep });
    const actor: AuditActor = { userId: session.userId, source: "USER", meta };
    if (step === null) {
      await writeAudit(scope, actor, { action: "MFA_FAILED", entityType: "user", entityId: session.userId });
      return false;
    }
    await scope.tx
      .update(users)
      .set({ twoFactorLastUsedStep: step, lastLoginAt: new Date() })
      .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, session.userId)));
    return true;
  });

  if (!accepted) {
    await recordHit(RULES.mfaPerSession, session.id);
    return { ok: false, code: "INVALID_CODE" };
  }
  await revokeSessionById(session.id);
  const next = await createSession({
    tenantId: session.tenantId,
    userId: session.userId,
    state: "ACTIVE",
    meta,
  });
  return { ok: true, token: next.token, expiresAt: next.expiresAt };
}

/** Çıkış: oturum sunucuda iptal edilir. Token sonraki isteklerde geçersizdir. */
export async function logout(token: string | null | undefined, meta: RequestMeta): Promise<void> {
  const session = await resolveSession(token);
  if (!session) return;
  await revokeSessionById(session.id);
  await runInTenant(session.tenantId, (scope) =>
    writeAudit(
      scope,
      { userId: session.userId, source: "USER", meta },
      { action: "LOGOUT", entityType: "session", entityId: session.id },
    ),
  );
}
