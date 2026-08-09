import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import encodePngChunks from 'png-chunks-encode';
import extractPngChunks from 'png-chunks-extract';
import { sanitizePublicPng } from '../src/services/avatar-png.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function idatBytes(): Buffer {
  const idat = extractPngChunks(png).find((chunk) => chunk.name === 'IDAT');
  if (idat === undefined) throw new Error('PNG fixture has no IDAT');
  return Buffer.from(idat.data);
}

function withIdatParts(parts: readonly Uint8Array[]): Buffer {
  const chunks = extractPngChunks(png).flatMap((chunk) => chunk.name === 'IDAT'
    ? parts.map((data) => ({ name: 'IDAT', data: Uint8Array.from(data) }))
    : [{ name: chunk.name, data: Uint8Array.from(chunk.data) }]);
  return Buffer.from(encodePngChunks(chunks));
}

describe('public PNG raster validation', () => {
  it('accepts one complete zlib stream split across consecutive IDAT chunks', () => {
    const compressed = idatBytes();
    const multiIdat = withIdatParts([compressed.subarray(0, 4), compressed.subarray(4)]);

    expect(() => sanitizePublicPng(multiIdat)).not.toThrow();
  });

  it.each([
    ['valid stream plus DEADBEEF tail', withIdatParts([Buffer.concat([idatBytes(), Buffer.from('deadbeef', 'hex')])])],
    ['valid stream plus an additional zlib member', withIdatParts([Buffer.concat([idatBytes(), deflateSync(Buffer.alloc(0))])])],
    ['truncated zlib stream', withIdatParts([idatBytes().subarray(0, -1)])],
    ['decoded raster beyond the bounded expected length', withIdatParts([deflateSync(Buffer.alloc(1024 * 1024))])],
  ])('rejects %s', (_caseName, invalidPng) => {
    expect(() => sanitizePublicPng(invalidPng)).toThrow('Invalid PNG raster');
  });
});
