import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptBytes, encryptBytes } from "@/server/security/crypto";
import { logger } from "@/server/log/logger";
import { amzDateOf, encodeKeyPath, sha256Hex, signV4 } from "@/server/storage/sigv4";

/**
 * Özel (private) nesne deposu — imzalı PDF'ler, imza görüntüleri, klinik logoları.
 *
 *  - PUBLIC URL / PUBLIC ACL YOKTUR. Nesnelere yalnızca yetki kontrolü yapan sunucu kodu erişir.
 *  - İçerik depoya yazılmadan önce uygulama düzeyinde AES-256-GCM ile şifrelenir (AAD = depolama anahtarı):
 *    bucket ele geçirilse bile içerik okunamaz; nesne başka anahtara taşınırsa çözülmez.
 *  - Anahtarlar tahmin edilemez ve PII İÇERMEZ: tenant/<tenantUuid>/<tür>/<uuid>.bin
 *    (hasta adı / telefon / e-posta / TC asla anahtarda yer almaz). Anahtar tahmin edilse bile içerik yalnızca
 *    yetkili servis üzerinden, kiracı + şube kapsamı doğrulanarak sunulur.
 *  - Yazma "yalnızca oluştur": var olan anahtarın üzerine yazılamaz (imzalı içerik değiştirilemez).
 *  - Silme: deleteIfAllowed() — imzalı belge ve imzalar yalnızca yasal imha bağlamında silinebilir.
 *
 * Sürücü: PRIVATE_STORAGE_DRIVER=local (varsayılan, geliştirme) | s3 (S3 / Cloudflare R2 uyumlu, üretim).
 */
export type StorageKind = "documents" | "signatures" | "logos" | "clinical";

export interface PrivateStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  /** Silme politikası uygulanır; izin yoksa false döner ve hiçbir şey silinmez. */
  deleteIfAllowed(key: string, opts?: { retentionPurge?: boolean }): Promise<boolean>;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_RE = new RegExp(`^tenant/(${UUID})/(documents|signatures|logos|clinical)/(${UUID})\\.bin$`);
/** Sprint 0–1 biçimi — yalnızca OKUMA için kabul edilir. */
const LEGACY_KEY_RE = new RegExp(`^(${UUID})/(signatures|pdfs|logos)/(${UUID})\\.(png|pdf)$`);

export function newStorageKey(tenantId: string, kind: StorageKind): string {
  return `tenant/${tenantId}/${kind}/${randomUUID()}.bin`;
}

export function parseStorageKey(key: string): { tenantId: string; kind: StorageKind } | null {
  const m = KEY_RE.exec(key);
  if (m) return { tenantId: m[1]!, kind: m[2] as StorageKind };
  const l = LEGACY_KEY_RE.exec(key);
  if (l) return { tenantId: l[1]!, kind: l[2] === "pdfs" ? "documents" : (l[2] as StorageKind) };
  return null;
}

export function assertStorageKey(key: string, opts: { write?: boolean } = {}) {
  if (opts.write ? !KEY_RE.test(key) : !parseStorageKey(key)) throw new Error("invalid storage key");
}

/** Anahtar bu kiracıya mı ait? (Servisler okumadan önce savunma derinliği olarak kontrol eder.) */
export function keyBelongsToTenant(key: string | null | undefined, tenantId: string): boolean {
  return Boolean(key && parseStorageKey(key)?.tenantId === tenantId);
}

export function isDeletionAllowed(key: string, opts: { retentionPurge?: boolean } = {}): boolean {
  const parsed = parseStorageKey(key);
  if (!parsed) return false;
  // Logo değiştirildiğinde eskisi silinebilir; imzalı kanıt yalnızca yasal imhada.
  return parsed.kind === "logos" || opts.retentionPurge === true;
}

const aad = (key: string) => `storage:${key}`;

// ---------------------------------------------------------------- yerel (geliştirme / test)

export class LocalEncryptedStorage implements PrivateStorage {
  constructor(private readonly root: string) {}

  private file(key: string) {
    return path.join(this.root, ...key.split("/"));
  }

  async put(key: string, data: Buffer) {
    assertStorageKey(key, { write: true });
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    // "wx": dosya varsa hata → imzalı içerik üzerine yazılamaz.
    await writeFile(file, encryptBytes(data, aad(key)), { flag: "wx" });
  }

  async get(key: string) {
    assertStorageKey(key);
    try {
      return decryptBytes(await readFile(this.file(key)), aad(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async exists(key: string) {
    assertStorageKey(key);
    try {
      await readFile(this.file(key));
      return true;
    } catch {
      return false;
    }
  }

  async deleteIfAllowed(key: string, opts: { retentionPurge?: boolean } = {}) {
    if (!isDeletionAllowed(key, opts)) return false;
    await unlink(this.file(key)).catch(() => undefined);
    return true;
  }
}

/** Testler için bellek içi depo (yine şifreli tutar). `objects` testte kurcalama simülasyonu için açıktır. */
export class MemoryEncryptedStorage implements PrivateStorage {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    assertStorageKey(key, { write: true });
    if (this.objects.has(key)) throw new Error("object exists");
    this.objects.set(key, encryptBytes(data, aad(key)));
  }
  async get(key: string) {
    const blob = this.objects.get(key);
    return blob ? decryptBytes(blob, aad(key)) : null;
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async deleteIfAllowed(key: string, opts: { retentionPurge?: boolean } = {}) {
    if (!isDeletionAllowed(key, opts)) return false;
    return this.objects.delete(key);
  }
}

// ---------------------------------------------------------------- S3 / R2 (üretim)

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
};

/**
 * S3 uyumlu özel depo (AWS S3, Cloudflare R2, MinIO). Path-style istekler, SigV4 imzası.
 *  - ACL başlığı GÖNDERİLMEZ (bucket özel olmalı; public erişim kapalı).
 *  - PUT "If-None-Match: *" ile koşullu → var olan nesnenin üzerine yazılamaz.
 *  - Gövde uygulama düzeyinde şifrelidir; sağlayıcı hiçbir zaman düz PDF/imza görmez.
 */
export class S3CompatiblePrivateStorage implements PrivateStorage {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: S3Config) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private url(key: string) {
    const base = this.cfg.endpoint.replace(/\/+$/, "");
    return new URL(`${base}/${encodeKeyPath(this.cfg.bucket)}/${encodeKeyPath(key)}`);
  }

  private async send(method: string, key: string, body?: Buffer, extra: Record<string, string> = {}) {
    const url = this.url(key);
    const payloadSha256 = sha256Hex(body ?? Buffer.alloc(0));
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadSha256,
      "x-amz-date": amzDateOf(new Date()),
      ...extra,
    };
    const { authorization } = signV4({
      method,
      url,
      headers,
      payloadSha256,
      region: this.cfg.region,
      service: "s3",
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      amzDate: headers["x-amz-date"]!,
    });
    const { host: _host, ...sendHeaders } = headers;
    return this.fetchImpl(url, {
      method,
      headers: { ...sendHeaders, authorization },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  async put(key: string, data: Buffer) {
    assertStorageKey(key, { write: true });
    const res = await this.send("PUT", key, encryptBytes(data, aad(key)), {
      "content-type": "application/octet-stream",
      "if-none-match": "*",
    });
    if (res.status === 412) throw new Error("object exists");
    if (!res.ok) throw new Error(`storage put failed (${res.status})`);
  }

  async get(key: string) {
    assertStorageKey(key);
    const res = await this.send("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage get failed (${res.status})`);
    return decryptBytes(Buffer.from(await res.arrayBuffer()), aad(key));
  }

  async exists(key: string) {
    assertStorageKey(key);
    const res = await this.send("HEAD", key);
    return res.ok;
  }

  async deleteIfAllowed(key: string, opts: { retentionPurge?: boolean } = {}) {
    if (!isDeletionAllowed(key, opts)) return false;
    const res = await this.send("DELETE", key);
    return res.ok || res.status === 404;
  }
}

// ---------------------------------------------------------------- seçim

let storage: PrivateStorage | undefined;

/** Ortamdan sürücü seçer. Eksik S3 yapılandırmasında yalnızca değişken ADLARI raporlanır. */
export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): PrivateStorage {
  const driver = (env.PRIVATE_STORAGE_DRIVER ?? "local").toLowerCase();
  if (driver === "s3") {
    const required = ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
    const missing = required.filter((n) => !env[n]);
    if (missing.length) throw new Error(`PRIVATE_STORAGE_DRIVER=s3 requires: ${missing.join(", ")}`);
    return new S3CompatiblePrivateStorage({
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION || "auto",
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    });
  }
  if (driver !== "local") throw new Error("PRIVATE_STORAGE_DRIVER must be local or s3");
  if (env.NODE_ENV === "production") {
    logger.warn("storage.local_driver_in_production", { driver: "local" });
  }
  return new LocalEncryptedStorage(
    path.resolve(/*turbopackIgnore: true*/ env.PRIVATE_STORAGE_DIR ?? ".private-storage"),
  );
}

export function getPrivateStorage(): PrivateStorage {
  storage ??= createStorageFromEnv();
  return storage;
}

export function setPrivateStorageForTests(next: PrivateStorage) {
  storage = next;
}
