import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Uygulama düzeyi alan şifreleme — AES-256-GCM (authenticated encryption).
 *
 * Şifreli metin biçimi (metin alanları):  v1.<iv>.<tag>.<ciphertext>   (her parça base64url)
 *   - v1          : biçim/anahtar versiyonu (anahtar rotasyonunda v2… eklenir, eski versiyon okunmaya devam eder)
 *   - iv (nonce)  : her şifrelemede crypto.randomBytes(12) — ASLA tekrar kullanılmaz
 *   - tag         : 16 baytlık GCM doğrulama etiketi (bütünlük)
 *   - ciphertext
 * AAD (ek doğrulanmış veri): şifreli değeri bağlamına bağlar (ör. "patient.notes:<tenantId>:<patientId>").
 * Böylece bir hastanın şifreli notu başka satıra kopyalanırsa çözülemez.
 *
 * Anahtar: APP_ENCRYPTION_KEY (32 bayt, base64) — yalnızca ortam değişkeni; DB'de/kaynakta/Git'te tutulmaz.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BYTES_MAGIC = 0x01; // ikili biçim versiyonu

export class DecryptionError extends Error {
  constructor() {
    super("Decryption failed");
    this.name = "DecryptionError";
  }
}

let cachedKey: Buffer | undefined;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error("APP_ENCRYPTION_KEY is required");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes (base64)");
  cachedKey = key;
  return key;
}

/** Testler için: önbelleğe alınmış anahtarı sıfırlar. */
export function resetKeyCacheForTests() {
  cachedKey = undefined;
}

const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

function requireAad(aad: string) {
  if (!aad) throw new Error("encryption context (AAD) is required");
}

export function encryptField(plaintext: string, aad: string, key: Buffer = masterKey()): string {
  requireAad(aad);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(".");
}

export function decryptField(payload: string, aad: string, key: Buffer = masterKey()): string {
  requireAad(aad);
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new DecryptionError();
  const [, ivS, tagS, ctS] = parts as [string, string, string, string];
  const iv = fromB64u(ivS);
  const tag = fromB64u(tagS);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(fromB64u(ctS)), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionError();
  }
}

/** İkili veri (imza görüntüsü, PDF) için: [1 bayt versiyon][12 iv][16 tag][ciphertext]. */
export function encryptBytes(data: Buffer, aad: string, key: Buffer = masterKey()): Buffer {
  requireAad(aad);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from([BYTES_MAGIC]), iv, cipher.getAuthTag(), ct]);
}

export function decryptBytes(blob: Buffer, aad: string, key: Buffer = masterKey()): Buffer {
  requireAad(aad);
  if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== BYTES_MAGIC) throw new DecryptionError();
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/** Amaca özel alt anahtar (HKDF-SHA256). Şifreleme anahtarı doğrudan HMAC için kullanılmaz. */
function subkey(purpose: string, key: Buffer = masterKey()): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `kliniva:${purpose}`, 32));
}

/** Anahtarlı özet (ör. IP, rate-limit anahtarı) — geri döndürülemez, sözlük saldırısına dayanıklı. */
export function keyedHash(purpose: string, value: string, key?: Buffer): string {
  return createHmac("sha256", subkey(purpose, key)).update(value, "utf8").digest("base64url").slice(0, 32);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Kriptografik rastgele token (oturum vb.), base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
