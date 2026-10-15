import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { loadVoiceToolContext } from "@/server/voice/session";
import { confirmActionFromUi } from "@/server/voice/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/voice/actions/:id/confirm — ekrandaki "Onayla" düğmesi (açık kullanıcı eylemi). Sesli onayla aynı
 * kurallar: aynı kullanıcı + aynı ses oturumu + süresi dolmamış eylem; tekrar çağrı önceki sonucu döndürür.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const body = (await readJson(req)) as { sessionId?: unknown };
    const tc = await loadVoiceToolContext(ctx, body.sessionId, null);
    return json({ data: await confirmActionFromUi(tc, (await params).id) });
  });
}
