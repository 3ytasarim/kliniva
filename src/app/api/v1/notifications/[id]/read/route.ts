import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json } from "@/server/http";
import { markNotificationRead } from "@/server/services/notifications";

export const dynamic = "force-dynamic";

/** POST /api/v1/notifications/:id/read — yalnızca KENDİ bildirimi; başkasınınki NOT_FOUND. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    await markNotificationRead(ctx, (await params).id);
    return json({ ok: true });
  });
}
