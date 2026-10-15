import "server-only";
import { isAppError, type AppErrorCode } from "@/server/errors";
import { logger } from "@/server/log/logger";

/** Server Action dönüş tipi — istemciye yalnızca genel mesaj ve alan adları gider. */
export type ActionState = { ok: boolean; message?: string; fields?: string[] } | null;

export async function runAction(fn: () => Promise<string | void>): Promise<ActionState> {
  try {
    const message = await fn();
    return { ok: true, message: message ?? "Kaydedildi." };
  } catch (e) {
    // Next'in redirect()/notFound() kontrol akışı hataları yeniden fırlatılır.
    if (
      e &&
      typeof e === "object" &&
      "digest" in e &&
      String((e as { digest: unknown }).digest).startsWith("NEXT_")
    ) {
      throw e;
    }
    if (isAppError(e)) return { ok: false, message: e.message, fields: e.fields };
    logger.error("action.unhandled_error", { error: e });
    return { ok: false, message: "Beklenmeyen bir hata oluştu." };
  }
}

/** Veri döndüren server action sonucu (istemci bileşenleri için). */
export type DataResult<T> =
  { ok: true; data: T } | { ok: false; code: AppErrorCode | "INTERNAL"; message: string; fields?: string[] };

export async function runData<T>(fn: () => Promise<T>): Promise<DataResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "digest" in e &&
      String((e as { digest: unknown }).digest).startsWith("NEXT_")
    ) {
      throw e;
    }
    if (isAppError(e)) return { ok: false, code: e.code, message: e.message, fields: e.fields };
    logger.error("action.unhandled_error", { error: e });
    return { ok: false, code: "INTERNAL", message: "Beklenmeyen bir hata oluştu." };
  }
}

/** FormData → düz nesne (yalnızca string alanlar; dosya alanları yok sayılır). */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) out[k] = v;
  return out;
}
