import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json } from "@/server/http";
import { endVoiceSession } from "@/server/voice/session";
import { resetVoiceMockState } from "@/server/voice/mock-model";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/v1/voice/session/:id/end — yalnızca KENDİ oturumu; ekrandaki döküm de istemcide temizlenir. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const { id } = await params;
    await endVoiceSession(ctx, id);
    resetVoiceMockState(id);
    return json({ ok: true });
  });
}
