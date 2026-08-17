import type { ImportPreview as ImportPreviewData } from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';

function titleCase(value: string): string {
  return value === '' ? 'Unknown' : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.slice(0, 256) : undefined;
}

function quantity(count: number, singular: string, t: (key: string, variables?: Record<string, string | number>) => string): string {
  return t(`{{count}} ${singular}`, { count });
}

function normalizedSummary(kind: string, value: unknown, t: (key: string, variables?: Record<string, string | number>) => string): string[] {
  const root = record(value);
  if (root === undefined) return [t('Normalized data is ready')];
  if (kind === 'character') {
    const character = record(root.character) ?? root;
    return [
      boundedLabel(character.name),
      Array.isArray(character.alternateGreetings) ? quantity(character.alternateGreetings.length, 'alternate greeting', t) : undefined,
      Array.isArray(character.tags) ? quantity(character.tags.length, 'tag', t) : undefined,
      Array.isArray(root.auxiliaryAssets) ? quantity(root.auxiliaryAssets.length, 'auxiliary asset', t) : undefined,
    ].filter((item): item is string => item !== undefined);
  }
  if (kind === 'preset') {
    const settings = record(root.settings);
    return [
      boundedLabel(root.name),
      boundedLabel(root.kind),
      settings === undefined ? undefined : quantity(Object.keys(settings).length, 'recognized setting', t),
    ].filter((item): item is string => item !== undefined);
  }
  if (kind === 'worldbook') {
    return [
      boundedLabel(root.name),
      Array.isArray(root.entries) ? quantity(root.entries.length, 'entry', t) : undefined,
      typeof root.enabled === 'boolean' ? t(root.enabled ? 'Enabled' : 'Disabled') : undefined,
    ].filter((item): item is string => item !== undefined);
  }
  if (kind === 'chat') {
    const header = record(root.header);
    return [
      boundedLabel(header?.characterName),
      boundedLabel(header?.userName),
      Array.isArray(root.messages) ? quantity(root.messages.length, 'message', t) : undefined,
    ].filter((item): item is string => item !== undefined);
  }
  if (kind === 'persona') return [boundedLabel(root.name) ?? t('Persona data is ready')];
  return [t('Normalized data is ready')];
}

export function ImportPreview({ preview, expectedKind }: { preview: ImportPreviewData; expectedKind: string }) {
  const { t, language } = useI18n();
  const kindMismatch = preview.detected.kind !== 'unknown' && preview.detected.kind !== expectedKind;
  const version = preview.detected.version === undefined ? '' : ` · ${preview.detected.version.toUpperCase()}`;
  const label = `${titleCase(preview.detected.kind)} · ${preview.detected.container.toUpperCase()}${version}`;
  return (
    <section className="import-preview" aria-label={t('Import inspection preview')}>
      <h3>{label}</h3>
      <p>{preview.source.fileName} · {preview.source.mediaType || t('unknown media')} · {t('{{size}} bytes', { size: preview.source.size })}</p>
      {kindMismatch ? <p role="alert">{t('Expected {{expected}}, detected {{detected}}.', { expected: t(titleCase(expectedKind)), detected: t(titleCase(preview.detected.kind)) })}</p> : null}
      {preview.normalizedPreview === null ? null : (
        <ul className="normalized-preview" aria-label={t('Normalized preview')}>
          {normalizedSummary(preview.detected.kind, preview.normalizedPreview, t)
            .map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}
        </ul>
      )}
      {preview.warnings.length > 0 ? (
        <ul aria-label={t('Import warnings')}>
          {preview.warnings.map((warning, index) => <li key={`${warning.code}:${index}`}>{warning.message}</li>)}
        </ul>
      ) : null}
      {preview.blockingErrors.length > 0 ? (
        <div role="alert">
          {preview.blockingErrors.map((error, index) => (
            <p key={`${error.code}:${index}`}>{error.message}{error.path === undefined ? null : <> <code>{error.path}</code></>}</p>
          ))}
        </div>
      ) : null}
      {preview.expiresAt === undefined ? null : <p>{t('Inspection expires {{date}}.', { date: new Date(preview.expiresAt).toLocaleString(language) })}</p>}
    </section>
  );
}
