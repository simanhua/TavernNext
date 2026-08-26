import type { RoleplaySceneViewBlock } from '@tavernnext/domain';
import { useQuery } from '@tanstack/react-query';
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
    || block.rendererId !== 'destined-poem-combat-v1' || block.kind !== 'combat' || block.schemaVersion !== 1) {
    return null;
  }
  const props = record(block.props);
  const protagonist = combatant(props?.protagonist);
  const opponents = Array.isArray(props?.opponents) ? props.opponents.map(combatant) : [];
  return (
    <section
      className="scene-view scene-view-combat"
      aria-label={text(props?.title) || 'Combat view'}
      data-scene-view-id={block.viewId}
      data-source-state-revision={block.sourceStateRevision}
    >
      <header>
        <strong>{text(props?.title) || 'Combat view'}</strong>
        {text(props?.location) === '' ? null : <span>{text(props?.location)}</span>}
      </header>
      <div className="scene-combat-grid">
        <Combatant value={protagonist} />
        {opponents.map((opponent) => <Combatant key={opponent.id || opponent.name} value={opponent} />)}
      </div>
    </section>
  );
}
