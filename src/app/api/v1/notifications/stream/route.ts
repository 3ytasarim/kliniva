import { handle } from "@/server/http";
import { openNotificationStream } from "@/server/notifications/sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/notifications/stream — Server-Sent Events. Alıcı OTURUMDAN türetilir; sorgu parametreleri yok
 * sayılır (cross-user / cross-tenant abonelik imkânsız). Ayrıntı: src/server/notifications/sse.ts.
 */
export async function GET(req: Request) {
  return handle(req, () => openNotificationStream(req));
}
