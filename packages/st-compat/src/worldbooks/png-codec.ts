import extractPngChunks from 'png-chunks-extract';
import { decode as decodePngText } from 'png-chunk-text';
import { NativeWorldbookSchema, type JsonObject } from './schemas.js';
import { WorldbookCodecError } from './native-codec.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

function decodeStrictBase64(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed)) {
    throw new WorldbookCodecError('worldbook_png_metadata_invalid', 'PNG naidata metadata is not valid base64.');
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
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(decodeStrictBase64(encoded)));
  } catch (error) {
    if (error instanceof WorldbookCodecError) throw error;
    throw new WorldbookCodecError('worldbook_png_metadata_invalid', 'PNG naidata metadata is not valid UTF-8 JSON.');
  }
  const parsed = NativeWorldbookSchema.safeParse(value);
  if (!parsed.success || !Object.values(parsed.data.entries).every((entry) => typeof entry.content === 'string')) {
    throw new WorldbookCodecError('worldbook_decode_failed', 'PNG naidata metadata is not a native Worldbook document.');
  }
  return parsed.data;
}
