import { requireUserFromRequest } from "@/server/auth/guards";
import { handle, NO_STORE } from "@/server/http";
import { readClinicLogo } from "@/server/services/clinic";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/clinic/logo — oturumdaki kiracının logosu (PNG). Parametre ALMAZ: başka kiracının logosunu
 * istemenin bir yolu yoktur. Yetki: clinic.read.
 */
export async function GET(req: Request) {
  return handle(req, async () => {
    const ctx = await requireUserFromRequest(req);
    const png = await readClinicLogo(ctx);
    return new Response(new Uint8Array(png), {
      headers: {
        ...NO_STORE,
        "Content-Type": "image/png",
        "Content-Disposition": 'inline; filename="logo.png"',
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });
}
