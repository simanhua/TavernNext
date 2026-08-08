const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const ihdrChunkName = [0x49, 0x48, 0x44, 0x52] as const;
const textChunkName = [0x74, 0x45, 0x58, 0x74] as const;
const iendChunkName = [0x49, 0x45, 0x4e, 0x44] as const;
const naidataKeyword = [0x6e, 0x61, 0x69, 0x64, 0x61, 0x74, 0x61] as const;

export type NaidataPngPreflightIssue = 'corrupt_png' | 'worldbook_preview_limit';

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset > bytes.length - expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

function matchesNaidataKeyword(bytes: Uint8Array, offset: number, chunkLength: number): boolean {
  if (chunkLength < naidataKeyword.length + 1 || bytes[offset + naidataKeyword.length] !== 0) return false;
  for (let index = 0; index < naidataKeyword.length; index += 1) {
    const value = bytes[offset + index]!;
    const lowerCaseAscii = value >= 0x41 && value <= 0x5a ? value + 0x20 : value;
    if (lowerCaseAscii !== naidataKeyword[index]) return false;
  }
  return true;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000
    + bytes[offset + 1]! * 0x10000
    + bytes[offset + 2]! * 0x100
    + bytes[offset + 3]!;
}

/**
 * Checks raw naidata tEXt lengths and PNG chunk bounds without materializing
 * chunk payloads. CRC validation remains the responsibility of the decoder.
 */
export function preflightNaidataPng(
  bytes: Uint8Array,
  maxRawValueBytes: number,
): NaidataPngPreflightIssue | undefined {
  if (!matches(bytes, 0, pngSignature)) return 'corrupt_png';
  let offset: number = pngSignature.length;
  let first = true;
  let ended = false;

  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    if (remaining < 12) return 'corrupt_png';
    const length = readUint32(bytes, offset);
    if (length > remaining - 12) return 'corrupt_png';

    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const nextOffset = offset + length + 12;
    if (first && !matches(bytes, typeOffset, ihdrChunkName)) return 'corrupt_png';

    if (
      matches(bytes, typeOffset, textChunkName)
      && matchesNaidataKeyword(bytes, dataOffset, length)
      && length - naidataKeyword.length - 1 > maxRawValueBytes
    ) return 'worldbook_preview_limit';

    if (matches(bytes, typeOffset, iendChunkName)) {
      if (length !== 0 || nextOffset !== bytes.length) return 'corrupt_png';
      ended = true;
    }

    offset = nextOffset;
    first = false;
  }

  return ended ? undefined : 'corrupt_png';
}
