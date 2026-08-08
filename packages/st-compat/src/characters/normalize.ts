import type { ImportDiagnostic } from '../warnings.js';
import type { CharacterDataSource, ParsedCharacterDocument } from './schemas.js';

const topLevelKnown = new Set([
  'spec', 'spec_version', 'data',
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creatorcomment', 'creator_notes', 'system_prompt', 'post_history_instructions',
  'alternate_greetings', 'tags', 'creator', 'character_version', 'extensions', 'character_book',
]);
const dataKnown = new Set([
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings',
  'tags', 'creator', 'character_version', 'extensions', 'character_book',
]);

export interface NormalizedCharacterCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  examples: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  creatorNotes: string;
  tags: string[];
  creator: string;
  characterVersion: string;
  extensions: Record<string, unknown>;
  characterBook?: Record<string, unknown>;
}

export interface CharacterUnknownFields {
  topLevel: Record<string, unknown>;
  data: Record<string, unknown>;
}

export interface CharacterAuxiliaryAsset {
  path: string;
  bytes: Uint8Array;
}

export interface CharacterImportPreview {
  sourceFormat: 'json' | 'yaml' | 'png' | 'charx' | 'byaf' | 'unknown';
  version: string;
  selectedPayload: string;
  character: NormalizedCharacterCard | null;
  rawPayloads: Record<string, unknown>;
  unknownFields: CharacterUnknownFields;
  auxiliaryAssets: CharacterAuxiliaryAsset[];
  avatar?: CharacterAuxiliaryAsset;
  sourcePng?: Uint8Array;
  warnings: ImportDiagnostic[];
  blockingErrors: ImportDiagnostic[];
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value === undefined ? {} : structuredClone(value);
}

function without(source: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key)));
}

function normalized(data: CharacterDataSource, topLevel: Record<string, unknown>, version: string): NormalizedCharacterCard {
  const legacyNotes = version === '1' && typeof topLevel.creatorcomment === 'string' ? topLevel.creatorcomment : '';
  return {
    name: data.name,
    description: data.description ?? '',
    personality: data.personality ?? '',
    scenario: data.scenario ?? '',
    firstMessage: data.first_mes ?? '',
    examples: data.mes_example ?? '',
    systemPrompt: data.system_prompt ?? '',
    postHistoryInstructions: data.post_history_instructions ?? '',
    alternateGreetings: [...(data.alternate_greetings ?? [])],
    creatorNotes: data.creator_notes ?? legacyNotes,
    tags: [...(data.tags ?? [])],
    creator: data.creator ?? '',
    characterVersion: data.character_version ?? '',
    extensions: cloneRecord(data.extensions),
    ...(data.character_book === undefined ? {} : { characterBook: structuredClone(data.character_book) }),
  };
}

export function normalizeParsedCharacter(document: ParsedCharacterDocument): {
  character: NormalizedCharacterCard;
  unknownFields: CharacterUnknownFields;
} {
  const isV1 = document.version === '1';
  return {
    character: normalized(document.data, document.topLevel, document.version),
    unknownFields: {
      topLevel: without(document.topLevel, topLevelKnown),
      data: isV1 ? {} : without(document.data, dataKnown),
    },
  };
}

export function emptyCharacterPreview(): CharacterImportPreview {
  return {
    sourceFormat: 'unknown',
    version: '',
    selectedPayload: '',
    character: null,
    rawPayloads: {},
    unknownFields: { topLevel: {}, data: {} },
    auxiliaryAssets: [],
    warnings: [],
    blockingErrors: [],
  };
}
