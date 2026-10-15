import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { loadVoiceToolContext } from "@/server/voice/session";
import { cancelPendingAction } from "@/server/voice/actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/v1/voice/actions/:id/cancel — kullanıcı vazgeçti (yalnızca kendi + aynı oturumdaki PENDING eylem). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const body = (await readJson(req)) as { sessionId?: unknown };
    const tc = await loadVoiceToolContext(ctx, body.sessionId, null);
    return json({ data: await cancelPendingAction(tc, (await params).id) });
  });
}
