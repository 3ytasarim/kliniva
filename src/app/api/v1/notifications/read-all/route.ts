import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json } from "@/server/http";
import { markAllNotificationsRead } from "@/server/services/notifications";

export const dynamic = "force-dynamic";

/** POST /api/v1/notifications/read-all — oturumdaki kullanıcının tüm okunmamış bildirimleri. */
export async function POST(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    return json({ data: await markAllNotificationsRead(ctx) });
  });
}
