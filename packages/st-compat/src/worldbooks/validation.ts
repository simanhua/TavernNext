import { WorldbookEntrySchema, WorldbookSchema } from '@tavernnext/domain';
import type { ImportDiagnostic } from '../warnings.js';
import { diagnostic } from '../warnings.js';
import type { NormalizedWorldbook, WorldbookSourceFormat } from './normalize.js';
import type { JsonObject } from './schemas.js';

const validationId = '018f0000-0000-7000-8000-000000000001';
const validationWorldbookId = '018f0000-0000-7000-8000-000000000002';
const validationTimestamp = '2026-01-01T00:00:00.000Z';
export const MAX_WORLDBOOK_DIAGNOSTICS = 64;

export class WorldbookValidationError extends Error {
  constructor(readonly issues: ImportDiagnostic[]) {
    super('The Worldbook contains values that cannot be persisted safely.');
  }
}

function record(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function issuePath(prefix: string, path: readonly PropertyKey[]): string {
  return path.reduce<string>((value, part) => typeof part === 'number'
    ? `${value}[${part}]`
    : value === '' ? String(part) : `${value}.${String(part)}`, prefix);
}

function contentIssue(path: string, message: string): ImportDiagnostic {
  return diagnostic('worldbook_content_invalid', message, path);
}

function appendIssue(issues: ImportDiagnostic[], issue: ImportDiagnostic): void {
  if (issues.length < MAX_WORLDBOOK_DIAGNOSTICS) {
    issues.push(issue);
    return;
  }
  if (issues.length === MAX_WORLDBOOK_DIAGNOSTICS) {
    issues.push(diagnostic(
      'worldbook_diagnostics_truncated',
      `Additional Worldbook diagnostics were omitted after ${MAX_WORLDBOOK_DIAGNOSTICS} field-specific diagnostics.`,
    ));
  }
}

function diagnosticLimitReached(issues: ImportDiagnostic[]): boolean {
  return issues.length > MAX_WORLDBOOK_DIAGNOSTICS;
}

export function boundedWorldbookDiagnostics(...groups: readonly ImportDiagnostic[][]): ImportDiagnostic[] {
  const issues: ImportDiagnostic[] = [];
  for (const group of groups) {
    for (const issue of group) {
      appendIssue(issues, issue);
      if (diagnosticLimitReached(issues)) return issues;
    }
  }
  return issues;
}

function validateRawFilter(value: unknown, path: string, issues: ImportDiagnostic[]): void {
  if (value === undefined) return;
  const filter = record(value);
  if (filter === undefined) {
    appendIssue(issues, contentIssue(path, 'Worldbook filters must be objects.'));
    return;
  }
  if (filter.isExclude !== undefined && typeof filter.isExclude !== 'boolean') {
    appendIssue(issues, contentIssue(`${path}.isExclude`, 'Worldbook filter exclusion flags must be booleans.'));
  }
  for (const field of ['names', 'tags'] as const) {
    if (diagnosticLimitReached(issues)) return;
    const values = filter[field];
    if (values !== undefined && (!Array.isArray(values) || values.some((item) => typeof item !== 'string'))) {
      appendIssue(issues, contentIssue(`${path}.${field}`, 'Worldbook filter values must be arrays of strings.'));
    }
  }
}

export function validateRawWorldbookFilters(raw: JsonObject, sourceFormat: Exclude<WorldbookSourceFormat, 'unknown'>): ImportDiagnostic[] {
  const issues: ImportDiagnostic[] = [];
  if (sourceFormat === 'st-native' || sourceFormat === 'naidata') {
    const entries = record(raw.entries) ?? {};
    for (const key in entries) {
      if (!Object.hasOwn(entries, key) || diagnosticLimitReached(issues)) continue;
      const value = entries[key];
      const entry = record(value);
      if (entry === undefined) continue;
      validateRawFilter(entry.characterFilter, `entries.${key}.characterFilter`, issues);
      validateRawFilter(entry.personaFilter, `entries.${key}.personaFilter`, issues);
    }
  } else if (sourceFormat === 'character-book' && Array.isArray(raw.entries)) {
    for (let index = 0; index < raw.entries.length && !diagnosticLimitReached(issues); index += 1) {
      const value = raw.entries[index];
      const entry = record(value);
      const extensions = record(entry?.extensions);
      validateRawFilter(extensions?.character_filter, `entries[${index}].extensions.character_filter`, issues);
      validateRawFilter(extensions?.persona_filter, `entries[${index}].extensions.persona_filter`, issues);
    }
  }
  return issues;
}

export function validateNormalizedWorldbook(worldbook: NormalizedWorldbook): ImportDiagnostic[] {
  const issues: ImportDiagnostic[] = [];
  const bookResult = WorldbookSchema.safeParse({
    ...worldbook,
    id: validationWorldbookId,
    revision: 0,
    createdAt: validationTimestamp,
    updatedAt: validationTimestamp,
  });
  if (!bookResult.success) {
    for (const issue of bookResult.error.issues) {
      appendIssue(issues, contentIssue(issuePath('', issue.path), issue.message));
      if (diagnosticLimitReached(issues)) return issues;
    }
  }
  for (let index = 0; index < worldbook.entries.length && !diagnosticLimitReached(issues); index += 1) {
    const entry = worldbook.entries[index]!;
    if (entry.depth < 0) {
      appendIssue(issues, contentIssue(`entries[${index}].depth`, 'Worldbook entry depth must be greater than or equal to 0.'));
    }
    if (entry.scanDepth !== null && entry.scanDepth < 0) {
      appendIssue(issues, contentIssue(`entries[${index}].scanDepth`, 'Worldbook entry scan depth must be greater than or equal to 0.'));
    }
    if (diagnosticLimitReached(issues)) break;
    const entryResult = WorldbookEntrySchema.safeParse({
      ...entry,
      id: entry.id || validationId,
      worldbookId: validationWorldbookId,
      revision: 0,
      createdAt: validationTimestamp,
      updatedAt: validationTimestamp,
      characterFilter: {
        isExclude: entry.characterFilter.isExclude,
        names: entry.characterFilter.names,
        tags: entry.characterFilter.tags,
      },
      personaFilter: {
        isExclude: entry.personaFilter.isExclude,
        names: entry.personaFilter.names,
        tags: entry.personaFilter.tags,
      },
    });
    if (!entryResult.success) {
      for (const issue of entryResult.error.issues) {
        appendIssue(issues, contentIssue(issuePath(`entries[${index}]`, issue.path), issue.message));
        if (diagnosticLimitReached(issues)) break;
      }
    }
  }
  return issues;
}
