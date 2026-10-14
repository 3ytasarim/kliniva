import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptBytes, encryptBytes } from "@/server/security/crypto";

/**
 * Özel (private) nesne deposu — imza görüntüleri ve imzalı PDF'ler.
 *  - PUBLIC URL YOKTUR. Dosyaya yalnızca yetki kontrolü yapan sunucu kodu (servis) erişir.
 *  - İçerik depoya yazılmadan önce AES-256-GCM ile şifrelenir; AAD = depolama anahtarı (dosya taşınırsa çözülmez).
 *  - Anahtarlar tahmin edilemez: <tenantId>/<tür>/<uuid>.
 *
 * Geliştirmede yerel diskte, Git'e girmeyen .private-storage/ klasörü kullanılır. Üretimde aynı arayüzü
 * uygulayan özel bucket adaptörü (S3/R2, public erişim kapalı) bağlanacaktır (bkz. docs/KVKK_ARCHITECTURE.md).
 */
export interface PrivateStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Var olan anahtarın üzerine yazılamaz (immutable). */
  exists(key: string): Promise<boolean>;
}

const KEY_RE = /^[0-9a-f-]{36}\/(signatures|pdfs|logos)\/[0-9a-f-]{36}\.(png|pdf)$/;

export function assertStorageKey(key: string) {
  if (!KEY_RE.test(key)) throw new Error("invalid storage key");
}

export class LocalEncryptedStorage implements PrivateStorage {
  constructor(private readonly root: string) {}

  private file(key: string) {
    assertStorageKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  async put(key: string, data: Buffer) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    // "wx": dosya varsa hata → imzalı içerik üzerine yazılamaz.
    await writeFile(file, encryptBytes(data, `storage:${key}`), { flag: "wx" });
  }

  async get(key: string) {
    try {
      return decryptBytes(await readFile(this.file(key)), `storage:${key}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async exists(key: string) {
    return (await this.get(key)) !== null;
  }
}

/** Testler için bellek içi depo (yine şifreli tutar). */
export class MemoryEncryptedStorage implements PrivateStorage {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    assertStorageKey(key);
    if (this.objects.has(key)) throw new Error("object exists");
    this.objects.set(key, encryptBytes(data, `storage:${key}`));
  }
  async get(key: string) {
    const blob = this.objects.get(key);
    return blob ? decryptBytes(blob, `storage:${key}`) : null;
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}

let storage: PrivateStorage | undefined;

export function getPrivateStorage(): PrivateStorage {
  storage ??= new LocalEncryptedStorage(
    path.resolve(/*turbopackIgnore: true*/ process.env.PRIVATE_STORAGE_DIR ?? ".private-storage"),
  );
  return storage;
}

export function setPrivateStorageForTests(next: PrivateStorage) {
  storage = next;
}
