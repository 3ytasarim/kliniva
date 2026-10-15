/**
 * Güvenlik başlıkları — tek kaynak. next.config.ts (statik başlıklar) ve src/proxy.ts (nonce'lu CSP) kullanır.
 */
export function buildCsp(nonce: string, opts: { dev: boolean }): string {
  const directives = [
    "default-src 'self'",
    // 'strict-dynamic' + nonce: yalnızca sunucunun nonce verdiği script'ler (ve onların yüklediği) çalışır.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self'${opts.dev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // Sesli asistan: tarayıcı kısa ömürlü istemci sırrıyla OpenAI Realtime SDP uç noktasına bağlanır (yalnızca bu
    // origin). WebRTC medya akışı connect-src kapsamında değildir; unsafe-eval / unsafe-inline EKLENMEZ.
    "connect-src 'self' https://api.openai.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Clickjacking koruması (X-Frame-Options ile birlikte).
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];
  if (!opts.dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function staticSecurityHeaders(opts: { production: boolean }): { key: string; value: string }[] {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      // Mikrofon YALNIZCA kendi origin'imize (sesli asistan; iframe'ler mikrofon isteyemez). Kamera vb. kapalı.
      value:
        "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    { key: "X-Robots-Tag", value: "noindex, nofollow" },
  ];
  if (opts.production) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" });
  }
  return headers;
}
