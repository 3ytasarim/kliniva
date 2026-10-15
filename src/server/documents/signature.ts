import sharp from "sharp";

/**
 * Hasta imzası — YALNIZCA STATİK RASTER GÖRÜNTÜ.
 *
 * İstemcideki imza alanı yalnızca canvas üzerindeki çizimi PNG olarak üretir. Kalem basıncı, hız, ivme, vuruş
 * zamanlaması / yörüngesi, kalem açısı veya herhangi bir biyometrik / davranışsal özellik TOPLANMAZ, SAKLANMAZ.
 *
 * Sunucu istemci yükünü doğrudan depoya KOYMAZ:
 *   1. boyut sınırı (decode'dan önce) · 2. PNG imzası (magic bytes) · 3. sharp/libvips ile gerçek decode
 *   4. boyut sınırları · 5. yeniden kodlama (yeni PNG) → tüm meta veri parçaları (tEXt/iTXt/zTXt/eXIf/ICC) atılır.
 * Saklanan tek şey bu yeniden kodlanmış raster görüntüdür.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const SIGNATURE_LIMITS = {
  maxBytes: 300 * 1024,
  maxWidth: 2400,
  maxHeight: 1200,
  minWidth: 50,
  minHeight: 20,
} as const;

export class InvalidSignatureError extends Error {
  constructor(reason: string) {
    super(`invalid signature image: ${reason}`);
    this.name = "InvalidSignatureError";
  }
}

/** "data:image/png;base64,..." veya düz base64 → Buffer. SVG / diğer MIME data URI'leri reddedilir. */
export function decodeSignatureDataUrl(input: string): Buffer {
  const trimmed = input.trim();
  if (trimmed.startsWith("data:") && !trimmed.startsWith("data:image/png;base64,")) {
    throw new InvalidSignatureError("unsupported type");
  }
  const b64 = trimmed.startsWith("data:") ? trimmed.slice("data:image/png;base64,".length) : trimmed;
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new InvalidSignatureError("encoding");
  if ((b64.length * 3) / 4 > SIGNATURE_LIMITS.maxBytes + 4) throw new InvalidSignatureError("too large");
  return Buffer.from(b64, "base64");
}

/** PNG'yi doğrular, decode eder ve meta verisiz yeni bir PNG olarak yeniden kodlar. */
export async function sanitizeSignaturePng(
  png: Buffer,
): Promise<{ png: Buffer; width: number; height: number }> {
  if (png.length > SIGNATURE_LIMITS.maxBytes) throw new InvalidSignatureError("too large");
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new InvalidSignatureError("not png");

  let width = 0;
  let height = 0;
  try {
    const meta = await sharp(png, { failOn: "error", limitInputPixels: 4_000_000 }).metadata();
    if (meta.format !== "png") throw new Error("format");
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    throw new InvalidSignatureError("decode failed");
  }
  if (
    width < SIGNATURE_LIMITS.minWidth ||
    height < SIGNATURE_LIMITS.minHeight ||
    width > SIGNATURE_LIMITS.maxWidth ||
    height > SIGNATURE_LIMITS.maxHeight
  ) {
    throw new InvalidSignatureError("dimensions");
  }
  try {
    // Yeni PNG: sharp varsayılan olarak hiçbir meta veriyi (EXIF/ICC/metin) çıktıya taşımaz.
    const out = await sharp(png, { failOn: "error", limitInputPixels: 4_000_000 })
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
    return { png: out, width, height };
  } catch {
    throw new InvalidSignatureError("decode failed");
  }
}
