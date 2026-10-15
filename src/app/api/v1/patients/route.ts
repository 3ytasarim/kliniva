import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, json, readJson } from "@/server/http";
import { createPatient, listPatients } from "@/server/services/patients";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/patients?q=&branchId=&status=active|inactive|all&page=&limit=
 * Minimum veri (telefon maskeli), sayfalama (varsayılan 25, en çok 100). Yetki: patient.read.
 */
export async function GET(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const sp = new URL(req.url).searchParams;
    const status = sp.get("status");
    const result = await listPatients(ctx, {
      q: sp.get("q") ?? undefined,
      branchId: sp.get("branchId") ?? undefined,
      status: status === "inactive" || status === "all" ? status : "active",
      page: Number(sp.get("page") ?? 1) || 1,
      limit: Number(sp.get("limit") ?? 25) || 25,
    });
    return json({ data: result.items, total: result.total, page: result.page, limit: result.limit });
  });
}

/** POST /api/v1/patients — Yetki: patient.create (+ not varsa patient.health.write) */
export async function POST(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    return json({ data: await createPatient(ctx, await readJson(req)) }, 201);
  });
}
