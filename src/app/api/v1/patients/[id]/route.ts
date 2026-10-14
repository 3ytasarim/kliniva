import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { getPatient, updatePatient } from "@/server/services/patients";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/patients/:id — sağlık verisi yalnızca patient.health.read ile döner. */
export async function GET(req: Request, { params }: Params) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    return json({ data: await getPatient(ctx, (await params).id) });
  });
}

/** PATCH /api/v1/patients/:id — Yetki: patient.update (+ not için patient.health.write) */
export async function PATCH(req: Request, { params }: Params) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    await updatePatient(ctx, (await params).id, await readJson(req));
    return json({ ok: true });
  });
}
