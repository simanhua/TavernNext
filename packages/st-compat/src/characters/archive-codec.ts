import { posix } from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { diagnostic } from '../warnings.js';
import { CharacterCodecError, decodeCharacterJson, decodeCharacterValue, strictCharacterText } from './json-codec.js';
import type { CharacterAuxiliaryAsset } from './normalize.js';

type ArchiveEntries = Map<string, Uint8Array>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonEntry(entries: ArchiveEntries, path: string, maxBytes: number): Record<string, unknown> {
  const bytes = entries.get(path);
  if (bytes === undefined) throw new CharacterCodecError(diagnostic('character_archive_entry_missing', `Archive entry ${path} is missing.`, path));
  if (bytes.byteLength > maxBytes) {
    throw new CharacterCodecError(diagnostic('archive_entry_memory_limit', `${path} exceeds the ${maxBytes}-byte manifest memory limit.`, path));
  }
  try {
    const value = JSON.parse(strictCharacterText(bytes));
    const object = record(value);
    if (object === undefined) throw new Error('not an object');
    return object;
  } catch (error) {
    if (error instanceof CharacterCodecError) throw error;
    throw new CharacterCodecError(diagnostic('corrupt_archive_manifest', `${path} is not valid JSON.`, path));
  }
}

function safeManifestPath(value: unknown, label: string): string {
  const candidate = typeof value === 'string'
    ? value
    : typeof record(value)?.path === 'string'
      ? String(record(value)!.path)
      : '';
  const portable = candidate.replaceAll('\\', '/');
  const normalized = posix.normalize(portable);
  if (
    portable === ''
    || portable.includes('\0')
    || portable.startsWith('/')
    || /^[A-Za-z]:/.test(portable)
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new CharacterCodecError(diagnostic('character_archive_manifest_path_invalid', `${label} is not a safe relative archive path.`));
  }
  return normalized;
}

function archiveEntries(bytes: Uint8Array): ArchiveEntries {
  try {
    const entries: ArchiveEntries = new Map();
    let streamError: unknown;
    const unzip = new Unzip((file) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      file.ondata = (error, chunk, final) => {
        if (error !== null) {
          streamError = error;
          return;
        }
        const retained = Uint8Array.from(chunk);
        chunks.push(retained);
        size += retained.byteLength;
        if (!final) return;
        const entry = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          entry.set(part, offset);
          offset += part.byteLength;
        }
        entries.set(file.name, entry);
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    unzip.push(bytes, true);
    if (streamError !== undefined) throw streamError;
    return entries;
  } catch {
    throw new CharacterCodecError(diagnostic('corrupt_archive', 'Character archive could not be decompressed.'));
  }
}

function auxiliary(entries: ArchiveEntries, excluded: ReadonlySet<string>): CharacterAuxiliaryAsset[] {
  return [...entries.entries()]
    .filter(([path]) => !excluded.has(path) && !path.endsWith('/'))
    .sort(([left], [right]) => compareText(left, right))
    .map(([path, bytes]) => ({ path, bytes: Uint8Array.from(bytes) }));
}

function embeddedAssetPath(uri: unknown): string | undefined {
  if (typeof uri !== 'string') return undefined;
  const lower = uri.toLowerCase();
  for (const prefix of ['embedded://', 'embeded://', '__asset:']) {
    if (lower.startsWith(prefix)) return safeManifestPath(uri.slice(prefix.length), 'CharX asset URI');
  }
  return undefined;
}

function charxAvatar(card: Record<string, unknown>, assets: readonly CharacterAuxiliaryAsset[]): CharacterAuxiliaryAsset | undefined {
  const data = record(card.data);
  const declarations = Array.isArray(data?.assets) ? data.assets.map(record).filter((value) => value !== undefined) : [];
  const icons = declarations.filter((asset) => String(asset.type ?? '').toLowerCase() === 'icon');
  const selected = icons.find((asset) => String(asset.name ?? '').toLowerCase() === 'main') ?? icons[0];
  const path = embeddedAssetPath(selected?.uri);
  return path === undefined ? undefined : assets.find((asset) => asset.path === path);
}

export function decodeCharX(bytes: Uint8Array, maxMetadataBytes: number) {
  const entries = archiveEntries(bytes);
  const cardBytes = entries.get('card.json');
  if (cardBytes === undefined) throw new CharacterCodecError(diagnostic('character_archive_entry_missing', 'CharX archive is missing card.json.', 'card.json'));
  if (cardBytes.byteLength > maxMetadataBytes) {
    throw new CharacterCodecError(diagnostic('archive_entry_memory_limit', `card.json exceeds the ${maxMetadataBytes}-byte manifest memory limit.`, 'card.json'));
  }
  const decoded = decodeCharacterJson(cardBytes);
  const assets = auxiliary(entries, new Set(['card.json']));
  return {
    selectedPayload: 'card',
    selected: decoded,
    rawPayloads: { card: decoded.raw },
    auxiliaryAssets: assets,
    avatar: charxAvatar(decoded.raw as Record<string, unknown>, assets),
  };
}

function replaceByafMacros(value: unknown): string {
  return String(value ?? '')
    .replace(/#{user}:/gi, '{{user}}:')
    .replace(/#{character}:/gi, '{{char}}:')
    .replace(/{character}(?!})/gi, '{{char}}')
    .replace(/{user}(?!})/gi, '{{user}}');
}

function byafExamples(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.flatMap((item) => {
    const text = record(item)?.text;
    return typeof text === 'string' && text !== '' ? [`<START>\n${replaceByafMacros(text)}`] : [];
  }).join('\n').trimEnd();
}

function byafFirstMessage(scenario: Record<string, unknown>): string {
  const messages = Array.isArray(scenario.firstMessages) ? scenario.firstMessages : [];
  return replaceByafMacros(record(messages[0])?.text);
}

function byafBook(character: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(character.loreItems) || character.loreItems.length === 0) return undefined;
  return {
    entries: character.loreItems.flatMap((item, index) => {
      const value = record(item);
      if (value === undefined) return [];
      return [{
        keys: replaceByafMacros(value.key).split(',').map((key) => key.trim()).filter(Boolean),
        content: replaceByafMacros(value.value),
        extensions: {},
        enabled: true,
        insertion_order: index,
      }];
    }),
    extensions: {},
  };
}

function resolveRelativeEntry(ownerPath: string, path: unknown, label: string): string {
  const declared = safeManifestPath(path, label);
  const resolved = posix.normalize(posix.join(posix.dirname(ownerPath), declared));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
    throw new CharacterCodecError(diagnostic('character_archive_manifest_path_invalid', `${label} leaves the archive root.`));
  }
  return resolved;
}

export function decodeByaf(bytes: Uint8Array, maxMetadataBytes: number) {
  const entries = archiveEntries(bytes);
  const manifest = jsonEntry(entries, 'manifest.json', maxMetadataBytes);
  if (!Array.isArray(manifest.characters) || manifest.characters.length === 0) {
    throw new CharacterCodecError(diagnostic('character_byaf_manifest_invalid', 'BYAF manifest must declare at least one Character.'));
  }
  const characterPath = safeManifestPath(manifest.characters[0], 'BYAF Character path');
  const character = jsonEntry(entries, characterPath, maxMetadataBytes);
  const scenarioPaths = Array.isArray(manifest.scenarios)
    ? manifest.scenarios.map((value) => safeManifestPath(value, 'BYAF scenario path'))
    : [];
  const scenarios = scenarioPaths.map((path) => jsonEntry(entries, path, maxMetadataBytes));
  const primary = scenarios[0] ?? {};
  const firstMessage = byafFirstMessage(primary);
  const alternates = [...new Set(scenarios.slice(1).map(byafFirstMessage).filter((message) => message !== '' && message !== firstMessage))];
  const author = record(manifest.author);
  const card: Record<string, unknown> = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: typeof character.name === 'string' && character.name !== '' ? character.name : String(character.displayName ?? ''),
      description: replaceByafMacros(character.persona),
      personality: '',
      scenario: replaceByafMacros(primary.narrative),
      first_mes: firstMessage,
      mes_example: byafExamples(primary.exampleMessages),
      creator_notes: String(author?.backyardURL ?? ''),
      system_prompt: replaceByafMacros(primary.formattingInstructions),
      post_history_instructions: '',
      alternate_greetings: alternates,
      ...(byafBook(character) === undefined ? {} : { character_book: byafBook(character) }),
      tags: character.isNSFW === true ? ['nsfw'] : [],
      creator: String(author?.name ?? ''),
      character_version: '',
      extensions: typeof character.displayName === 'string' && character.displayName !== ''
        ? { display_name: character.displayName }
        : {},
    },
  };
  const decoded = decodeCharacterValue(card);
  const assets = auxiliary(entries, new Set(['manifest.json']));
  const images = Array.isArray(character.images) ? character.images.map(record).filter((value) => value !== undefined) : [];
  const avatarPath = images.length === 0 ? undefined : resolveRelativeEntry(characterPath, images[0]!.path, 'BYAF Character image path');
  return {
    selectedPayload: 'byaf',
    selected: decoded,
    rawPayloads: { manifest, character, scenarios },
    auxiliaryAssets: assets,
    avatar: avatarPath === undefined ? undefined : assets.find((asset) => asset.path === avatarPath),
  };
}
