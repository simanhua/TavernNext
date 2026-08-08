import sharp from 'sharp';
import { encodeCharacterPng } from './png-codec.js';
import type {
  CharacterAuxiliaryAsset,
  CharacterImportPreview,
  CharacterUnknownFields,
  NormalizedCharacterCard,
} from './normalize.js';

const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type CharacterExportFormat = 'json-v2' | 'json-v3' | 'png';

export interface CharacterExportSource {
  character: NormalizedCharacterCard | null;
  unknownFields?: CharacterUnknownFields;
  rawPayloads?: Record<string, unknown>;
  sourcePng?: Uint8Array;
  avatar?: CharacterAuxiliaryAsset;
  auxiliaryAssets?: CharacterAuxiliaryAsset[];
}

export interface ExportArtifact {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
  auxiliaryAssets: CharacterAuxiliaryAsset[];
}

export interface CharacterExportOptions {
  defaultPng?: Uint8Array;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, nested]) => [key, stableValue(nested)]));
}

function cleanUnknown(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value === undefined ? {} : structuredClone(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function versionPayload(source: CharacterExportSource, version: '2.0' | '3.0'): Record<string, unknown> {
  const expectedSpec = version === '2.0' ? 'chara_card_v2' : 'chara_card_v3';
  const candidates = version === '2.0' ? ['chara', 'document', 'card'] : ['ccv3', 'document', 'card'];
  for (const key of candidates) {
    const value = record(source.rawPayloads?.[key]);
    if (value?.spec === expectedSpec) return structuredClone(value);
  }
  return {};
}

function cardDocument(source: CharacterExportSource, version: '2.0' | '3.0'): Record<string, unknown> {
  const character = source.character;
  if (character === null) throw new Error('Cannot export a Character without normalized fields');
  const unknown = source.unknownFields ?? { topLevel: {}, data: {} };
  const raw = versionPayload(source, version);
  const rawData = record(raw.data) ?? {};
  const data: Record<string, unknown> = {
    ...cleanUnknown(unknown.data),
    ...rawData,
    name: character.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    first_mes: character.firstMessage,
    mes_example: character.examples,
    creator_notes: character.creatorNotes,
    system_prompt: character.systemPrompt,
    post_history_instructions: character.postHistoryInstructions,
    alternate_greetings: [...character.alternateGreetings],
    tags: [...character.tags],
    creator: character.creator,
    character_version: character.characterVersion,
    extensions: structuredClone(character.extensions),
    ...(character.characterBook === undefined ? {} : { character_book: structuredClone(character.characterBook) }),
  };
  if (character.characterBook === undefined) delete data.character_book;
  return stableValue({
    ...cleanUnknown(unknown.topLevel),
    ...raw,
    spec: version === '2.0' ? 'chara_card_v2' : 'chara_card_v3',
    spec_version: version,
    data,
  }) as Record<string, unknown>;
}

function safeFileStem(value: string): string {
  const cleaned = value
    .trim()
    .replace(/\s*[<>:"/\\|?*\u0000-\u001f]\s*/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .replace(/[. ]+$/g, '');
  return cleaned === '' ? 'character' : cleaned.slice(0, 120);
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return bytes.byteLength >= signature.byteLength && signature.every((byte, index) => bytes[index] === byte);
}

async function imageBase(source: CharacterExportSource, options: CharacterExportOptions): Promise<Uint8Array> {
  if (source.sourcePng !== undefined) return Uint8Array.from(source.sourcePng);
  if (source.avatar !== undefined) {
    if (startsWith(source.avatar.bytes, pngSignature)) return Uint8Array.from(source.avatar.bytes);
    return new Uint8Array(await sharp(source.avatar.bytes, { failOn: 'error' }).png().toBuffer());
  }
  if (options.defaultPng === undefined) throw new Error('PNG export requires a source image, current avatar, or default card');
  if (!startsWith(options.defaultPng, pngSignature)) throw new Error('Default Character card is not PNG data');
  return Uint8Array.from(options.defaultPng);
}

function clonedAssets(source: CharacterExportSource): CharacterAuxiliaryAsset[] {
  return (source.auxiliaryAssets ?? []).map((asset) => ({ path: asset.path, bytes: Uint8Array.from(asset.bytes) }));
}

export async function exportCharacter(
  source: CharacterExportSource | CharacterImportPreview,
  format: CharacterExportFormat,
  options: CharacterExportOptions = {},
): Promise<ExportArtifact> {
  if (source.character === null) throw new Error('Cannot export an invalid Character preview');
  const stem = safeFileStem(source.character.name);
  const v2 = cardDocument(source, '2.0');
  const v3 = cardDocument(source, '3.0');
  const auxiliaryAssets = clonedAssets(source);
  if (format === 'json-v2' || format === 'json-v3') {
    const document = format === 'json-v2' ? v2 : v3;
    return {
      bytes: new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`),
      contentType: 'application/json; charset=utf-8',
      fileName: `${stem}.json`,
      auxiliaryAssets,
    };
  }
  if (format !== 'png') throw new Error(`Unsupported Character export format: ${String(format)}`);
  const png = encodeCharacterPng(await imageBase(source, options), v2, v3);
  return { bytes: png, contentType: 'image/png', fileName: `${stem}.png`, auxiliaryAssets };
}
