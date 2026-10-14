import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Logo yükleme (en çok 5 MB; multipart ek yükü için pay). Asıl sınır sunucuda (processLogo) ayrıca uygulanır.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  serverExternalPackages: ["@node-rs/argon2", "sharp"],
  reactStrictMode: true,
  // Argon2 yerel (native) modüldür; sunucu paketine dahil edilmez, çalışma anında node_modules'tan yüklenir.
  // İmzalı PDF üretimi yazı tiplerini diskten okur.
  outputFileTracingIncludes: {
    "/patients/**": ["./assets/fonts/**"],
    "/api/**": ["./assets/fonts/**"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: staticSecurityHeaders({ production: process.env.NODE_ENV === "production" }),
      },
    ];
  },
};

export default nextConfig;
