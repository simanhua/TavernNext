import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { TavernDatabase } from '../db/client.js';
import { unzipSync } from 'fflate';
import {
  buildDestinedPoemPackage,
  DESTINED_POEM_SCENE_ID,
} from './official-package.js';

function within(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function timestampPath(): string {
  return new Date().toISOString().replaceAll(':', '-');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeDestinedPoemValue(value: unknown): boolean {
  const protagonist = record(record(value)?.主角);
  if (protagonist === undefined) return false;
  let changed = false;
  if (!Object.hasOwn(protagonist, '装备') || protagonist.装备 === null) {
    protagonist.装备 = {};
    changed = true;
  }
  if (!Object.hasOwn(protagonist, '背包') || protagonist.背包 === null) {
    protagonist.背包 = {};
    changed = true;
  }
  return changed;
}

function normalizeDestinedPoemSaveStates(database: TavernDatabase): void {
  const now = new Date().toISOString();
  const normalizeRows = (
    table: 'conversation_scene_states' | 'scene_state_transitions',
    rows: Array<Record<string, string | number | Uint8Array | null>>,
    fields: string[],
  ) => {
    for (const row of rows) {
      if (typeof row.id !== 'string' || typeof row.payload !== 'string' || typeof row.revision !== 'number') continue;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(row.payload) as Record<string, unknown>; }
      catch { continue; }
      let changed = false;
      for (const field of fields) changed = normalizeDestinedPoemValue(payload[field]) || changed;
      if (!changed) continue;
      const revision = row.revision + 1;
      payload.revision = revision;
      payload.updatedAt = now;
      const updated = database.sqlite.prepare(`
        UPDATE ${table} SET revision = ?, updated_at = ?, payload = ? WHERE id = ? AND revision = ?
      `).run(revision, now, JSON.stringify(payload), row.id, row.revision);
      if (updated.changes !== 1) throw new Error('scene_save_normalization_conflict');
    }
  };
  normalizeRows('conversation_scene_states', database.sqlite.prepare(`
    SELECT states.id, states.revision, states.payload
    FROM conversation_scene_states states
    INNER JOIN conversations saves ON saves.id = states.conversation_id
    WHERE saves.scene_id = ?
  `).all(DESTINED_POEM_SCENE_ID), ['baseValue', 'value']);
  normalizeRows('scene_state_transitions', database.sqlite.prepare(`
    SELECT transitions.id, transitions.revision, transitions.payload
    FROM scene_state_transitions transitions
    INNER JOIN conversations saves ON saves.id = transitions.conversation_id
    WHERE saves.scene_id = ?
  `).all(DESTINED_POEM_SCENE_ID), ['value']);
}

/**
 * One-way startup asset upgrade for the bundled official Scene. It preserves
 * backing resources and Saves while replacing the immutable package files.
 */
export function upgradeInstalledOfficialSceneRuntime(database: TavernDatabase, dataDir: string): void {
  const row = database.sqlite.prepare('SELECT payload FROM installed_scenes WHERE id = ?')
    .get(DESTINED_POEM_SCENE_ID);
  if (row === undefined || typeof row.payload !== 'string') return;
  let installed: Record<string, unknown>;
  try { installed = JSON.parse(row.payload) as Record<string, unknown>; }
  catch { return; }
  const oldManifest = installed.manifest as Record<string, unknown> | undefined;
  if (oldManifest?.sceneSdkVersion !== 1 && oldManifest?.sceneSdkVersion !== 2) return;
  const runtimePackage = buildDestinedPoemPackage();
  if (installed.archiveDigest === runtimePackage.digest) {
    database.transaction(() => normalizeDestinedPoemSaveStates(database));
    return;
  }

  const sceneRoot = resolve(dataDir, 'scenes');
  const oldPath = typeof installed.installPath === 'string' ? resolve(installed.installPath) : undefined;
  const target = resolve(sceneRoot, DESTINED_POEM_SCENE_ID, runtimePackage.digest);
  const stage = resolve(sceneRoot, `.stage-v2-${crypto.randomUUID()}`);
  if (!within(sceneRoot, target) || !within(sceneRoot, stage)) throw new Error('scene_upgrade_path_invalid');

  const backupRoot = resolve(dataDir, 'backups', `scene-runtime-v1-${timestampPath()}-${DESTINED_POEM_SCENE_ID}`);
  if (oldPath !== undefined && within(sceneRoot, oldPath) && existsSync(oldPath)) {
    mkdirSync(backupRoot, { recursive: true });
    cpSync(oldPath, resolve(backupRoot, 'assets'), { recursive: true, errorOnExist: true });
  }

  const files = unzipSync(runtimePackage.bytes);
  mkdirSync(stage, { recursive: true });
  try {
    for (const [path, contents] of Object.entries(files)) {
      if (!runtimePackage.manifest.files.includes(path)) throw new Error('scene_upgrade_file_invalid');
      const destination = resolve(stage, ...path.split('/'));
      if (!within(stage, destination)) throw new Error('scene_upgrade_path_invalid');
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(stage, target);

    const revision = typeof installed.revision === 'number' ? installed.revision + 1 : 1;
    const updatedAt = new Date().toISOString();
    const next = {
      ...installed,
      revision,
      updatedAt,
      version: runtimePackage.manifest.version,
      archiveDigest: runtimePackage.digest,
      installPath: target,
      manifest: runtimePackage.manifest,
    };
    database.transaction(() => {
      const result = database.sqlite.prepare(`
        UPDATE installed_scenes
        SET revision = ?, updated_at = ?, payload = ?, version = ?, archive_digest = ?
        WHERE id = ?
      `).run(
        revision,
        updatedAt,
        JSON.stringify(next),
        runtimePackage.manifest.version,
        runtimePackage.digest,
        DESTINED_POEM_SCENE_ID,
      );
      if (result.changes !== 1) throw new Error('scene_upgrade_not_found');
      normalizeDestinedPoemSaveStates(database);
    });
    if (oldPath !== undefined && oldPath !== target && within(sceneRoot, oldPath) && existsSync(oldPath)) {
      rmSync(oldPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (existsSync(stage) && within(sceneRoot, stage)) rmSync(stage, { recursive: true, force: true });
    const current = database.sqlite.prepare('SELECT archive_digest FROM installed_scenes WHERE id = ?')
      .get(DESTINED_POEM_SCENE_ID);
    if (current?.archive_digest !== runtimePackage.digest && existsSync(target) && within(sceneRoot, target)) {
      rmSync(target, { recursive: true, force: true });
    }
    throw error;
  }
}
