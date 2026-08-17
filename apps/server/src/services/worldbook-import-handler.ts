import { randomUUID } from 'node:crypto';
import type { Worldbook, WorldbookEntry } from '@tavernnext/domain';
import {
  decodeWorldbookArtifact,
  diagnostic,
  type DecodedWorldbookArtifact,
  type ImportDiagnostic,
  type NormalizedWorldbook,
  type NormalizedWorldbookEntry,
  type WorldbookSourceFormat,
  WorldbookCodecError,
  WorldbookValidationError,
} from '@tavernnext/st-compat';
import type { Repositories } from '../db/repositories.js';
import type { ImportHandler } from './import-service.js';

export interface StoredWorldbookSource {
  sourceFormat: WorldbookSourceFormat;
  rawDocument: Record<string, unknown>;
  unknownFields: Record<string, unknown>;
  extensions: Record<string, unknown>;
}

export interface StoredWorldbookEntrySource {
  sourceFormat: WorldbookSourceFormat;
  sourceUid: string | number;
  sourceOrdinal?: number;
  unknownFields: Record<string, unknown>;
  extensions: Record<string, unknown>;
  characterFilterUnknownFields?: Record<string, unknown>;
  personaFilterUnknownFields?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function storedBookSource(value: unknown): StoredWorldbookSource | undefined {
  const source = record(value);
  if (source === undefined || typeof source.sourceFormat !== 'string') return undefined;
  const rawDocument = record(source.rawDocument);
  const unknownFields = record(source.unknownFields);
  const extensions = record(source.extensions);
  if (rawDocument === undefined || unknownFields === undefined || extensions === undefined) return undefined;
  return { sourceFormat: source.sourceFormat as WorldbookSourceFormat, rawDocument, unknownFields, extensions };
}

function storedEntrySource(value: unknown): StoredWorldbookEntrySource | undefined {
  const source = record(value);
  if (source === undefined || typeof source.sourceFormat !== 'string') return undefined;
  if (typeof source.sourceUid !== 'string' && typeof source.sourceUid !== 'number') return undefined;
  const unknownFields = record(source.unknownFields);
  const extensions = record(source.extensions);
  if (unknownFields === undefined || extensions === undefined) return undefined;
  return {
    sourceFormat: source.sourceFormat as WorldbookSourceFormat,
    sourceUid: source.sourceUid,
    ...(typeof source.sourceOrdinal === 'number' && Number.isInteger(source.sourceOrdinal) && source.sourceOrdinal >= 0
      ? { sourceOrdinal: source.sourceOrdinal }
      : {}),
    unknownFields,
    extensions,
    ...(record(source.characterFilterUnknownFields) === undefined
      ? {}
      : { characterFilterUnknownFields: record(source.characterFilterUnknownFields) }),
    ...(record(source.personaFilterUnknownFields) === undefined
      ? {}
      : { personaFilterUnknownFields: record(source.personaFilterUnknownFields) }),
  };
}

function normalizedEntry(entry: WorldbookEntry, fallbackOrdinal: number): NormalizedWorldbookEntry {
  const source = storedEntrySource(entry.compatibility?.rawPayload);
  return {
    id: entry.id,
    sourceUid: entry.sourceUid ?? source?.sourceUid ?? entry.id,
    sourceOrdinal: entry.sourceOrdinal ?? source?.sourceOrdinal ?? fallbackOrdinal,
    keys: entry.keys,
    secondaryKeys: entry.secondaryKeys,
    useRegex: entry.useRegex,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    constant: entry.constant,
    vectorized: entry.vectorized,
    probability: entry.probability,
    useProbability: entry.useProbability,
    group: entry.group,
    groupWeight: entry.groupWeight,
    groupOverride: entry.groupOverride,
    priority: entry.priority,
    order: entry.order,
    position: entry.position,
    depth: entry.depth,
    role: entry.role,
    ignoreBudget: entry.ignoreBudget,
    scanDepth: entry.scanDepth,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    useGroupScoring: entry.useGroupScoring,
    excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion,
    delayUntilRecursion: entry.delayUntilRecursion,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    characterFilter: {
      ...entry.characterFilter,
      ...(source?.characterFilterUnknownFields === undefined
        ? {}
        : { unknownFields: structuredClone(source.characterFilterUnknownFields) }),
    },
    personaFilter: {
      ...entry.personaFilter,
      ...(source?.personaFilterUnknownFields === undefined
        ? {}
        : { unknownFields: structuredClone(source.personaFilterUnknownFields) }),
    },
    matchPersonaDescription: entry.matchPersonaDescription,
    matchCharacterDescription: entry.matchCharacterDescription,
    matchCharacterPersonality: entry.matchCharacterPersonality,
    matchCharacterDepthPrompt: entry.matchCharacterDepthPrompt,
    matchScenario: entry.matchScenario,
    matchCreatorNotes: entry.matchCreatorNotes,
    comment: entry.comment,
    displayName: entry.displayName,
    content: entry.content,
    enabled: entry.enabled,
    addMemo: entry.addMemo,
    displayIndex: entry.displayIndex,
    outletName: entry.outletName,
    automationId: entry.automationId,
    triggers: entry.triggers,
    extensions: structuredClone(entry.extensions),
    unknownFields: structuredClone(source?.unknownFields ?? entry.compatibility?.unknownFields ?? {}),
  };
}

/** Rebuilds the current executable book while taking only passthrough fields from the source envelope. */
export function normalizedWorldbookFromRows(worldbook: Worldbook, entries: readonly WorldbookEntry[]): NormalizedWorldbook {
  const source = storedBookSource(worldbook.compatibility?.rawPayload);
  return {
    name: worldbook.name,
    description: worldbook.description,
    enabled: worldbook.enabled,
    scanDepth: worldbook.scanDepth,
    tokenBudget: worldbook.tokenBudget,
    recursiveScanning: worldbook.recursiveScanning,
    extensions: structuredClone(worldbook.extensions),
    unknownFields: structuredClone(source?.unknownFields ?? worldbook.compatibility?.unknownFields ?? {}),
    entries: entries.filter((entry) => entry.worldbookId === worldbook.id).map(normalizedEntry),
  };
}

/** Persists a fully decoded Worldbook inside the caller's existing transaction. */
export function persistDecodedWorldbook(
  repositories: Repositories,
  decoded: Pick<DecodedWorldbookArtifact, 'sourceFormat' | 'rawPayload' | 'worldbook'>,
  warnings: readonly ImportDiagnostic[],
): Worldbook {
  const source: StoredWorldbookSource = {
    sourceFormat: decoded.sourceFormat,
    rawDocument: structuredClone(decoded.rawPayload),
    unknownFields: structuredClone(decoded.worldbook.unknownFields),
    extensions: structuredClone(decoded.worldbook.extensions),
  };
  const worldbook = repositories.worldbooks.create({
    id: randomUUID(),
    name: decoded.worldbook.name,
    description: decoded.worldbook.description,
    enabled: decoded.worldbook.enabled,
    scanDepth: decoded.worldbook.scanDepth,
    tokenBudget: decoded.worldbook.tokenBudget,
    recursiveScanning: decoded.worldbook.recursiveScanning,
    extensions: structuredClone(decoded.worldbook.extensions),
    compatibility: {
      sourceFormat: `worldbook:${decoded.sourceFormat}`,
      rawPayload: source,
      unknownFields: structuredClone(decoded.worldbook.unknownFields),
      compatWarnings: warnings.map((warning) => warning.code),
      parserVersion: '1',
    },
  });
  for (const entry of decoded.worldbook.entries) {
    const entrySource: StoredWorldbookEntrySource = {
      sourceFormat: decoded.sourceFormat,
      sourceUid: entry.sourceUid,
      sourceOrdinal: entry.sourceOrdinal,
      unknownFields: structuredClone(entry.unknownFields),
      extensions: structuredClone(entry.extensions),
      ...(entry.characterFilter.unknownFields === undefined
        ? {}
        : { characterFilterUnknownFields: structuredClone(entry.characterFilter.unknownFields) }),
      ...(entry.personaFilter.unknownFields === undefined
        ? {}
        : { personaFilterUnknownFields: structuredClone(entry.personaFilter.unknownFields) }),
    };
    repositories.worldbookEntries.create({
      ...entry,
      worldbookId: worldbook.id,
      compatibility: {
        sourceFormat: `worldbook-entry:${decoded.sourceFormat}`,
        rawPayload: entrySource,
        unknownFields: structuredClone(entry.unknownFields),
        compatWarnings: warnings.map((warning) => warning.code),
        parserVersion: '1',
      },
    });
  }
  return worldbook;
}

/** Typed commits decode digest-checked staged bytes and run inside ImportService's outer transaction. */
export function createWorldbookImportHandler(): ImportHandler {
  return {
    id: 'tavernnext-worldbook',
    matches: (preview) => preview.detected.kind === 'worldbook',
    async inspect(context) {
      try {
        const decoded = decodeWorldbookArtifact(context.artifact.bytes, context.artifact.fileName);
        return {
          normalizedPreview: decoded.worldbook,
          warnings: decoded.warnings,
          blockingErrors: [],
        };
      } catch (error) {
        return {
          normalizedPreview: null,
          warnings: [],
          blockingErrors: error instanceof WorldbookValidationError
            ? error.issues
            : [diagnostic(
              error instanceof WorldbookCodecError ? error.code : 'worldbook_decode_failed',
              error instanceof Error ? error.message : 'Worldbook could not be decoded safely.',
            )],
        };
      }
    },
    commit(context) {
      const decoded = decodeWorldbookArtifact(context.artifact.bytes, context.artifact.fileName);
      const worldbook = persistDecodedWorldbook(context.repositories, decoded, context.preview.warnings);
      return { entityId: worldbook.id };
    },
  };
}
