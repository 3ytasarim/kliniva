import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { createVoiceSession } from "@/server/voice/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/voice/session — Kliniva AI sesli asistan oturumu. Oturum (çerez) zorunlu; kiracı / kullanıcı / rol /
 * şube kapsamı sunucudaki oturumdan gelir. Yanıtta YALNIZCA kısa ömürlü istemci sırrı (ana API anahtarı asla).
 * Hız sınırı + kullanıcı başına en fazla 2 etkin oturum (VOICE_SESSION_LIMIT). Yanıt önbelleğe alınmaz.
 */
export async function POST(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const body = (await readJson(req)) as { language?: unknown };
    const s = await createVoiceSession(ctx, { language: body?.language });
    return json({ data: s }, 201);
  });
}
