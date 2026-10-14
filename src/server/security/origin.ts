import "server-only";
import { AppError } from "@/server/errors";

/**
 * CSRF / origin kontrolü — durum değiştiren route handler isteklerinde (POST/PUT/PATCH/DELETE) zorunlu.
 *  - Origin başlığı varsa APP_ORIGIN veya isteğin kendi host'u ile birebir eşleşmeli.
 *  - Origin yoksa Sec-Fetch-Site "same-origin" olmalı; ikisi de yoksa istek reddedilir.
 * Server Action'lar Next.js tarafından ayrıca Origin/Host eşleşmesiyle korunur. Oturum çerezi SameSite=Lax'tır.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSameOriginRequest(req: Request, appOrigin = process.env.APP_ORIGIN): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin) {
    if (origin === "null") return false;
    try {
      const o = new URL(origin);
      if (appOrigin && o.origin === new URL(appOrigin).origin) return true;
      return host !== null && o.host === host;
    } catch {
      return false;
    }
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
}

export function assertSameOrigin(req: Request): void {
  if (!isSameOriginRequest(req)) throw new AppError("BAD_ORIGIN");
}
