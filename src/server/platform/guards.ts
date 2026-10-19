import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { requestMetaFrom } from "@/server/security/request-meta";
import {
  authenticatePlatform,
  platformCookieName,
  resolvePlatformSession,
  type PlatformContext,
} from "@/server/platform/auth";

/** Platform sayfa / action koruyucuları (klinik oturumundan tamamen ayrı çerez). */
export async function platformTokenFromCookies(): Promise<string | null> {
  return (await cookies()).get(platformCookieName())?.value ?? null;
}

/** ACTIVE platform oturumu zorunlu; değilse girişe / MFA adımına yönlendirir. */
export const requirePlatform = cache(async (): Promise<PlatformContext> => {
  const token = await platformTokenFromCookies();
  const meta = requestMetaFrom(await headers());
  const ctx = await authenticatePlatform(token, meta);
  if (ctx) return ctx;
  const s = await resolvePlatformSession(token);
  if (s && s.state !== "ACTIVE") redirect("/platform/mfa");
  redirect("/platform/login");
});
