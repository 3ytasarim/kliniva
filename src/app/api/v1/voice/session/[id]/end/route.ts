import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json } from "@/server/http";
import { endVoiceSession } from "@/server/voice/session";
import { resetVoiceMockState } from "@/server/voice/mock-model";
import { forgetConversation } from "@/server/assistant/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/voice/session/:id/end — yalnızca KENDİ oturumu (ses veya yazılı sohbet). Sohbet geçmişi sunucu belleğinden
 * silinir; ekrandaki döküm istemcide temizlenir.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const { id } = await params;
    await endVoiceSession(ctx, id);
    resetVoiceMockState(id);
    forgetConversation(id);
    return json({ ok: true });
  });
}
