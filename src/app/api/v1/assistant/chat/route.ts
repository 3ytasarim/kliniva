import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { loadVoiceToolContext } from "@/server/voice/session";
import { runChatTurn } from "@/server/assistant/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/assistant/chat — { sessionId, message }. Oturum AYNI kullanıcıya ait, ETKİN ve CHAT kanalı olmalı
 * (aksi NOT_FOUND). Model + araç döngüsü sunucuda; yanıt: { reply, toolCalls (ad + güvenli sonuç), pending, settled }.
 * Kullanıcının mesajı onay ayrıştırmasında kullanılır (ör. "evet"); belirsiz ifade onay değildir.
 */
export async function POST(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const body = (await readJson(req)) as { sessionId?: unknown; message?: unknown };
    const message = typeof body.message === "string" ? body.message : "";
    const tc = await loadVoiceToolContext(ctx, body.sessionId, message, "CHAT");
    const turn = await runChatTurn(tc, message);
    return json({ data: turn });
  });
}
