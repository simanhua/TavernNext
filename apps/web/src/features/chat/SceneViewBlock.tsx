import type { RoleplaySceneViewBlock } from '@tavernnext/domain';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../../api/client.js';

const DESTINED_POEM_SCENE_ID = '018f2000-0000-7000-8000-000000000001';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function statuses(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function combatant(value: unknown) {
  const item = record(value) ?? {};
  return {
    id: text(item.id),
    name: text(item.name),
    hp: number(item.hp),
    maxHp: number(item.maxHp),
    statuses: statuses(item.statuses),
  };
}

function Combatant({ value }: { value: ReturnType<typeof combatant> }) {
  return (
    <article className="scene-combatant">
      <strong>{value.name}</strong>
      <span>{value.hp} / {value.maxHp} HP</span>
      <progress max={Math.max(1, value.maxHp)} value={Math.max(0, Math.min(value.hp, value.maxHp))} />
      {value.statuses.length === 0 ? null : <small>{value.statuses.join(' · ')}</small>}
    </article>
  );
}

function ViewShell({ block, title, className, children }: {
  block: RoleplaySceneViewBlock;
  title: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`scene-view ${className}`}
      aria-label={title}
      data-scene-view-id={block.viewId}
      data-source-state-revision={block.sourceStateRevision}
    >
      {children}
    </section>
  );
}

function resource(props: Record<string, unknown>, key: string, maximum: string) {
  return { value: number(props[key]), maximum: number(props[maximum]) };
}

function StatusView({ block, props }: { block: RoleplaySceneViewBlock; props: Record<string, unknown> }) {
  const resources = record(props.resources) ?? {};
  const attributes = Object.entries(record(props.attributes) ?? {});
  const items = [
    ['HP', resource(resources, 'hp', 'maxHp')],
    ['MP', resource(resources, 'mp', 'maxMp')],
    ['Stamina', resource(resources, 'stamina', 'maxStamina')],
  ] as const;
  return <ViewShell block={block} title={`${text(props.name) || 'Character'} status`} className="scene-view-status">
    <header><strong>{text(props.name) || 'Character status'}</strong><span>Lv. {number(props.level)} · {text(props.rank)}</span></header>
    <div className="scene-view-meters">{items.map(([label, meter]) => <div key={label}>
      <span>{label} {meter.value} / {meter.maximum}</span>
      <progress max={Math.max(1, meter.maximum)} value={Math.max(0, Math.min(meter.value, meter.maximum))} />
    </div>)}</div>
    {attributes.length === 0 ? null : <div className="scene-view-attributes" aria-label="Attributes">
      {attributes.map(([name, value]) => <div key={name} role="group" aria-label={`${name} attribute`}>
        <span>{name}</span><strong>{number(value)}</strong>
      </div>)}
    </div>}
    <p>Fate {number(props.fate)}{statuses(props.statuses).length === 0 ? '' : ` · ${statuses(props.statuses).join(' · ')}`}</p>
  </ViewShell>;
}

function MapView({ block, props }: { block: RoleplaySceneViewBlock; props: Record<string, unknown> }) {
  const markers = Array.isArray(props.markers) ? props.markers.map((value) => record(value) ?? {}) : [];
  return <ViewShell block={block} title={`${text(props.location) || 'World'} map`} className="scene-view-map">
    <header><strong>{text(props.location) || 'World map'}</strong><span>{text(props.time)}</span></header>
    <div className="scene-view-card-grid">{markers.map((marker) => <article key={text(marker.id) || text(marker.name)} data-active={marker.active === true}>
      <strong>{text(marker.name)}</strong><small>{text(marker.group)}</small><p>{text(marker.description)}</p>
    </article>)}</div>
  </ViewShell>;
}

function RelationshipView({ block, props }: { block: RoleplaySceneViewBlock; props: Record<string, unknown> }) {
  const entries = Array.isArray(props.entries) ? props.entries.map((value) => record(value) ?? {}) : [];
  return <ViewShell block={block} title="Relationship view" className="scene-view-relationship">
    <header><strong>Relationships</strong></header>
    <div className="scene-view-card-grid">{entries.map((entry) => <article key={text(entry.id) || text(entry.name)}>
      <strong>{text(entry.name)}</strong><span>Affinity {number(entry.affinity)}</span><p>{text(entry.description)}</p>
    </article>)}</div>
  </ViewShell>;
}

function ProgressView({ block, props }: { block: RoleplaySceneViewBlock; props: Record<string, unknown> }) {
  const event = record(props.event) ?? {};
  const quests = Array.isArray(props.quests) ? props.quests.map((value) => record(value) ?? {}) : [];
  return <ViewShell block={block} title="Progress view" className="scene-view-progress">
    <header><strong>{text(event.title) || 'Journey progress'}</strong><span>{text(event.stage)}</span></header>
    <p>Level {number(props.level)} · XP {number(props.experience)} / {number(props.nextExperience)}</p>
    <div className="scene-view-card-grid">{quests.map((quest) => <article key={text(quest.id) || text(quest.title)}>
      <strong>{text(quest.title)}</strong><span>{text(quest.status)}</span><p>{text(quest.description)}</p>
    </article>)}</div>
  </ViewShell>;
}

export function SceneViewBlock({ block }: { block: RoleplaySceneViewBlock }) {
  const scene = useQuery({
    queryKey: ['scene-view-trust', block.sceneId, block.sceneVersion, block.sceneDigest],
    queryFn: () => api.getScene(block.sceneId),
    staleTime: 60_000,
  });
  const declaration = scene.data?.manifest.sceneViews.find((view) => (
    view.kind === block.kind
    && view.schemaVersion === block.schemaVersion
    && view.renderer.id === block.rendererId
  ));
  if (scene.data?.fullyTrusted !== true
    || scene.data.id !== block.sceneId
    || scene.data.version !== block.sceneVersion
    || scene.data.archiveDigest !== block.sceneDigest
    || declaration === undefined
    || block.sceneId !== DESTINED_POEM_SCENE_ID
    || block.schemaVersion !== 1) {
    return null;
  }
  const props = record(block.props);
  if (props === undefined) return null;
  if (block.kind === 'status' && block.rendererId === 'destined-poem-status-v1') {
    return <StatusView block={block} props={props} />;
  }
  if (block.kind === 'map' && block.rendererId === 'destined-poem-map-v1') {
    return <MapView block={block} props={props} />;
  }
  if (block.kind === 'relationship' && block.rendererId === 'destined-poem-relationship-v1') {
    return <RelationshipView block={block} props={props} />;
  }
  if (block.kind === 'progress' && block.rendererId === 'destined-poem-progress-v1') {
    return <ProgressView block={block} props={props} />;
  }
  if (block.kind !== 'combat' || block.rendererId !== 'destined-poem-combat-v1') return null;
  const protagonist = combatant(props?.protagonist);
  const opponents = Array.isArray(props?.opponents) ? props.opponents.map(combatant) : [];
  return <ViewShell block={block} title={text(props?.title) || 'Combat view'} className="scene-view-combat">
      <header>
        <strong>{text(props?.title) || 'Combat view'}</strong>
        {text(props?.location) === '' ? null : <span>{text(props?.location)}</span>}
      </header>
      <div className="scene-combat-grid">
        <Combatant value={protagonist} />
        {opponents.map((opponent) => <Combatant key={opponent.id || opponent.name} value={opponent} />)}
      </div>
    </ViewShell>;
}
