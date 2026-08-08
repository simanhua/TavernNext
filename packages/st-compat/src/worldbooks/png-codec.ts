import extractPngChunks from 'png-chunks-extract';
import { decode as decodePngText } from 'png-chunk-text';
import type { JsonObject } from './schemas.js';
import { decodeJsonWorldbook, MAX_WORLDBOOK_PREVIEW_BYTES, WorldbookCodecError } from './native-codec.js';

function decodeStrictBase64(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed)) {
    throw new WorldbookCodecError('worldbook_png_metadata_invalid', 'PNG naidata metadata is not valid base64.');
  }
  if (trimmed.length > Math.ceil(MAX_WORLDBOOK_PREVIEW_BYTES / 3) * 4) {
    throw new WorldbookCodecError(
      'worldbook_preview_limit',
      `Worldbook source envelopes are limited to ${MAX_WORLDBOOK_PREVIEW_BYTES} bytes.`,
    );
  }
  return Buffer.from(trimmed, 'base64');
}

export function decodeNaidataPng(bytes: Uint8Array): JsonObject {
  let encoded: string | undefined;
  try {
    for (const chunk of extractPngChunks(bytes)) {
      if (chunk.name !== 'tEXt') continue;
      const text = decodePngText(chunk);
      if (text.keyword.toLowerCase() !== 'naidata') continue;
      if (encoded !== undefined) {
        throw new WorldbookCodecError(
          'worldbook_png_metadata_duplicate',
          'PNG contains duplicate case-folded naidata metadata.',
        );
      }
      encoded = text.text;
    }
  } catch (error) {
    if (error instanceof WorldbookCodecError) throw error;
    throw new WorldbookCodecError('corrupt_png', 'PNG chunks or checksums are corrupt.');
  }
  if (encoded === undefined) {
    throw new WorldbookCodecError('worldbook_png_metadata_invalid', 'PNG contains no naidata Worldbook metadata.');
  }
  let decoded: ReturnType<typeof decodeJsonWorldbook>;
  try {
    decoded = decodeJsonWorldbook(decodeStrictBase64(encoded));
  } catch (error) {
    if (error instanceof WorldbookCodecError && error.code !== 'invalid_json') throw error;
    throw new WorldbookCodecError(
      'worldbook_png_metadata_invalid',
      'PNG naidata metadata is not valid UTF-8 JSON.',
    );
  }
  if (decoded.sourceFormat !== 'st-native') {
    throw new WorldbookCodecError('worldbook_decode_failed', 'PNG naidata metadata is not a native Worldbook document.');
  }
  return decoded.rawPayload;
}
