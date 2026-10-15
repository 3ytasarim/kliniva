import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 (S3 / Cloudflare R2 / MinIO uyumlu) — bağımlılıksız, denetlenebilir küçük uygulama.
 * AWS'nin yayımladığı resmi test vektörüyle doğrulanır (tests/unit/storage.test.ts).
 */
export type SigV4Input = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadSha256: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
};

export const sha256Hex = (data: string | Buffer | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 kodlaması; S3 anahtarındaki "/" korunur. */
export function encodeKeyPath(path: string): string {
  return path
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

export function signV4(input: SigV4Input): {
  authorization: string;
  signedHeaders: string;
  signature: string;
} {
  const date = input.amzDate.slice(0, 8);
  const headers = Object.fromEntries(
    Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]),
  );
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname || "/",
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join("\n");
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return {
    signature,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export const amzDateOf = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
