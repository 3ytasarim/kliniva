import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { createChatSession } from "@/server/voice/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/assistant/session — Kliniva AI yazılı sohbet oturumu. Oturum (çerez) zorunlu; kiracı / kullanıcı / rol /
 * şube kapsamı sunucudaki oturumdan. İstemciye HİÇBİR sır dönmez (model çağrısı sunucuda). Ses ile aynı yetki
 * (voice.use), klinik ayarı, hız sınırı ve kullanıcı başına etkin oturum sınırı (kanal başına) uygulanır.
 */
export async function POST(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const body = (await readJson(req)) as { language?: unknown };
    const s = await createChatSession(ctx, { language: body?.language });
    return json({ data: s }, 201);
  });
}
