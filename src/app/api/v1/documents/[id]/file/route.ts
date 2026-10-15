import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, NO_STORE } from "@/server/http";
import { readDocumentFile } from "@/server/services/documents";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/documents/:id/file?kind=pdf|signature
 * İmzalı PDF ve imza görüntüsü yalnızca bu uç üzerinden, yetki kontrolü ve audit ile verilir. Public URL yoktur.
 */
export async function GET(req: Request, { params }: Params) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const kind = new URL(req.url).searchParams.get("kind") === "signature" ? "signature" : "pdf";
    const file = await readDocumentFile(ctx, (await params).id, kind);
    return new Response(new Uint8Array(file.data), {
      headers: {
        ...NO_STORE,
        "Content-Type": file.contentType,
        "Content-Disposition": `inline; filename="kliniva-${kind}.${kind === "pdf" ? "pdf" : "png"}"`,
        ...(kind === "signature" ? { "Content-Security-Policy": "default-src 'none'; sandbox" } : {}),
        "X-Integrity-Verified": String(file.sha256Ok),
      },
    });
  });
}
