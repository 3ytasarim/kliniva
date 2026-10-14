import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { createPatient, listPatients } from "@/server/services/patients";

export const dynamic = "force-dynamic";

/** GET /api/v1/patients — minimum veri (telefon maskeli). Yetki: patient.read */
export async function GET(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const q = new URL(req.url).searchParams.get("q") ?? undefined;
    return json({ data: await listPatients(ctx, { q }) });
  });
}

/** POST /api/v1/patients — Yetki: patient.create (+ not varsa patient.health.write) */
export async function POST(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    return json({ data: await createPatient(ctx, await readJson(req)) }, 201);
  });
}
