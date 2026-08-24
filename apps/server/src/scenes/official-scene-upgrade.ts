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

/**
 * One-way startup data upgrade for the only Scene SDK v1 package that shipped
 * during development. It runs before repositories parse the strict v2 schema.
 */
export function upgradeInstalledOfficialSceneRuntime(database: TavernDatabase, dataDir: string): void {
  const row = database.sqlite.prepare('SELECT payload FROM installed_scenes WHERE id = ?')
    .get(DESTINED_POEM_SCENE_ID);
  if (row === undefined || typeof row.payload !== 'string') return;
  let installed: Record<string, unknown>;
  try { installed = JSON.parse(row.payload) as Record<string, unknown>; }
  catch { return; }
  const oldManifest = installed.manifest as Record<string, unknown> | undefined;
  if (oldManifest?.sceneSdkVersion === 2) return;
  if (oldManifest?.sceneSdkVersion !== 1) return;

  const sceneRoot = resolve(dataDir, 'scenes');
  const oldPath = typeof installed.installPath === 'string' ? resolve(installed.installPath) : undefined;
  const runtimePackage = buildDestinedPoemPackage();
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
