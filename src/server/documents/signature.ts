/**
 * Hasta imzası — YALNIZCA STATİK GÖRÜNTÜ.
 *
 * İstemcideki imza alanı yalnızca canvas üzerindeki çizimi PNG olarak üretir. Kalem basıncı, hız, ivme,
 * vuruş zamanlaması, kalem açısı veya herhangi bir biyometrik/davranışsal özellik TOPLANMAZ ve SAKLANMAZ.
 *
 * Sunucu, istemciden gelen PNG'yi körü körüne kabul etmez: PNG yeniden paketlenir ve yalnızca görüntü için
 * gereken kritik parçalar (IHDR, PLTE, tRNS, IDAT, IEND) tutulur. tEXt/zTXt/iTXt/eXIf vb. tüm meta veri
 * parçaları atılır — kötü niyetli/hatalı bir istemci görüntüye zaman damgası, basınç verisi vb. gömemez.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ALLOWED_CHUNKS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

export const SIGNATURE_LIMITS = {
  maxBytes: 300 * 1024,
  maxWidth: 2000,
  maxHeight: 1000,
  minWidth: 50,
  minHeight: 20,
} as const;

export class InvalidSignatureError extends Error {
  constructor(reason: string) {
    super(`invalid signature image: ${reason}`);
    this.name = "InvalidSignatureError";
  }
}

/** "data:image/png;base64,..." veya düz base64 → Buffer. */
export function decodeSignatureDataUrl(input: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.trim());
  const b64 = m ? m[1]! : input.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new InvalidSignatureError("encoding");
  if ((b64.length * 3) / 4 > SIGNATURE_LIMITS.maxBytes + 4) throw new InvalidSignatureError("too large");
  return Buffer.from(b64, "base64");
}

/** PNG'yi doğrular ve yalnızca izin verilen parçalarla yeniden kurar. */
export function sanitizeSignaturePng(png: Buffer): { png: Buffer; width: number; height: number } {
  if (png.length > SIGNATURE_LIMITS.maxBytes) throw new InvalidSignatureError("too large");
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new InvalidSignatureError("not png");

  const kept: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIend = false;
  let sawIdat = false;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) throw new InvalidSignatureError("truncated");
    if (offset === 8 && type !== "IHDR") throw new InvalidSignatureError("missing IHDR");
    if (type === "IHDR") {
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
    }
    if (type === "IDAT") sawIdat = true;
    if (ALLOWED_CHUNKS.has(type)) kept.push(png.subarray(offset, end));
    offset = end;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIend || !sawIdat) throw new InvalidSignatureError("incomplete");
  if (
    width < SIGNATURE_LIMITS.minWidth ||
    height < SIGNATURE_LIMITS.minHeight ||
    width > SIGNATURE_LIMITS.maxWidth ||
    height > SIGNATURE_LIMITS.maxHeight
  ) {
    throw new InvalidSignatureError("dimensions");
  }
  return { png: Buffer.concat(kept), width, height };
}
