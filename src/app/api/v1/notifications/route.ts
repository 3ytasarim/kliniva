import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json } from "@/server/http";
import { listNotifications } from "@/server/services/notifications";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/notifications?filter=all|unread|appointments|inventory|security&page=&limit=
 * YALNIZCA oturumdaki kullanıcının bildirimleri (alıcı oturumdan; istemci parametresi alıcıyı belirleyemez).
 * Sayfalama: varsayılan 25, en çok 100. Yetki: notification.read_own.
 */
export async function GET(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const sp = new URL(req.url).searchParams;
    const result = await listNotifications(ctx, {
      filter: sp.get("filter") ?? undefined,
      page: sp.get("page") ?? undefined,
      limit: sp.get("limit") ?? undefined,
    });
    return json({
      data: result.items,
      total: result.total,
      unread: result.unread,
      page: result.page,
      limit: result.limit,
    });
  });
}
