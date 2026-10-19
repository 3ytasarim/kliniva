import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/security-headers";

/**
 * Next 16 Proxy: her sayfa isteğinde yeni nonce üretir ve nonce'lu Content-Security-Policy ekler.
 * Veritabanına dokunmaz; kimlik doğrulama sunucu bileşenlerinde/servislerde yapılır (proxy'de değil).
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development" });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|brand/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
