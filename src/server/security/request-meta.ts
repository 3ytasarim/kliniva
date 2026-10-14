import "server-only";
import { keyedHash } from "@/server/security/crypto";

/**
 * İstek meta verisi — denetim/oturum kayıtları için minimum veri:
 *   - IP adresi düz metin SAKLANMAZ; anahtarlı HMAC özeti (ip_hash) tutulur.
 *   - User-Agent tam metni yerine kaba özet (tarayıcı + işletim sistemi ailesi) tutulur.
 */
export type RequestMeta = { ipHash: string | null; userAgentSummary: string | null };

export function clientIpFrom(headers: Headers): string | null {
  // Vercel/Cloudflare arkasında ilk x-forwarded-for değeri istemcidir. Doğrudan erişimde x-real-ip.
  const xff = headers.get("x-forwarded-for");
  const ip = xff?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || null;
  return ip && ip.length <= 64 ? ip : null;
}

export function summarizeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Other";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Other";
  return `${browser}/${os}`;
}

export function requestMetaFrom(headers: Headers): RequestMeta {
  const ip = clientIpFrom(headers);
  return {
    ipHash: ip ? keyedHash("ip", ip) : null,
    userAgentSummary: summarizeUserAgent(headers.get("user-agent")),
  };
}

export const EMPTY_META: RequestMeta = { ipHash: null, userAgentSummary: null };
