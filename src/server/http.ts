import "server-only";
import { isAppError } from "@/server/errors";
import { logger } from "@/server/log/logger";
import { assertSameOrigin } from "@/server/security/origin";

/**
 * Route handler sarmalayıcı: origin (CSRF) kontrolü + tutarlı hata biçimi + güvenli loglama.
 * Beklenmeyen hatalar istemciye ayrıntısız 500 döner; log'a yalnızca temizlenmiş ad/kod yazılır.
 */
export const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function handle(req: Request, fn: () => Promise<Response>): Promise<Response> {
  try {
    assertSameOrigin(req);
    return await fn();
  } catch (e) {
    if (isAppError(e)) return json(e.toJSON(), e.status);
    logger.error("api.unhandled_error", { path: new URL(req.url).pathname, error: e });
    return json({ error: { code: "INTERNAL", message: "Beklenmeyen bir hata oluştu." } }, 500);
  }
}

export async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return {};
  try {
    return await req.json();
  } catch {
    return {};
  }
}
