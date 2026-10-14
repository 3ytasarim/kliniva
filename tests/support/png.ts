import { crc32, deflateSync } from "node:zlib";

/** Test için geçerli PNG üretir (RGBA, düz renk) — isteğe bağlı ek meta veri parçasıyla. */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function makePng(
  width = 200,
  height = 80,
  extraChunks: { type: string; data: Buffer }[] = [],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.alloc(1 + width * 4, 0);
  for (let x = 0; x < width; x++) row.writeUInt32BE(x % 7 === 0 ? 0x111827ff : 0xffffff00, 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...extraChunks.map((c) => chunk(c.type, c.data)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const pngDataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;
