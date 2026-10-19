import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { loadVoiceToolContext } from "@/server/voice/session";
import { runVoiceTool } from "@/server/voice/tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/voice/tools — Realtime modelinin işlev çağrısı (tarayıcı iletir). Gövde: { sessionId, name,
 * arguments (JSON metni veya nesne), utterance (kullanıcının son sözü, onay için) }. Kiracı / kullanıcı / kapsam
 * OTURUMDAN; argümanlardaki her şey Zod ile doğrulanır; tenantId / userId kabul edilmez (şemada yok).
 */
export async function POST(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const body = (await readJson(req)) as {
      sessionId?: unknown;
      name?: unknown;
      arguments?: unknown;
      utterance?: unknown;
    };
    const tc = await loadVoiceToolContext(ctx, body.sessionId, body.utterance, "VOICE");
    let args: unknown = body.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args.slice(0, 8_000));
      } catch {
        args = null;
      }
    }
    const out = await runVoiceTool(tc, typeof body.name === "string" ? body.name.slice(0, 80) : "", args);
    return json({ data: out });
  });
}
