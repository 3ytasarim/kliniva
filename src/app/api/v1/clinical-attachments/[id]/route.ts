import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, NO_STORE } from "@/server/http";
import { readClinicalAttachment } from "@/server/services/clinical-attachments";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** RFC 6266: ASCII yedek ad + UTF-8 (filename*) — tırnak / satır sonu enjeksiyonu yok. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "dosya";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * GET /api/v1/clinical-attachments/:id — muayene dosyası (sağlık verisi). Yetki: patient.health.read + randevu
 * görünürlüğü; bütünlük (SHA-256) doğrulanır; her indirme audit'lenir. Public URL yoktur; önbelleğe alınmaz.
 * Görseller kum havuzlu CSP ile satır içi, PDF tarayıcı görüntüleyicisinde açılır; ?download=1 → indirme.
 */
export async function GET(req: Request, { params }: Params) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const file = await readClinicalAttachment(ctx, (await params).id);
    const download = new URL(req.url).searchParams.get("download") === "1";
    return new Response(new Uint8Array(file.data), {
      headers: {
        ...NO_STORE,
        "Content-Type": file.mimeType,
        "Content-Disposition": disposition(download ? "attachment" : "inline", file.fileName),
        "X-Content-Type-Options": "nosniff",
        ...(file.mimeType.startsWith("image/")
          ? { "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox" }
          : {}),
      },
    });
  });
}
