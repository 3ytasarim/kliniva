import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { tenants } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { authenticate } from "@/server/auth/context";
import { resolveSession, sessionCookieName } from "@/server/auth/session";
import { requestMetaFrom } from "@/server/security/request-meta";
import type { AuthContext } from "@/server/auth/authz";

export { requirePermission, requireBranchAccess, hasPermission } from "@/server/auth/authz";

/**
 * Next.js'e özgü koruyucular (sayfa / server action / route handler).
 * Servis katmanı Next'ten bağımsızdır; burada yalnızca çerez → AuthContext dönüşümü yapılır.
 */

export async function sessionTokenFromCookies(): Promise<string | null> {
  return (await cookies()).get(sessionCookieName())?.value ?? null;
}

/** Route handler'lar için: Request'in Cookie başlığından token okur (next/headers gerektirmez → test edilebilir). */
export function sessionTokenFromRequest(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const name = sessionCookieName();
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Sayfa / server action: oturum yoksa /login'e, MFA bekliyorsa /login/mfa'ya yönlendirir. */
export const requireUser = cache(async (): Promise<AuthContext> => {
  const token = await sessionTokenFromCookies();
  const meta = requestMetaFrom(await headers());
  const ctx = await authenticate(token, meta);
  if (ctx) return ctx;
  const session = await resolveSession(token);
  if (session?.state === "MFA_PENDING") redirect("/login/mfa");
  redirect("/login");
});

/** Sayfa için oturumdaki kiracı (klinik) kaydı. tenantId her zaman oturumdan gelir. */
export const requireTenant = cache(async () => {
  const ctx = await requireUser();
  const [tenant] = await getDb()
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, ctx.tenantId));
  if (!tenant) redirect("/login");
  return { ctx, tenant };
});

/** Route handler: oturum yoksa UNAUTHENTICATED fırlatır (yönlendirme yapmaz). */
export async function requireUserFromRequest(req: Request): Promise<AuthContext> {
  const ctx = await authenticate(sessionTokenFromRequest(req), requestMetaFrom(req.headers));
  if (!ctx) throw new AppError("UNAUTHENTICATED");
  return ctx;
}
