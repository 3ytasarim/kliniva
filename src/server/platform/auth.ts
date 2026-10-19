import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { platformAdmins, platformAuditLogs, platformSessions } from "@/server/db/schema";
import { isProduction } from "@/server/env";
import { decryptField, encryptField, randomToken, sha256Hex } from "@/server/security/crypto";
import { verifyAgainstDummy, verifyPassword } from "@/server/security/password";
import { clearHits, isRateLimited, recordHit, RULES } from "@/server/security/rate-limit";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/server/security/totp";
import { logger } from "@/server/log/logger";
import { normalizeEmail } from "@/server/validation";
import type { RequestMeta } from "@/server/security/request-meta";

/**
 * PLATFORM YÖNETİCİSİ kimlik doğrulaması (yazılım sahibi; kliniklerden bağımsız).
 *  - Ayrı çerez ve ayrı oturum tablosu: klinik oturumuyla karışmaz, klinik oturumu platform yetkisi taşımaz.
 *  - İki adımlı doğrulama ZORUNLU: ilk girişte kurulum (MFA_SETUP), sonrakilerde kod (MFA_PENDING). ACTIVE oturum
 *    yalnızca geçerli TOTP kodundan sonra oluşur; veritabanı fonksiyonları da yalnızca ACTIVE oturumu kabul eder.
 *  - Çerezde yalnızca rastgele token; veritabanında SHA-256 özeti. Girişte / doğrulamada token yenilenir.
 *  - Hız sınırı: hesap ve IP başına (klinik girişiyle aynı kurallar).
 */
export const PLATFORM_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PLATFORM_MFA_TTL_MS = 10 * 60 * 1000;
const PLATFORM_IDLE_MS = 30 * 60 * 1000;

export type PlatformSessionState = "MFA_SETUP" | "MFA_PENDING" | "ACTIVE";
export type PlatformSession = {
  id: string;
  adminId: string;
  state: PlatformSessionState;
  tokenHash: string;
  expiresAt: Date;
};

export function platformCookieName(): string {
  return isProduction() ? "__Host-kliniva_platform" : "kliniva_platform";
}
export function platformCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "strict" as const,
    path: "/",
    expires: expiresAt,
  };
}

const hashToken = (token: string) => sha256Hex(`kliniva-platform-session:${token}`);
const totpAad = (adminId: string) => `platform.totp:${adminId}`;

async function audit(adminId: string | null, action: string, meta: RequestMeta, targetTenantId?: string) {
  await getDb()
    .insert(platformAuditLogs)
    .values({ adminId, action, targetTenantId: targetTenantId ?? null, ipHash: meta.ipHash ?? null });
}

async function createPlatformSession(adminId: string, state: PlatformSessionState, meta: RequestMeta) {
  const token = randomToken(32);
  const expiresAt = new Date(
    Date.now() + (state === "ACTIVE" ? PLATFORM_SESSION_TTL_MS : PLATFORM_MFA_TTL_MS),
  );
  await getDb()
    .insert(platformSessions)
    .values({
      tokenHash: hashToken(token),
      adminId,
      state,
      expiresAt,
      ipHash: meta.ipHash,
      userAgentSummary: meta.userAgentSummary,
    });
  return { token, expiresAt };
}

export async function resolvePlatformSession(
  token: string | null | undefined,
): Promise<PlatformSession | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  const tokenHash = hashToken(token);
  const now = new Date();
  const [s] = await getDb()
    .select()
    .from(platformSessions)
    .where(
      and(
        eq(platformSessions.tokenHash, tokenHash),
        isNull(platformSessions.revokedAt),
        gt(platformSessions.expiresAt, now),
      ),
    );
  if (!s) return null;
  if (now.getTime() - s.lastSeenAt.getTime() > PLATFORM_IDLE_MS) {
    await revokePlatformSessionById(s.id);
    return null;
  }
  if (now.getTime() - s.lastSeenAt.getTime() > 60_000) {
    await getDb().update(platformSessions).set({ lastSeenAt: now }).where(eq(platformSessions.id, s.id));
  }
  return { id: s.id, adminId: s.adminId, state: s.state, tokenHash, expiresAt: s.expiresAt };
}

export async function revokePlatformSessionById(id: string): Promise<void> {
  await getDb()
    .update(platformSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(platformSessions.id, id), isNull(platformSessions.revokedAt)));
}

const loginInput = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});

export type PlatformLoginResult =
  | { ok: true; token: string; expiresAt: Date; next: "MFA_SETUP" | "MFA_PENDING" }
  | { ok: false; code: "INVALID_CREDENTIALS" | "RATE_LIMITED" };

/** 1. adım: e-posta + parola → MFA kurulum ya da doğrulama oturumu (henüz yetki YOK). */
export async function platformLogin(raw: unknown, meta: RequestMeta): Promise<PlatformLoginResult> {
  const parsed = loginInput.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "INVALID_CREDENTIALS" };
  const email = normalizeEmail(parsed.data.email);
  const acct = `platform:${email}`;
  const ip = meta.ipHash ?? "no-ip";
  if ((await isRateLimited(RULES.loginPerAccount, acct)) || (await isRateLimited(RULES.loginPerIp, ip))) {
    logger.warn("platform.login_rate_limited", { ipHash: meta.ipHash });
    return { ok: false, code: "RATE_LIMITED" };
  }
  const [admin] = await getDb()
    .select()
    .from(platformAdmins)
    .where(eq(platformAdmins.emailNormalized, email));
  const passwordOk = admin
    ? await verifyPassword(admin.passwordHash, parsed.data.password)
    : await verifyAgainstDummy(parsed.data.password);
  if (!admin || !admin.active || !passwordOk) {
    await recordHit(RULES.loginPerAccount, acct);
    await recordHit(RULES.loginPerIp, ip);
    await audit(admin?.id ?? null, "LOGIN_FAILED", meta);
    return { ok: false, code: "INVALID_CREDENTIALS" };
  }
  await clearHits(RULES.loginPerAccount, acct);
  const next = admin.twoFactorEnabled ? "MFA_PENDING" : "MFA_SETUP";
  const s = await createPlatformSession(admin.id, next, meta);
  await audit(admin.id, "LOGIN_PASSWORD_OK", meta);
  return { ok: true, token: s.token, expiresAt: s.expiresAt, next };
}

/** MFA kurulumu için sırrı üretir (yoksa) ve QR / elle giriş için döndürür. Yalnızca MFA_SETUP oturumunda. */
export async function platformMfaSetupInfo(
  session: PlatformSession,
): Promise<{ secret: string; uri: string } | null> {
  if (session.state !== "MFA_SETUP") return null;
  const [admin] = await getDb().select().from(platformAdmins).where(eq(platformAdmins.id, session.adminId));
  if (!admin || !admin.active || admin.twoFactorEnabled) return null;
  let secret: string;
  if (admin.twoFactorSecretEncrypted) {
    secret = decryptField(admin.twoFactorSecretEncrypted, totpAad(admin.id));
  } else {
    secret = generateTotpSecret();
    await getDb()
      .update(platformAdmins)
      .set({ twoFactorSecretEncrypted: encryptField(secret, totpAad(admin.id)), updatedAt: new Date() })
      .where(eq(platformAdmins.id, admin.id));
  }
  return { secret, uri: otpauthUri({ secret, account: admin.email, issuer: "Kliniva Platform" }) };
}

export type PlatformMfaResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; code: "INVALID_CODE" | "RATE_LIMITED" | "SESSION_INVALID" };

/** 2. adım: TOTP kodu (kurulum ya da giriş) → ACTIVE oturum (token yenilenir). Tekrar oynatma korumalı. */
export async function platformVerifyMfa(
  token: string | null | undefined,
  code: unknown,
  meta: RequestMeta,
): Promise<PlatformMfaResult> {
  const session = await resolvePlatformSession(token);
  if (!session || session.state === "ACTIVE") return { ok: false, code: "SESSION_INVALID" };
  if (await isRateLimited(RULES.mfaPerSession, `platform:${session.id}`)) {
    await revokePlatformSessionById(session.id);
    return { ok: false, code: "RATE_LIMITED" };
  }
  const [admin] = await getDb().select().from(platformAdmins).where(eq(platformAdmins.id, session.adminId));
  const codeStr = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (!admin || !admin.active || !admin.twoFactorSecretEncrypted)
    return { ok: false, code: "SESSION_INVALID" };
  if (session.state === "MFA_PENDING" && !admin.twoFactorEnabled)
    return { ok: false, code: "SESSION_INVALID" };
  const secret = decryptField(admin.twoFactorSecretEncrypted, totpAad(admin.id));
  const step = verifyTotp(secret, codeStr, { lastUsedStep: admin.twoFactorLastUsedStep });
  if (step === null) {
    await recordHit(RULES.mfaPerSession, `platform:${session.id}`);
    await audit(admin.id, "MFA_FAILED", meta);
    return { ok: false, code: "INVALID_CODE" };
  }
  await getDb()
    .update(platformAdmins)
    .set({
      twoFactorLastUsedStep: step,
      twoFactorEnabled: true,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(platformAdmins.id, admin.id));
  await revokePlatformSessionById(session.id);
  const next = await createPlatformSession(admin.id, "ACTIVE", meta);
  await audit(admin.id, session.state === "MFA_SETUP" ? "MFA_ENABLED" : "LOGIN_SUCCESS", meta);
  return { ok: true, token: next.token, expiresAt: next.expiresAt };
}

export async function platformLogout(token: string | null | undefined, meta: RequestMeta): Promise<void> {
  const s = await resolvePlatformSession(token);
  if (!s) return;
  await revokePlatformSessionById(s.id);
  await audit(s.adminId, "LOGOUT", meta);
}

export type PlatformContext = {
  adminId: string;
  email: string;
  displayName: string;
  /** Veritabanı fonksiyonlarına iletilen oturum token özeti (fonksiyon oturumu yeniden doğrular). */
  tokenHash: string;
  meta: RequestMeta;
};

/** ACTIVE platform oturumundan bağlam; değilse null. */
export async function authenticatePlatform(
  token: string | null | undefined,
  meta: RequestMeta,
): Promise<PlatformContext | null> {
  const s = await resolvePlatformSession(token);
  if (!s || s.state !== "ACTIVE") return null;
  const [admin] = await getDb().select().from(platformAdmins).where(eq(platformAdmins.id, s.adminId));
  if (!admin || !admin.active || !admin.twoFactorEnabled) return null;
  return {
    adminId: admin.id,
    email: admin.email,
    displayName: admin.displayName,
    tokenHash: s.tokenHash,
    meta,
  };
}
