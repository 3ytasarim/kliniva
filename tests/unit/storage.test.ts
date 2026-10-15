import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { signV4, sha256Hex, encodeKeyPath } from "@/server/storage/sigv4";
import {
  createStorageFromEnv,
  isDeletionAllowed,
  keyBelongsToTenant,
  LocalEncryptedStorage,
  MemoryEncryptedStorage,
  newStorageKey,
  parseStorageKey,
  S3CompatiblePrivateStorage,
} from "@/server/storage/private-storage";

const T1 = randomUUID();
const T2 = randomUUID();

describe("AWS SigV4", () => {
  it("AWS'nin resmi GET Object örnek vektörüyle aynı imzayı üretir", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (yayımlanmış ÖRNEK anahtarlar)
    const empty = sha256Hex("");
    const r = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": empty,
        "x-amz-date": "20130524T000000Z",
      },
      payloadSha256: empty,
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });
    expect(r.signedHeaders).toBe("host;range;x-amz-content-sha256;x-amz-date");
    expect(r.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("anahtar yolu RFC 3986 ile kodlanır, '/' korunur", () => {
    expect(encodeKeyPath("tenant/a b/x(1).bin")).toBe("tenant/a%20b/x%281%29.bin");
  });
});

describe("Depolama anahtarları", () => {
  it("biçim tenant/<uuid>/<tür>/<uuid>.bin; hasta adı / PII içermez", () => {
    const k = newStorageKey(T1, "documents");
    expect(k).toMatch(/^tenant\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\.bin$/);
    expect(parseStorageKey(k)).toEqual({ tenantId: T1, kind: "documents" });
  });

  it("kiracı aidiyeti: başka kiracının anahtarı reddedilir; geçersiz/yol geçişli anahtar tanınmaz", () => {
    const k = newStorageKey(T1, "signatures");
    expect(keyBelongsToTenant(k, T1)).toBe(true);
    expect(keyBelongsToTenant(k, T2)).toBe(false);
    expect(parseStorageKey(`tenant/${T1}/documents/../../etc/passwd`)).toBeNull();
    expect(parseStorageKey(`tenant/${T1}/secrets/${randomUUID()}.bin`)).toBeNull();
  });

  it("silme politikası: imzalı kanıt yalnızca yasal imhada, logo her zaman", () => {
    expect(isDeletionAllowed(newStorageKey(T1, "documents"))).toBe(false);
    expect(isDeletionAllowed(newStorageKey(T1, "signatures"))).toBe(false);
    expect(isDeletionAllowed(newStorageKey(T1, "documents"), { retentionPurge: true })).toBe(true);
    expect(isDeletionAllowed(newStorageKey(T1, "logos"))).toBe(true);
    expect(isDeletionAllowed("bozuk-anahtar", { retentionPurge: true })).toBe(false);
  });
});

describe("Bellek / yerel şifreli depo", () => {
  it("deleteIfAllowed: belge silinmez (false), imha bağlamında silinir", async () => {
    const s = new MemoryEncryptedStorage();
    const k = newStorageKey(T1, "documents");
    await s.put(k, Buffer.from("%PDF-1.7 test"));
    expect(await s.deleteIfAllowed(k)).toBe(false);
    expect(await s.exists(k)).toBe(true);
    expect(await s.deleteIfAllowed(k, { retentionPurge: true })).toBe(true);
    expect(await s.exists(k)).toBe(false);
  });

  it("aynı anahtarın üzerine yazılamaz", async () => {
    const s = new MemoryEncryptedStorage();
    const k = newStorageKey(T1, "documents");
    await s.put(k, Buffer.from("bir"));
    await expect(s.put(k, Buffer.from("iki"))).rejects.toThrow();
    expect((await s.get(k))!.toString()).toBe("bir");
  });

  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("yerel depo diske yalnızca şifreli bayt yazar; üzerine yazma reddedilir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kliniva-storage-"));
    dirs.push(dir);
    const s = new LocalEncryptedStorage(dir);
    const k = newStorageKey(T1, "documents");
    await s.put(k, Buffer.from("%PDF-1.7 gizli içerik"));
    const file = path.join(dir, ...k.split("/"));
    const raw = await readFile(file);
    expect(raw.toString("latin1")).not.toContain("%PDF");
    expect(raw.toString("latin1")).not.toContain("gizli");
    expect((await s.get(k))!.toString()).toBe("%PDF-1.7 gizli içerik");
    await expect(s.put(k, Buffer.from("x"))).rejects.toThrow();
    expect(await s.deleteIfAllowed(k)).toBe(false);
    expect(await readdir(path.dirname(file))).toHaveLength(1);
  });
});

describe("S3 uyumlu özel depo (sahte fetch)", () => {
  type Call = { url: string; method: string; headers: Record<string, string>; body?: Uint8Array };
  const make = (respond: (c: Call) => Response) => {
    const calls: Call[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      const c: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: init?.body as Uint8Array | undefined,
      };
      calls.push(c);
      return respond(c);
    }) as typeof fetch;
    const s = new S3CompatiblePrivateStorage({
      endpoint: "https://r2.example.invalid",
      region: "auto",
      bucket: "kliniva-private",
      accessKeyId: "TESTKEY",
      secretAccessKey: "TESTSECRET",
      fetchImpl,
    });
    return { s, calls };
  };

  it("PUT: path-style URL, SigV4, If-None-Match:* , ACL başlığı YOK, gövde şifreli", async () => {
    const { s, calls } = make(() => new Response(null, { status: 200 }));
    const k = newStorageKey(T1, "documents");
    await s.put(k, Buffer.from("%PDF-1.7 hasta belgesi"));
    const c = calls[0]!;
    expect(c.method).toBe("PUT");
    expect(c.url).toBe(`https://r2.example.invalid/kliniva-private/${k}`);
    expect(c.headers["if-none-match"]).toBe("*");
    expect(Object.keys(c.headers).some((h) => h.toLowerCase().startsWith("x-amz-acl"))).toBe(false);
    expect(c.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=TESTKEY\/\d{8}\/auto\/s3\/aws4_request/,
    );
    expect(c.headers.authorization).not.toContain("TESTSECRET");
    const body = Buffer.from(c.body!);
    expect(body.toString("latin1")).not.toContain("%PDF");
    expect(c.headers["x-amz-content-sha256"]).toBe(sha256Hex(body));
  });

  it("var olan nesne (412) → hata; üzerine yazılmaz", async () => {
    const { s } = make(() => new Response(null, { status: 412 }));
    await expect(s.put(newStorageKey(T1, "documents"), Buffer.from("x"))).rejects.toThrow(/exists/);
  });

  it("GET: şifreli gövde çözülür; 404 → null", async () => {
    const stored = new Map<string, Uint8Array>();
    const { s } = make((c) => {
      if (c.method === "PUT") {
        stored.set(c.url, c.body!);
        return new Response(null, { status: 200 });
      }
      const b = stored.get(c.url);
      return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response(null, { status: 404 });
    });
    const k = newStorageKey(T1, "signatures");
    await s.put(k, Buffer.from("PNG-bytes"));
    expect((await s.get(k))!.toString()).toBe("PNG-bytes");
    expect(await s.get(newStorageKey(T1, "signatures"))).toBeNull();
  });

  it("deleteIfAllowed: belge için ağ isteği bile yapılmaz", async () => {
    const { s, calls } = make(() => new Response(null, { status: 204 }));
    expect(await s.deleteIfAllowed(newStorageKey(T1, "documents"))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await s.deleteIfAllowed(newStorageKey(T1, "logos"))).toBe(true);
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("ortam yapılandırması: eksik değişkenlerin yalnızca ADLARI raporlanır", () => {
    expect(() =>
      createStorageFromEnv({
        PRIVATE_STORAGE_DRIVER: "s3",
        S3_ACCESS_KEY_ID: "gizli-deger",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/S3_ENDPOINT, S3_BUCKET, S3_SECRET_ACCESS_KEY/);
    try {
      createStorageFromEnv({
        PRIVATE_STORAGE_DRIVER: "s3",
        S3_ACCESS_KEY_ID: "gizli-deger",
      } as unknown as NodeJS.ProcessEnv);
    } catch (e) {
      expect((e as Error).message).not.toContain("gizli-deger");
    }
    expect(() =>
      createStorageFromEnv({ PRIVATE_STORAGE_DRIVER: "ftp" } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
    expect(
      createStorageFromEnv({
        PRIVATE_STORAGE_DRIVER: "s3",
        S3_ENDPOINT: "https://x.invalid",
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "s",
      } as unknown as NodeJS.ProcessEnv),
    ).toBeInstanceOf(S3CompatiblePrivateStorage);
  });
});
