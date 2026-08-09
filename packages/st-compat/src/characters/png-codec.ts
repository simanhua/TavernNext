import { decode as decodePngText, encode as encodePngText } from 'png-chunk-text';
import encodePngChunks from 'png-chunks-encode';
import extractPngChunks from 'png-chunks-extract';
import { diagnostic } from '../warnings.js';
import { CharacterCodecError, decodeCharacterJson } from './json-codec.js';

const metadataKeyword = new Set(['chara', 'ccv3']);

function decodeBase64(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed)) {
    throw new CharacterCodecError(diagnostic('character_metadata_invalid_base64', 'PNG Character metadata is not valid base64.'));
  }
  return new Uint8Array(Buffer.from(trimmed, 'base64'));
}

export function decodeCharacterPng(bytes: Uint8Array, maxMetadataBytes: number) {
  const payloads: Record<string, ReturnType<typeof decodeCharacterJson>> = {};
  try {
    for (const chunk of extractPngChunks(bytes)) {
      if (chunk.name !== 'tEXt') continue;
      const text = decodePngText(chunk);
      const keyword = text.keyword.toLowerCase();
      if (!metadataKeyword.has(keyword)) continue;
      if (payloads[keyword] !== undefined) {
        throw new CharacterCodecError(diagnostic(
          'character_png_metadata_duplicate',
          `PNG contains more than one ${keyword} Character metadata chunk.`,
        ));
      }
      const decoded = decodeBase64(text.text);
      if (decoded.byteLength > maxMetadataBytes) {
        throw new CharacterCodecError(diagnostic(
          'character_metadata_too_large',
          `PNG Character metadata exceeds the ${maxMetadataBytes}-byte memory limit.`,
        ));
      }
      payloads[keyword] = decodeCharacterJson(decoded);
    }
  } catch (error) {
    if (error instanceof CharacterCodecError) throw error;
    throw new CharacterCodecError(diagnostic('corrupt_png', 'PNG chunks or Character metadata are corrupt.'));
  }
  const selectedPayload = payloads.ccv3 === undefined ? 'chara' : 'ccv3';
  const selected = payloads[selectedPayload];
  if (selected === undefined) {
    throw new CharacterCodecError(diagnostic('character_png_metadata_missing', 'PNG contains no chara or ccv3 Character metadata.'));
  }
  return {
    selectedPayload,
    selected,
    rawPayloads: Object.fromEntries(Object.entries(payloads).map(([key, value]) => [key, value.raw])),
  };
}

export function encodeCharacterPng(basePng: Uint8Array, v2: unknown, v3: unknown): Uint8Array {
  const chunks = extractPngChunks(basePng).filter((chunk) => {
    if (chunk.name !== 'tEXt') return true;
    try {
      return !metadataKeyword.has(decodePngText(chunk).keyword.toLowerCase());
    } catch {
      return true;
    }
  });
  const iend = chunks.findIndex((chunk) => chunk.name === 'IEND');
  if (iend < 0) throw new CharacterCodecError(diagnostic('corrupt_png', 'PNG is missing its IEND chunk.'));
  chunks.splice(
    iend,
    0,
    encodePngText('chara', Buffer.from(JSON.stringify(v2)).toString('base64')),
    encodePngText('ccv3', Buffer.from(JSON.stringify(v3)).toString('base64')),
  );
  return encodePngChunks(chunks);
}

/** Remove text-bearing PNG chunks before an imported card image is exposed as a public avatar. */
export function stripPngTextMetadata(bytes: Uint8Array): Uint8Array {
  const textChunks = new Set(['tEXt', 'zTXt', 'iTXt']);
  try {
    return encodePngChunks(extractPngChunks(bytes).filter((chunk) => !textChunks.has(chunk.name)));
  } catch {
    throw new CharacterCodecError(diagnostic('corrupt_png', 'PNG chunks are corrupt.'));
  }
}
