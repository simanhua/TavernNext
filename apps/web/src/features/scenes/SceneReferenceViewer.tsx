import type { SceneReferenceKind } from '@tavernnext/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  api,
  errorCode,
  type PresetSelectorView,
  type SaveRuntimeReferencesView,
  type WorldbookEntryView,
} from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';
import { useDraggableFloating } from '../shared/useDraggableFloating.js';
import { SaveWorldbookEditor } from './SaveWorldbookEditor.js';

type ReferenceWorldbook = SaveRuntimeReferencesView['worldbooks'][number];
const REQUIRED_PROMPT_IDS = new Set([
  'charDescription', 'personaDescription', 'worldInfoBefore', 'chatHistory', 'worldInfoAfter',
]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function display(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function normalizedSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
}

function fuzzyMatch(value: string, query: string): boolean {
  const needle = normalizedSearch(query);
  if (needle === '') return true;
  const haystack = normalizedSearch(value);
  if (haystack.includes(needle)) return true;
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function presetPromptEntries(settings: Record<string, unknown>) {
  const definitions = Array.isArray(settings.prompts) ? settings.prompts.map(record) : [];
  const groups = Array.isArray(settings.prompt_order) ? settings.prompt_order.map(record) : [];
  const primaryGroup = groups.find((group) => group.character_id === 100000) ?? groups[0];
  const order = Array.isArray(primaryGroup?.order) ? primaryGroup.order.map(record) : [];
  const byIdentifier = new Map(definitions.map((prompt) => [String(prompt.identifier ?? ''), prompt]));
  const ordered: Array<{ prompt: Record<string, unknown>; enabled: boolean; order?: number }> = [];
  const seen = new Set<string>();
  for (const [index, item] of order.entries()) {
    const identifier = String(item.identifier ?? '');
    const prompt = byIdentifier.get(identifier);
    if (prompt === undefined || seen.has(identifier)) continue;
    seen.add(identifier);
    ordered.push({ prompt, enabled: item.enabled !== false && prompt.enabled !== false, order: index + 1 });
  }
  for (const prompt of definitions) {
    const identifier = String(prompt.identifier ?? '');
    if (identifier !== '' && seen.has(identifier)) continue;
    ordered.push({ prompt, enabled: prompt.enabled !== false });
  }
  return ordered;
}

function entryTitle(entry: WorldbookEntryView): string {
  return entry.displayName.trim() || entry.comment.trim() || entry.keys[0] || `#${entry.sourceOrdinal ?? entry.order}`;
}

function sourceLabel(source: ReferenceWorldbook['source'], saveOwned = false): string {
  if (saveOwned) return 'Save-owned Worldbook';
  if (source === 'global') return 'Global Worldbook';
  if (source === 'character') return 'Character Worldbook';
  return 'Conversation Worldbook';
}

function QuickSwitch({ checked, disabled = false, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(): void;
}) {
  const stopPointer = (event: ReactPointerEvent<HTMLButtonElement>) => event.stopPropagation();
  const toggle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onChange();
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className="scene-reference-switch"
      disabled={disabled}
      onPointerDown={stopPointer}
      onClick={toggle}
    ><span aria-hidden="true" /></button>
  );
}

function PresetReference({ value, presets, selectedPresetId, query, pending, onPresetSelected, onSwitch, onToggle }: {
  value: SaveRuntimeReferencesView['configuration'];
  presets: PresetSelectorView[];
  selectedPresetId: string;
  query: string;
  pending: boolean;
  onPresetSelected(id: string): void;
  onSwitch(): void;
  onToggle(identifier: string, enabled: boolean): void;
}) {
  const { t } = useI18n();
  const chatPresets = presets.filter((preset) => preset.kind === 'chat');
  const allPrompts = presetPromptEntries(value.settings);
  const prompts = allPrompts.filter(({ prompt }) => fuzzyMatch([
    String(prompt.name ?? ''),
    String(prompt.identifier ?? ''),
    String(prompt.role ?? ''),
    String(prompt.content ?? ''),
  ].join('\n'), query));
  const generationSettings = { ...value.settings };
  delete generationSettings.prompts;
  delete generationSettings.prompt_order;
  return (
    <section className="scene-reference-preset" aria-label={t('Preset reference')}>
      <div className="scene-reference-preset-switcher">
        <label>
          <span>{t('Preset for this Save')}</span>
          <select
            value={selectedPresetId}
            disabled={pending || chatPresets.length === 0}
            onChange={(event) => onPresetSelected(event.target.value)}
          >
            <option value="">{t('Select a Preset')}</option>
            {presets.map((preset) => (
              <option value={preset.id} key={preset.id} disabled={preset.kind !== 'chat'}>
                {preset.name} · {t(preset.kind)}{preset.official ? ` · ${t('Official')}` : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={pending || selectedPresetId === '' || selectedPresetId === value.sourcePresetId}
          onClick={onSwitch}
        >{t('Switch Save Preset')}</button>
        {chatPresets.length === 0 ? <small>{t('No executable Chat Presets are available.')}</small> : (
          <small>{t('Switching replaces only this Save copy. Other Saves and Preset templates are unchanged.')}</small>
        )}
      </div>
      <dl>
        <div><dt>{t('Name')}</dt><dd>{value.name}</dd></div>
        <div><dt>{t('Revision')}</dt><dd>{value.revision}</dd></div>
        <div>
          <dt>{t('Template')}</dt>
          <dd>{value.sourcePresetId === null
            ? t('Private Save copy')
            : t('Linked at template revision {{revision}}', { revision: value.sourcePresetRevision ?? 0 })}</dd>
        </div>
      </dl>
      <header className="scene-reference-section-heading">
        <h3>{t('Prompt entries')}</h3>
        <small>{query.trim() === ''
          ? prompts.length
          : t('{{shown}} of {{total}}', { shown: prompts.length, total: allPrompts.length })}</small>
      </header>
      {prompts.length === 0 ? <p>{t(query.trim() === '' ? 'No prompt entries.' : 'No matching Preset entries.')}</p> : (
        <div className="scene-reference-preset-list">
          {prompts.map(({ prompt, enabled, order }, index) => {
            const identifier = String(prompt.identifier ?? '');
            const title = String(prompt.name ?? '').trim() || identifier || t('Prompt {{number}}', { number: index + 1 });
            const required = REQUIRED_PROMPT_IDS.has(identifier);
            const effectiveEnabled = required || enabled;
            return (
              <details className="scene-reference-entry-card" key={`${identifier}:${index}`} data-enabled={effectiveEnabled}>
                <summary>
                  <span>{title}</span>
                  <span className="scene-reference-summary-controls">
                    <small>{String(prompt.role ?? 'system')} · {required ? t('Required') : enabled ? t('Enabled') : t('Disabled')}</small>
                    <QuickSwitch
                      checked={effectiveEnabled}
                      disabled={pending || required || identifier === ''}
                      label={required
                        ? t('{{name}} is required by the runtime', { name: title })
                        : t('{{action}} prompt {{name}}', { action: t(enabled ? 'Disable' : 'Enable'), name: title })}
                      onChange={() => onToggle(identifier, !enabled)}
                    />
                  </span>
                </summary>
                <div className="scene-reference-entry-body">
                  <dl className="scene-reference-entry-metadata">
                    <div><dt>{t('Identifier')}</dt><dd>{identifier || '—'}</dd></div>
                    <div><dt>{t('Order')}</dt><dd>{order ?? '—'}</dd></div>
                    <div><dt>{t('Injection position')}</dt><dd>{display(prompt.injection_position)}</dd></div>
                    <div><dt>{t('Injection depth')}</dt><dd>{display(prompt.injection_depth)}</dd></div>
                  </dl>
                  <pre>{String(prompt.content ?? '') || t('Empty prompt content')}</pre>
                </div>
              </details>
            );
          })}
        </div>
      )}
      {fuzzyMatch(`${t('Generation settings')}\n${JSON.stringify(generationSettings)}`, query) ? (
      <details className="scene-reference-entry-card scene-reference-generation-settings">
        <summary>
          <span>{t('Generation settings')}</span>
          <small>{Object.keys(generationSettings).length}</small>
        </summary>
        <div className="scene-reference-entry-body">
          <pre>{JSON.stringify(generationSettings, null, 2)}</pre>
        </div>
      </details>
      ) : null}
    </section>
  );
}

function WorldbookReference({ item, pendingKey, onToggleBook, onToggleEntry, onEdit }: {
  item: ReferenceWorldbook;
  pendingKey?: string;
  onToggleBook(enabled: boolean): void;
  onToggleEntry(entry: WorldbookEntryView, enabled: boolean): void;
  onEdit?(): void;
}) {
  const { t } = useI18n();
  const { value } = item;
  return (
    <details className="scene-reference-worldbook">
      <summary>
        <span>{value.name}</span>
        <span className="scene-reference-summary-controls">
          <small>{t(sourceLabel(item.source, item.saveOwned))} · {value.enabled ? t('Enabled') : t('Disabled')} · {value.entries.length}</small>
          {onEdit === undefined ? null : (
            <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(); }}>{t('Edit')}</button>
          )}
          <QuickSwitch
            checked={value.enabled}
            disabled={pendingKey !== undefined}
            label={t(item.saveOwned ? '{{action}} Save Worldbook {{name}}' : '{{action}} shared Worldbook {{name}}', { action: t(value.enabled ? 'Disable' : 'Enable'), name: value.name })}
            onChange={() => onToggleBook(!value.enabled)}
          />
        </span>
      </summary>
      {value.description.trim() === '' ? null : <p>{value.description}</p>}
      <dl className="scene-reference-worldbook-settings">
        <div><dt>{t('Scan depth')}</dt><dd>{value.scanDepth ?? t('Default')}</dd></div>
        <div><dt>{t('Token budget')}</dt><dd>{value.tokenBudget ?? t('Default')}</dd></div>
        <div><dt>{t('Recursive scanning')}</dt><dd>{value.recursiveScanning ? t('Enabled') : t('Disabled')}</dd></div>
      </dl>
      <div className="scene-reference-entry-list">
        {value.entries.map((entry) => {
          const effectiveEnabled = entry.effectiveEnabled ?? entry.enabled;
          const saveOverride = entry.activationSource === 'save';
          return (
          <details
            className="scene-reference-entry-card"
            key={entry.id}
            data-enabled={effectiveEnabled}
            data-template-enabled={entry.enabled}
            data-activation-source={entry.activationSource ?? 'template'}
          >
            <summary>
              <span>{entryTitle(entry)}</span>
              <span className="scene-reference-summary-controls">
                <small>{item.saveOwned ? t('Save copy: {{effective}}', {
                  effective: t(effectiveEnabled ? 'Enabled' : 'Disabled'),
                }) : t('Effective: {{effective}} · Template: {{template}}', {
                  effective: t(effectiveEnabled ? 'Enabled' : 'Disabled'),
                  template: t(entry.enabled ? 'Enabled' : 'Disabled'),
                })}{!item.saveOwned && saveOverride ? ` · ${t('Save override')}` : ''}</small>
                <QuickSwitch
                  checked={entry.enabled}
                  disabled={pendingKey !== undefined}
                  label={t(item.saveOwned ? '{{action}} Save Worldbook entry {{name}}' : '{{action}} shared Worldbook entry {{name}}', {
                    action: t(entry.enabled ? 'Disable' : 'Enable'), name: entryTitle(entry),
                  })}
                  onChange={() => onToggleEntry(entry, !entry.enabled)}
                />
              </span>
            </summary>
            <div className="scene-reference-entry-body">
              <p className="scene-reference-entry-keys">
                {entry.keys.length === 0 ? t('No keys') : t('Keys: {{keys}}', { keys: entry.keys.join(', ') })}
              </p>
              <dl className="scene-reference-entry-metadata">
                <div><dt>{t('Activation source')}</dt><dd>{t(item.saveOwned ? 'Save copy' : saveOverride ? 'Save override' : 'Template default')}</dd></div>
                <div><dt>{t('Position')}</dt><dd>{entry.position}</dd></div>
                <div><dt>{t('Order')}</dt><dd>{entry.order}</dd></div>
                <div><dt>{t('Priority')}</dt><dd>{entry.priority ?? '—'}</dd></div>
                <div><dt>{t('Depth')}</dt><dd>{entry.depth}</dd></div>
              </dl>
              {entry.contentOverridden ? <p className="scene-reference-effective-note">{t('Content materialized for this Save')}</p> : null}
              <p className="scene-reference-entry-content">{entry.effectiveContent ?? entry.content}</p>
            </div>
          </details>
          );
        })}
      </div>
    </details>
  );
}

export function SceneReferenceViewer({
  conversationId,
  kind,
  onKindChange,
  onClose,
}: {
  conversationId: string;
  kind: SceneReferenceKind;
  onKindChange(kind: SceneReferenceKind): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const floating = useDraggableFloating<HTMLElement>({ ignoreSelector: 'button' });
  const queryClient = useQueryClient();
  const queryKey = ['save-runtime-references', conversationId] as const;
  const [pendingKey, setPendingKey] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const [editingWorldbookId, setEditingWorldbookId] = useState<string>();
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [queries, setQueries] = useState<Record<SceneReferenceKind, string>>({ preset: '', worldbook: '' });
  const references = useQuery({
    queryKey,
    queryFn: () => api.getSaveRuntimeReferences(conversationId),
  });
  const presets = useQuery({ queryKey: ['presets'], queryFn: api.listPresets });

  useEffect(() => {
    setSelectedPresetId(references.data?.configuration.sourcePresetId ?? '');
  }, [references.data?.configuration.sourcePresetId]);

  const mutate = async (key: string, operation: () => Promise<void>) => {
    setPendingKey(key);
    setMutationError(undefined);
    try {
      await operation();
    } catch (error) {
      setMutationError(errorCode(error));
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setPendingKey(undefined);
    }
  };

  const togglePrompt = (identifier: string, enabled: boolean) => {
    const current = references.data?.configuration;
    if (current === undefined) return;
    void mutate(`prompt:${identifier}`, async () => {
      const configuration = await api.toggleSavePrompt(conversationId, current.revision, identifier, enabled);
      queryClient.setQueryData<SaveRuntimeReferencesView>(queryKey, (value) => value === undefined
        ? value
        : { ...value, configuration });
    });
  };

  const switchPreset = () => {
    const current = references.data?.configuration;
    if (current === undefined || selectedPresetId === '' || selectedPresetId === current.sourcePresetId) return;
    if (!window.confirm(t("Switching Preset replaces this Save's private Preset settings. Continue?"))) return;
    void mutate('preset:switch', async () => {
      const configuration = await api.replaceSaveAgentConfiguration(
        conversationId,
        current.revision,
        selectedPresetId,
      );
      queryClient.setQueryData<SaveRuntimeReferencesView>(queryKey, (value) => value === undefined
        ? value
        : { ...value, configuration });
      queryClient.setQueryData(['save-agent-configuration', conversationId], configuration);
    });
  };

  const toggleWorldbook = (item: ReferenceWorldbook, enabled: boolean) => {
    void mutate(`worldbook:${item.value.id}`, async () => {
      const worldbook = await api.toggleRuntimeWorldbook(
        conversationId, item.value.id, item.value.revision, enabled,
      );
      queryClient.setQueryData<SaveRuntimeReferencesView>(queryKey, (value) => value === undefined
        ? value
        : { ...value, worldbooks: value.worldbooks.map((candidate) => (
          candidate.value.id === worldbook.id ? {
            ...candidate,
            value: {
              ...candidate.value,
              ...worldbook,
              effectiveEnabled: worldbook.enabled,
              entries: candidate.value.entries.map((entry) => ({
                ...entry,
                effectiveEnabled: worldbook.enabled && (entry.saveOverrideEnabled ?? entry.enabled),
              })),
            },
          } : candidate
        )) });
    });
  };

  const toggleWorldbookEntry = (item: ReferenceWorldbook, entry: WorldbookEntryView, enabled: boolean) => {
    void mutate(`worldbook-entry:${entry.id}`, async () => {
      const updated = await api.toggleRuntimeWorldbookEntry(
        conversationId, item.value.id, entry.id, entry.revision, enabled,
      );
      queryClient.setQueryData<SaveRuntimeReferencesView>(queryKey, (value) => value === undefined
        ? value
        : { ...value, worldbooks: value.worldbooks.map((candidate) => candidate.value.id !== item.value.id
          ? candidate
          : {
              ...candidate,
              value: {
                ...candidate.value,
                entries: candidate.value.entries.map((current) => current.id === updated.id ? {
                  ...current,
                  ...updated,
                  effectiveEnabled: candidate.value.enabled && (candidate.saveOwned
                    ? updated.enabled
                    : current.saveOverrideEnabled ?? updated.enabled),
                  ...(candidate.saveOwned ? { saveOverrideEnabled: updated.enabled } : {}),
                } : current),
              },
            }) });
    });
  };

  const query = queries[kind];
  const visibleWorldbooks = (references.data?.worldbooks ?? []).flatMap((item) => {
    const bookMatches = fuzzyMatch([
      item.value.name,
      item.value.description,
      t(sourceLabel(item.source, item.saveOwned)),
    ].join('\n'), query);
    const entries = bookMatches ? item.value.entries : item.value.entries.filter((entry) => fuzzyMatch([
      entryTitle(entry),
      entry.keys.join(' '),
      (entry.secondaryKeys ?? []).join(' '),
      entry.content,
      entry.comment,
    ].join('\n'), query));
    return bookMatches || entries.length > 0
      ? [{ ...item, value: { ...item.value, entries } }]
      : [];
  });

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [onClose]);

  return (
    <aside
      ref={floating.ref}
      className="scene-reference-viewer"
      role="dialog"
      aria-labelledby="scene-reference-viewer-title"
      style={floating.style}
    >
      <header
        className="scene-reference-drag-handle"
        {...floating.dragProps}
      >
        <h2 id="scene-reference-viewer-title">{t('Runtime references')}</h2>
        <button type="button" aria-label={t('Close runtime references')} onClick={onClose}>×</button>
      </header>
      <nav aria-label={t('Runtime reference pages')}>
        <button type="button" aria-pressed={kind === 'preset'} onClick={() => onKindChange('preset')}>{t('Preset')}</button>
        <button type="button" aria-pressed={kind === 'worldbook'} onClick={() => onKindChange('worldbook')}>{t('Worldbooks')}</button>
      </nav>
      <label className="scene-reference-search">
        <span className="visually-hidden">{t(kind === 'preset' ? 'Search Preset entries' : 'Search Worldbooks and entries')}</span>
        <input
          type="search"
          value={query}
          placeholder={t(kind === 'preset' ? 'Search Preset entries…' : 'Search Worldbooks and entries…')}
          onChange={(event) => setQueries((current) => ({ ...current, [kind]: event.target.value }))}
        />
      </label>
      <div className="scene-reference-viewer-body">
        {references.isLoading || presets.isLoading ? <p>{t('Loading runtime references…')}</p> : null}
        {references.error === null && presets.error === null ? null : (
          <p role="alert">{t('Unable to load runtime references: {{error}}', {
            error: errorCode(references.error ?? presets.error),
          })}</p>
        )}
        {mutationError === undefined ? null : (
          <p role="alert">{t('Unable to update runtime reference: {{error}}', { error: t(mutationError) })}</p>
        )}
        {references.data === undefined ? null : kind === 'preset'
          ? <PresetReference
              value={references.data.configuration}
              presets={presets.data ?? []}
              selectedPresetId={selectedPresetId}
              query={query}
              pending={pendingKey?.startsWith('preset:') === true || pendingKey?.startsWith('prompt:') === true}
              onPresetSelected={setSelectedPresetId}
              onSwitch={switchPreset}
              onToggle={togglePrompt}
            />
          : visibleWorldbooks.length === 0
            ? <p>{t(references.data.worldbooks.length === 0
              ? 'No Worldbooks are available to this Save.'
              : 'No matching Worldbooks or entries.')}</p>
            : editingWorldbookId === undefined ? <div className="scene-reference-worldbook-list">
              {visibleWorldbooks.map((item) => (
                <WorldbookReference
                  key={item.value.id}
                  item={item}
                  pendingKey={pendingKey?.startsWith('worldbook') === true ? pendingKey : undefined}
                  onToggleBook={(enabled) => toggleWorldbook(item, enabled)}
                  onToggleEntry={(entry, enabled) => toggleWorldbookEntry(item, entry, enabled)}
                  onEdit={item.saveOwned ? () => setEditingWorldbookId(item.value.id) : undefined}
                />
              ))}
            </div> : (() => {
              const item = references.data.worldbooks.find((candidate) => candidate.value.id === editingWorldbookId);
              return item === undefined ? null : (
                <SaveWorldbookEditor
                  conversationId={conversationId}
                  value={item.value}
                  onClose={() => setEditingWorldbookId(undefined)}
                  onChanged={(worldbook) => queryClient.setQueryData<SaveRuntimeReferencesView>(queryKey, (current) => current === undefined
                    ? current
                    : {
                        ...current,
                        worldbooks: current.worldbooks.map((candidate) => candidate.value.id !== worldbook.id
                          ? candidate
                          : {
                              ...candidate,
                              value: {
                                ...worldbook,
                                effectiveEnabled: worldbook.enabled,
                                entries: worldbook.entries.map((entry) => ({
                                  ...entry,
                                  effectiveEnabled: worldbook.enabled && entry.enabled,
                                  activationSource: 'save' as const,
                                  saveOverrideEnabled: entry.enabled,
                                  contentOverridden: false,
                                  effectiveContent: entry.content,
                                })),
                              },
                            }),
                      })}
                />
              );
            })()}
      </div>
    </aside>
  );
}
