import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, NO_STORE } from "@/server/http";
import { readDocumentFile } from "@/server/services/documents";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; docId: string }> };

/**
 * GET /api/v1/patients/:id/documents/:docId/file?kind=pdf|signature&download=1
 *
 * Kontroller (servis): oturum → kiracı (RLS) → patient.document.read → belge bu hastaya ait → şube kapsamı →
 * depolama anahtarı kiracıya ait → PDF bütünlüğü (SHA-256). Başka kiracının / hastanın belgesi: 404 (varlık
 * sızdırılmaz). Depolama anahtarı istemciye hiçbir zaman dönmez; dosya sunucu üzerinden akıtılır.
 * Dosya adında hasta adı (PII) yer almaz.
 */
export async function GET(req: Request, { params }: Params) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const { id, docId } = await params;
    const sp = new URL(req.url).searchParams;
    const kind = sp.get("kind") === "signature" ? "signature" : "pdf";
    const download = sp.get("download") === "1";
    const file = await readDocumentFile(ctx, docId, kind, { patientId: id, download });
    const filename = kind === "pdf" ? `kvkk-belgesi-${file.documentId}.pdf` : `imza-${file.documentId}.png`;
    return new Response(new Uint8Array(file.data), {
      headers: {
        ...NO_STORE,
        "Content-Type": file.contentType,
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
        // Görüntü yanıtı korumalı bağlamda; PDF için "sandbox" tarayıcının PDF görüntüleyicisini engellediğinden eklenmez.
        ...(kind === "signature" ? { "Content-Security-Policy": "default-src 'none'; sandbox" } : {}),
        "X-Integrity-Verified": String(file.sha256Ok),
      },
    });
  });
}
