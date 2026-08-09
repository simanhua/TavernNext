import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode as encodePngText } from 'png-chunk-text';
import encodePngChunks from 'png-chunks-encode';
import extractPngChunks from 'png-chunks-extract';

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const basePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const payload = JSON.parse(await readFile(join(fixtureRoot, 'native.json'), 'utf8'));
const chunks = extractPngChunks(basePng);
chunks.splice(-1, 0, encodePngText('naidata', Buffer.from(JSON.stringify(payload)).toString('base64')));
await writeFile(join(fixtureRoot, 'naidata.png'), encodePngChunks(chunks));
