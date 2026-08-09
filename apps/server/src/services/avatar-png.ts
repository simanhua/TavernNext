import { inflateSync } from 'node:zlib';
import { stripPngTextMetadata } from '@tavernnext/st-compat';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_DIMENSION = 32_768;
const MAX_PIXELS = 64 * 1024 * 1024;
const MAX_SCANLINES = 65_536;
const ADAM7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
] as const;

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  interlace: 0 | 1;
}

let crcTable: Uint32Array | undefined;

function table(): Uint32Array {
  if (crcTable !== undefined) return crcTable;
  crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
  return crcTable;
}

function crc32(bytes: Uint8Array): number {
  const values = table();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = values[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function fail(): never {
  throw new Error('Invalid PNG raster');
}

function parseHeader(data: Buffer): Header {
  if (data.byteLength !== 13) fail();
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8]!;
  const colorType = data[9]!;
  const allowedDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
  };
  if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION
    || !Number.isSafeInteger(width * height) || width * height > MAX_PIXELS
    || !Object.hasOwn(allowedDepths, colorType)
    || !allowedDepths[colorType]!.includes(bitDepth)
    || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) fail();
  return { width, height, bitDepth, colorType: colorType as Header['colorType'], interlace: data[12] as 0 | 1 };
}

function passSize(length: number, start: number, step: number): number {
  return length <= start ? 0 : Math.ceil((length - start) / step);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function validatePass(
  decoded: Buffer,
  offset: number,
  width: number,
  height: number,
  bitsPerPixel: number,
  paletteEntries: number | undefined,
): number {
  if (width === 0 || height === 0) return offset;
  const rowBytes = Math.ceil(width * bitsPerPixel / 8);
  const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  let prior = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = decoded[offset];
    if (filter === undefined || filter > 4 || offset + 1 + rowBytes > decoded.byteLength) fail();
    offset += 1;
    const row = Buffer.allocUnsafe(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const raw = decoded[offset + index]!;
      const left = index >= bytesPerPixel ? row[index - bytesPerPixel]! : 0;
      const above = prior[index]!;
      const upperLeft = index >= bytesPerPixel ? prior[index - bytesPerPixel]! : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2)
              : paeth(left, above, upperLeft);
      row[index] = (raw + predictor) & 0xff;
    }
    if (paletteEntries !== undefined) {
      for (let x = 0; x < width; x += 1) {
        const bitOffset = x * bitsPerPixel;
        const byte = row[Math.floor(bitOffset / 8)]!;
        const shift = 8 - bitsPerPixel - (bitOffset % 8);
        const index = (byte >>> shift) & ((1 << bitsPerPixel) - 1);
        if (index >= paletteEntries) fail();
      }
    }
    offset += rowBytes;
    prior = row;
  }
  return offset;
}

export function validatePngRaster(input: Uint8Array): void {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail();
  let offset = 8;
  let header: Header | undefined;
  let paletteEntries: number | undefined;
  let sawIdat = false;
  let idatEnded = false;
  let sawEnd = false;
  const compressed: Buffer[] = [];

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) fail();
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.byteLength) fail();
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) fail();
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail();
    if (header === undefined && type !== 'IHDR') fail();
    if (type === 'IHDR') {
      if (header !== undefined || offset !== 8) fail();
      header = parseHeader(data);
    } else if (type === 'PLTE') {
      if (sawIdat || paletteEntries !== undefined || length === 0 || length > 768 || length % 3 !== 0) fail();
      if (header!.colorType === 0 || header!.colorType === 4) fail();
      paletteEntries = length / 3;
      if (header!.colorType === 3 && paletteEntries > 2 ** header!.bitDepth) fail();
    } else if (type === 'IDAT') {
      if (idatEnded || (header!.colorType === 3 && paletteEntries === undefined)) fail();
      sawIdat = true;
      compressed.push(data);
    } else if (type === 'IEND') {
      if (!sawIdat || length !== 0 || chunkEnd !== bytes.byteLength) fail();
      sawEnd = true;
    } else {
      if (sawIdat) idatEnded = true;
      if ((typeBytes[0]! & 0x20) === 0) fail();
    }
    offset = chunkEnd;
    if (sawEnd) break;
  }
  if (header === undefined || !sawIdat || !sawEnd || offset !== bytes.byteLength) fail();

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  const bitsPerPixel = channels * header.bitDepth;
  const passes = header.interlace === 0 ? [[0, 0, 1, 1] as const] : ADAM7;
  let expected = 0;
  const dimensions: Array<readonly [number, number]> = [];
  let scanlines = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const width = passSize(header.width, startX, stepX);
    const height = passSize(header.height, startY, stepY);
    dimensions.push([width, height]);
    scanlines += height;
    if (width !== 0 && height !== 0) expected += height * (1 + Math.ceil(width * bitsPerPixel / 8));
    if (!Number.isSafeInteger(expected) || expected > MAX_DECODED_BYTES || scanlines > MAX_SCANLINES) fail();
  }
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 });
  } catch {
    fail();
  }
  if (decoded.byteLength !== expected) fail();
  let decodedOffset = 0;
  for (const [width, height] of dimensions) {
    decodedOffset = validatePass(decoded, decodedOffset, width, height, bitsPerPixel, header.colorType === 3 ? paletteEntries : undefined);
  }
  if (decodedOffset !== decoded.byteLength) fail();
}

export function sanitizePublicPng(input: Uint8Array): Uint8Array {
  validatePngRaster(input);
  const sanitized = stripPngTextMetadata(input);
  validatePngRaster(sanitized);
  return sanitized;
}
