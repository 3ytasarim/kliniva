import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { sessions } from "@/server/db/schema";
import { isProduction } from "@/server/env";
import { randomToken, sha256Hex } from "@/server/security/crypto";
import type { RequestMeta } from "@/server/security/request-meta";

/**
 * Sunucu tarafı oturum.
 *  - Çerezde yalnızca 256-bit rastgele token; DB'de token'ın SHA-256 özeti (DB sızıntısı oturum çalmaya yetmez).
 *  - İstemcinin getirdiği bir kimlik ASLA oturum kimliği olarak benimsenmez; girişte her zaman yeni token üretilir
 *    ve önceki token geçersiz kılınır (session fixation koruması). MFA tamamlanınca token bir kez daha döner.
 *  - Çıkışta oturum sunucuda iptal edilir (revoked_at); çerezi silmek tek başına yeterli sayılmaz.
 *  - Mutlak ömür + boşta kalma (idle) zaman aşımı.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 saat mutlak
export const MFA_PENDING_TTL_MS = 10 * 60 * 1000; // 10 dk
export const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 dk hareketsizlik
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type SessionState = "MFA_PENDING" | "ACTIVE";

export type SessionRecord = {
  id: string;
  tenantId: string;
  userId: string;
  state: SessionState;
  expiresAt: Date;
};

/** Üretimde __Host- önekli çerez: Secure + Path=/ + Domain yok zorunluluğu tarayıcı tarafından uygulanır. */
export function sessionCookieName(): string {
  return isProduction() ? "__Host-kliniva_session" : "kliniva_session";
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

const hashToken = (token: string) => sha256Hex(`kliniva-session:${token}`);

export async function createSession(input: {
  tenantId: string;
  userId: string;
  state: SessionState;
  meta: RequestMeta;
}): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const token = randomToken(32);
  const ttl = input.state === "ACTIVE" ? SESSION_TTL_MS : MFA_PENDING_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);
  const [row] = await getDb()
    .insert(sessions)
    .values({
      tokenHash: hashToken(token),
      tenantId: input.tenantId,
      userId: input.userId,
      state: input.state,
      expiresAt,
      ipHash: input.meta.ipHash,
      userAgentSummary: input.meta.userAgentSummary,
    })
    .returning({ id: sessions.id });
  return { token, expiresAt, sessionId: row!.id };
}

/** Token geçerliyse oturumu döndürür; süresi dolmuş, iptal edilmiş veya boşta kalmış oturum null. */
export async function resolveSession(token: string | null | undefined): Promise<SessionRecord | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  const now = new Date();
  const [row] = await getDb()
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
    );
  if (!row) return null;
  if (now.getTime() - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) {
    await revokeSessionById(row.id);
    return null;
  }
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await getDb().update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.id));
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    state: row.state,
    expiresAt: row.expiresAt,
  };
}

export async function revokeSessionById(sessionId: string): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeSessionByToken(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
}

export async function revokeAllUserSessions(tenantId: string, userId: string): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tenantId, tenantId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
