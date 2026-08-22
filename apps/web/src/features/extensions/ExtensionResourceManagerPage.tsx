import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  ApiError,
  api,
  errorCode,
  type EditableExtensionAssetView,
  type ExtensionAssetCollectionView,
} from '../../api/client.js';
import { useI18n } from '../../app/i18n.js';
import { useChatUi } from '../chat/chat-store.js';
import { ConflictBanner } from '../shared/ConflictBanner.js';
import { RuntimeStateManager } from './RuntimeStateManager.js';
import { ExtensionTrustPanel } from './ExtensionTrustPanel.js';
import { asRecord, isRecord } from './extension-resource-utils.js';
import {
  useExtensionResourceCatalog,
  type ResourceCatalogItem,
  type ResourceCatalogView,
  type ResourceSourceFilter,
} from './useExtensionResourceCatalog.js';

function normalizedOrder(assets: EditableExtensionAssetView[]): EditableExtensionAssetView[] {
  return (['regex', 'tavern_helper'] as const).flatMap((kind) => assets
    .filter((asset) => asset.kind === kind)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((asset, ordinal) => ({ ...asset, ordinal })));
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

type JsonUpdater = (field: string, source: string, apply: (value: unknown) => void) => void;

function ScriptTreeNodeEditor({ value, path, onChange, onDelete, onMoveUp, onMoveDown, first, last, updateJson }: {
  value: unknown;
  path: string;
  onChange: (value: unknown) => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  first?: boolean;
  last?: boolean;
  updateJson: JsonUpdater;
}) {
  const { t } = useI18n();
  if (!isRecord(value)) {
    return (
      <fieldset aria-label={t('Opaque script-tree node')}>
        <legend>{t('Opaque script-tree node')}</legend>
        <label>{t('Opaque node JSON')}<textarea defaultValue={JSON.stringify(value, null, 2)} onBlur={(event) => {
          updateJson(`${path}:opaque`, event.target.value, onChange);
        }} /></label>
        {onDelete === undefined ? null : <button type="button" onClick={onDelete}>{t('Delete tree node')}</button>}
      </fieldset>
    );
  }
  const node = value;
  const nodeType = node.type === 'folder' ? 'folder' : 'script';
  const patch = (changes: Record<string, unknown>) => onChange({ ...node, ...changes });
  const children = Array.isArray(node.children) ? node.children : [];
  const replaceChild = (index: number, child: unknown) => patch({
    children: children.map((valueAtIndex, childIndex) => childIndex === index ? child : valueAtIndex),
  });
  const addChild = (type: 'script' | 'folder') => {
    const id = crypto.randomUUID();
    patch({
      children: [...children, type === 'folder'
        ? { id, type: 'folder', name: 'New folder', enabled: true, children: [] }
        : { id, type: 'script', name: 'New script', enabled: true, content: '', info: '', button: {}, data: {}, export_with: {} }],
    });
  };
  return (
    <fieldset aria-label={`${t(nodeType === 'folder' ? 'Folder' : 'Script')} ${String(node.name ?? '')}`}>
      <legend>{t(nodeType === 'folder' ? 'Folder' : 'Script')} · {String(node.name ?? '')}</legend>
      <label>{t('Node type')}<select value={nodeType} onChange={(event) => {
        const type = event.target.value as 'script' | 'folder';
        if (type === 'folder') patch({ type, children: Array.isArray(node.children) ? node.children : [] });
        else {
          const { children: ignoredChildren, ...withoutChildren } = node;
          void ignoredChildren;
          onChange({
            ...withoutChildren, type,
            content: typeof node.content === 'string' ? node.content : '',
            info: typeof node.info === 'string' ? node.info : '',
            button: node.button ?? {}, data: node.data ?? {}, export_with: node.export_with ?? {},
          });
        }
      }}><option value="script">{t('Script')}</option><option value="folder">{t('Folder')}</option></select></label>
      <label>{t('Node enabled')}<input type="checkbox" checked={node.enabled !== false} onChange={(event) => patch({ enabled: event.target.checked })} /></label>
      <label>{t('Node name')}<input value={String(node.name ?? '')} onChange={(event) => patch({ name: event.target.value })} /></label>
      {nodeType === 'folder' ? (
        <div className="preset-section">
          {children.map((child, index) => {
            const childObject = isRecord(child) ? child : undefined;
            const key = typeof childObject?.id === 'string' ? childObject.id : `${path}:${index}`;
            return (
              <ScriptTreeNodeEditor
                key={key}
                value={child}
                path={`${path}.${index}`}
                updateJson={updateJson}
                onChange={(next) => replaceChild(index, next)}
                onDelete={() => patch({ children: children.filter((_, childIndex) => childIndex !== index) })}
                onMoveUp={() => {
                  if (index === 0) return;
                  const next = [...children]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; patch({ children: next });
                }}
                onMoveDown={() => {
                  if (index === children.length - 1) return;
                  const next = [...children]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; patch({ children: next });
                }}
                first={index === 0}
                last={index === children.length - 1}
              />
            );
          })}
          <button type="button" onClick={() => addChild('script')}>{t('Add nested script')}</button>
          <button type="button" onClick={() => addChild('folder')}>{t('Add nested folder')}</button>
        </div>
      ) : (
        <>
          <label>{t('Script code')}<textarea value={String(node.content ?? '')} onChange={(event) => patch({ content: event.target.value })} /></label>
          <label>{t('Script notes')}<textarea value={String(node.info ?? '')} onChange={(event) => patch({ info: event.target.value })} /></label>
          {([['Script buttons JSON', 'button'], ['Script data JSON', 'data'], ['Export options JSON', 'export_with']] as const).map(([label, key]) => (
            <label key={key}>{t(label)}<textarea defaultValue={JSON.stringify(node[key] ?? {}, null, 2)} onBlur={(event) => {
              updateJson(`${path}:${key}`, event.target.value, (jsonValue) => patch({ [key]: jsonValue }));
            }} /></label>
          ))}
        </>
      )}
      {onDelete === undefined ? null : (
        <div className="editor-actions">
          <button type="button" aria-label={t('Move tree node up')} disabled={first} onClick={onMoveUp}>↑</button>
          <button type="button" aria-label={t('Move tree node down')} disabled={last} onClick={onMoveDown}>↓</button>
          <button type="button" onClick={onDelete}>{t('Delete tree node')}</button>
        </div>
      )}
    </fieldset>
  );
}

export function ExtensionResourceManagerPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const activeConversationId = useChatUi((state) => state.activeConversationId);
  const [catalogView, setCatalogView] = useState<ResourceCatalogView>('current');
  const [activeKind, setActiveKind] = useState<EditableExtensionAssetView['kind']>('tavern_helper');
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<ResourceSourceFilter>('all');
  const {
    activeContext,
    catalog,
    filteredCatalog,
    visibleCatalog,
    loading: catalogLoading,
    normalizedSearch,
    statusesFor,
  } = useExtensionResourceCatalog({
    activeConversationId,
    view: catalogView,
    activeKind,
    search,
    sourceFilter,
  });
  const [ownerKind, setOwnerKind] = useState<'character' | 'preset'>('character');
  const [ownerId, setOwnerId] = useState('');
  const [selectedKey, setSelectedKey] = useState<string>();
  const [selectionNotice, setSelectionNotice] = useState<string>();
  const [collection, setCollection] = useState<ExtensionAssetCollectionView>();
  const [draft, setDraft] = useState<EditableExtensionAssetView[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<{ ownerKind: 'character' | 'preset'; ownerId: string; revision: number }>();
  const [invalidJsonFields, setInvalidJsonFields] = useState<Set<string>>(() => new Set());

  const selectedCatalogItem = catalog.find((item) => item.key === selectedKey);
  const selectResource = (item: ResourceCatalogItem) => {
    const sameOwner = collection?.owner.kind === item.owner.kind && collection.owner.id === item.owner.id;
    setOwnerKind(item.owner.kind);
    setOwnerId(item.owner.id);
    if (!sameOwner) {
      setCollection(item.collection);
      setDraft(normalizedOrder(item.collection.assets));
      setConflict(undefined);
      setInvalidJsonFields(new Set());
      setError(undefined);
    }
    setSelectedKey(item.key);
    setSelectionNotice(undefined);
  };
  useEffect(() => {
    if (selectedKey === undefined || activeContext.isFetching || catalogLoading) return;
    if (catalog.some((item) => item.key === selectedKey)) return;
    setSelectedKey(undefined);
    setOwnerId('');
    setCollection(undefined);
    setDraft([]);
    setConflict(undefined);
    setSelectionNotice('The selected resource left the current context.');
  }, [activeContext.isFetching, catalog, catalogLoading, selectedKey]);

  const load = async () => {
    if (ownerId === '') return;
    setPending(true);
    setError(undefined);
    try {
      const value = await api.getExtensionAssets(ownerKind, ownerId);
      queryClient.setQueryData(['extension-assets', ownerKind, ownerId, value.owner.revision], value);
      setCollection(value);
      setDraft(normalizedOrder(value.assets));
      setConflict(undefined);
      setInvalidJsonFields(new Set());
    } catch (cause) {
      setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const save = async (revision = collection?.owner.revision) => {
    if (ownerId === '' || revision === undefined || collection === undefined
      || collection.owner.kind !== ownerKind || collection.owner.id !== ownerId) return;
    setPending(true);
    setError(undefined);
    try {
      const value = await api.saveExtensionAssets(ownerKind, ownerId, revision, normalizedOrder(draft));
      setCollection(value);
      setDraft(normalizedOrder(value.assets));
      setConflict(undefined);
      await queryClient.invalidateQueries({ queryKey: ['active-resource-context'] });
      await queryClient.invalidateQueries({ queryKey: ['extension-assets', ownerKind, ownerId] });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        const revisionValue = cause.details.ownerRevision;
        if (typeof revisionValue === 'number') setConflict({ ownerKind, ownerId, revision: revisionValue });
        else {
          try {
            setConflict({ ownerKind, ownerId, revision: (await api.getExtensionAssets(ownerKind, ownerId)).owner.revision });
          }
          catch (loadError) { setError(errorCode(loadError)); }
        }
      } else setError(errorCode(cause));
    } finally {
      setPending(false);
    }
  };
  const update = (index: number, value: EditableExtensionAssetView) => {
    setDraft((current) => current.map((asset, assetIndex) => assetIndex === index ? value : asset));
  };
  const updateJson = (field: string, source: string, apply: (value: unknown) => void) => {
    try {
      apply(parseJson(source));
      const next = new Set(invalidJsonFields);
      next.delete(field);
      setInvalidJsonFields(next);
      if (next.size === 0 && error === 'invalid_json') setError(undefined);
    } catch {
      const next = new Set(invalidJsonFields);
      next.add(field);
      setInvalidJsonFields(next);
      setError('invalid_json');
    }
  };
  const setEnabled = (index: number, enabled: boolean) => {
    const asset = draft[index]!;
    update(index, {
      ...asset,
      enabled,
      payload: !isRecord(asset.payload)
        ? asset.payload
        : asset.kind === 'regex'
          ? { ...asset.payload, disabled: !enabled }
          : { ...asset.payload, enabled },
    });
  };
  const move = (index: number, offset: -1 | 1) => {
    const asset = draft[index]!;
    const sameKind = draft.map((item, itemIndex) => ({ item, itemIndex })).filter(({ item }) => item.kind === asset.kind);
    const position = sameKind.findIndex(({ itemIndex }) => itemIndex === index);
    const target = sameKind[position + offset];
    if (target === undefined) return;
    setDraft((current) => normalizedOrder(current.map((item, itemIndex) => itemIndex === index
      ? { ...item, ordinal: target.item.ordinal }
      : itemIndex === target.itemIndex ? { ...item, ordinal: asset.ordinal } : item)));
  };
  const add = (type: 'regex' | 'script' | 'folder') => {
    const id = crypto.randomUUID();
    const kind = type === 'regex' ? 'regex' : 'tavern_helper';
    const ordinal = draft.filter((asset) => asset.kind === kind).length;
    const payload = type === 'regex'
      ? {
          id, scriptName: 'New regex', disabled: false, runOnEdit: false,
          findRegex: '', trimStrings: [], replaceString: '', placement: [], substituteRegex: 0,
          minDepth: null, maxDepth: null, markdownOnly: false, promptOnly: false,
        }
      : type === 'folder'
        ? { id, type: 'folder', name: 'New folder', enabled: true, children: [] }
        : {
            id, type: 'script', name: 'New script', enabled: true, content: '', info: '',
            button: {}, data: {}, export_with: {},
          };
    setDraft((current) => normalizedOrder([...current, {
      kind, sourceKey: id, ordinal, enabled: true, payload, diagnostics: [],
    }]));
  };

  return (
    <main className="manager-page">
      <aside className="manager-sidebar">
        <h1>{t('Attached Resources')}</h1>
        <div role="tablist" aria-label={t('Resource context')}>
          <button type="button" role="tab" aria-selected={catalogView === 'current'} onClick={() => setCatalogView('current')}>
            {t('Current Context')}
          </button>
          <button type="button" role="tab" aria-selected={catalogView === 'all'} onClick={() => setCatalogView('all')}>
            {t('All Resources')}
          </button>
        </div>
        <div role="tablist" aria-label={t('Resource type')}>
          <button type="button" role="tab" aria-selected={activeKind === 'tavern_helper'} onClick={() => setActiveKind('tavern_helper')}>
            {t('Scripts')} {filteredCatalog.filter((item) => item.asset.kind === 'tavern_helper').length}
          </button>
          <button type="button" role="tab" aria-selected={activeKind === 'regex'} onClick={() => setActiveKind('regex')}>
            {t('Regexes')} {filteredCatalog.filter((item) => item.asset.kind === 'regex').length}
          </button>
        </div>
        {catalogView !== 'all' ? null : (
          <div>
            <label>{t('Search resources')}<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <label>{t('Source kind')}<select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}>
              <option value="all">{t('All owners')}</option>
              <option value="character">{t('Characters only')}</option>
              <option value="preset">{t('Presets only')}</option>
            </select></label>
          </div>
        )}
        {catalogView === 'all' || activeContext.data?.primaryPreset !== null ? null : (
          <p>{t('No primary Preset is configured for the active Provider mode.')}</p>
        )}
        {catalogView === 'all' || activeContext.data?.character !== null ? null : (
          <p>{t('No active Conversation Character is selected.')}</p>
        )}
        <div role="tabpanel" aria-label={t(activeKind === 'tavern_helper' ? 'Scripts' : 'Regexes')}>
          {visibleCatalog.map((item) => (
            <button
              type="button"
              key={item.key}
              aria-pressed={selectedKey === item.key}
              onClick={() => selectResource(item)}
            >
              <strong>{item.name}</strong>
              <span>{t(item.owner.kind === 'character' ? 'Character' : 'Preset')} · {item.owner.name}</span>
              {statusesFor(item).map((status) => <span key={status}>{t(status)}</span>)}
            </button>
          ))}
          {activeContext.isLoading || catalogLoading ? <p>{t('Loading resources…')}</p> : null}
          {!activeContext.isLoading && !catalogLoading && visibleCatalog.length === 0
            ? <p>{t(catalogView === 'all' && (normalizedSearch !== '' || sourceFilter !== 'all')
              ? 'No resources match the current filters.'
              : 'No resources of this type.')}</p> : null}
        </div>
      </aside>
      <section className="manager-editor">
        <h2>{collection?.owner.name ?? t('Attached Extension Resource manager')}</h2>
        {selectionNotice === undefined ? null : <p role="status">{t(selectionNotice)}</p>}
        <div className="editor-actions">
          <button type="button" disabled={collection === undefined} onClick={() => add('regex')}>{t('Add regex')}</button>
          <button type="button" disabled={collection === undefined} onClick={() => add('script')}>{t('Add script')}</button>
          <button type="button" disabled={collection === undefined} onClick={() => add('folder')}>{t('Add folder')}</button>
        </div>
        {draft.map((asset, index) => {
          const payload = asRecord(asset.payload);
          const type = asset.kind === 'regex' ? 'Regex' : payload.type === 'folder' ? 'Folder' : 'Script';
          const sameKind = draft.filter((item) => item.kind === asset.kind);
          return (
            <details key={`${collection?.owner.revision ?? 'draft'}:${asset.kind}:${asset.sourceKey}`} open data-testid="extension-asset-card">
              <summary>{t(type)} #{asset.ordinal + 1} · {String(payload.scriptName ?? payload.name ?? asset.sourceKey)}</summary>
              <label>{t('Enabled')}<input type="checkbox" checked={asset.enabled} onChange={(event) => setEnabled(index, event.target.checked)} /></label>
              {asset.kind === 'regex' ? (
                <label>{t('Regex payload JSON')}<textarea rows={12} defaultValue={JSON.stringify(asset.payload, null, 2)} onBlur={(event) => {
                  updateJson(`${asset.sourceKey}:payload`, event.target.value, (payloadValue) => update(index, { ...asset, payload: payloadValue }));
                }} /></label>
              ) : (
                <ScriptTreeNodeEditor
                  value={asset.payload}
                  path={asset.sourceKey}
                  updateJson={updateJson}
                  onChange={(node) => update(index, {
                    ...asset,
                    payload: node,
                    enabled: isRecord(node) ? node.enabled !== false : asset.enabled,
                  })}
                />
              )}
              {asset.diagnostics.map((diagnostic) => <code key={diagnostic}>{diagnostic}</code>)}
              <div className="editor-actions">
                <button type="button" aria-label={t('Move resource up')} disabled={asset.ordinal === 0} onClick={() => move(index, -1)}>↑</button>
                <button type="button" aria-label={t('Move resource down')} disabled={asset.ordinal === sameKind.length - 1} onClick={() => move(index, 1)}>↓</button>
                <button type="button" onClick={() => setDraft((current) => normalizedOrder(current.filter((_, itemIndex) => itemIndex !== index)))}>{t('Delete resource')}</button>
              </div>
            </details>
          );
        })}
        {conflict === undefined || conflict.ownerKind !== ownerKind || conflict.ownerId !== ownerId ? null : (
          <ConflictBanner revision={conflict.revision} onReload={() => void load()} onRetry={() => void save(conflict.revision)} />
        )}
        {error === undefined ? null : <p role="alert">{t('Unable to save resources: {{error}}', { error })}</p>}
        <button type="button" disabled={pending || collection === undefined || invalidJsonFields.size > 0} onClick={() => void save()}>{t('Save resources')}</button>
        <RuntimeStateManager />
        {collection === undefined ? null : (
          <ExtensionTrustPanel ownerKind={collection.owner.kind} ownerId={collection.owner.id} />
        )}
      </section>
    </main>
  );
}
