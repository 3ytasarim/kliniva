import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { AppError } from "@/server/errors";
import { loadVoiceToolContext } from "@/server/voice/session";
import { simulateVoiceTurn } from "@/server/voice/mock-model";
import { isMockTransportEnabled } from "@/server/voice/transport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/voice/mock-turn — YALNIZCA VOICE_TRANSPORT=mock (CI / E2E): metin komutu → deterministik model →
 * üretim araçları. Diğer ortamlarda 404. Döküm sunucuda SAKLANMAZ.
 */
export async function POST(req: Request) {
  return handle(req, async () => {
    if (!isMockTransportEnabled()) throw new AppError("NOT_FOUND");
    const ctx = await requireUserFromRequest(req);
    const body = (await readJson(req)) as { sessionId?: unknown; text?: unknown };
    const text = typeof body.text === "string" ? body.text.slice(0, 500) : "";
    const tc = await loadVoiceToolContext(ctx, body.sessionId, text);
    return json({ data: await simulateVoiceTurn(tc, text) });
  });
}
