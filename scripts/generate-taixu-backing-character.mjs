import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeInspectedCharacter, encodeCharacterPng } from '@tavernnext/st-compat';

const defaultPath = resolve(
  process.cwd(),
  'apps/server/assets/official-scenes/taixu-chronicles/content/character.png',
);
const inputPath = resolve(process.argv[2] ?? defaultPath);
const outputPath = resolve(process.argv[3] ?? inputPath);
const obsoleteWorldbookEntries = new Set(['修仙状态栏', '古风多人状态栏', '现代状态栏']);

function sanitizeCharacterPayload(value) {
  const payload = structuredClone(value ?? {});
  const targets = [payload, payload.data].filter((target) => (
    target !== null && typeof target === 'object' && !Array.isArray(target)
  ));
  for (const target of targets) {
    target.first_mes = '';
    target.alternate_greetings = [];
    const extensions = target.extensions;
    if (extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions)) {
      delete extensions.regex_scripts;
      delete extensions.tavern_helper;
    }
    const book = target.character_book;
    if (book !== null && typeof book === 'object' && !Array.isArray(book) && Array.isArray(book.entries)) {
      book.entries = book.entries.filter((entry) => !obsoleteWorldbookEntries.has(String(entry?.comment ?? '')));
    }
  }
  return payload;
}

const source = new Uint8Array(await readFile(inputPath));
const decoded = decodeInspectedCharacter(source, inputPath);
const v2 = sanitizeCharacterPayload(decoded.rawPayloads.chara ?? decoded.rawPayloads.ccv3);
const v3 = sanitizeCharacterPayload(decoded.rawPayloads.ccv3 ?? decoded.rawPayloads.chara);
await writeFile(outputPath, encodeCharacterPng(source, v2, v3));
console.log(`Wrote sanitized Taixu backing Character: ${outputPath}`);
