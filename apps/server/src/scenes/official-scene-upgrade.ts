import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import type { TavernDatabase } from '../db/client.js';
import type { Repositories } from '../db/repositories.js';
import { persistPresetBytes } from '../services/preset-import-handler.js';
import {
  officialPresetIdForBytes,
  officialPresetIdForPreset,
} from '../services/official-preset-registry.js';
import { buildOfficialScenePackage, officialSceneIds } from './official-package.js';

function within(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function timestampPath(): string {
  return new Date().toISOString().replaceAll(':', '-');
}

export interface OfficialSceneUpgradeFailure {
  sceneId: string;
  code: string;
}

function failureCode(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'official_scene_upgrade_failed';
}

function upgradeOne(
  database: TavernDatabase,
  dataDir: string,
  sceneId: string,
  repositories: Repositories,
): void {
  const row = database.sqlite.prepare('SELECT payload FROM installed_scenes WHERE id = ?').get(sceneId);
  if (row === undefined || typeof row.payload !== 'string') return;
  let installed: Record<string, unknown>;
  try { installed = JSON.parse(row.payload) as Record<string, unknown>; }
  catch { throw new Error('official_scene_install_record_invalid'); }
  const runtimePackage = buildOfficialScenePackage(sceneId);
  if (runtimePackage === undefined) throw new Error('official_scene_registry_missing');
  if (installed.archiveDigest === runtimePackage.digest) return;

  const sceneRoot = resolve(dataDir, 'scenes');
  const oldPath = typeof installed.installPath === 'string' ? resolve(installed.installPath) : undefined;
  const target = resolve(sceneRoot, sceneId, runtimePackage.digest);
  const stage = resolve(sceneRoot, `.stage-upgrade-${sceneId}-${randomUUID()}`);
  if (!within(sceneRoot, target) || !within(sceneRoot, stage)) throw new Error('scene_upgrade_path_invalid');

  const backupRoot = resolve(dataDir, 'backups', `scene-upgrade-${timestampPath()}-${sceneId}`);
  mkdirSync(backupRoot, { recursive: true });
  if (existsSync(database.path)) copyFileSync(database.path, resolve(backupRoot, 'tavernnext.sqlite'));
  if (oldPath !== undefined && within(sceneRoot, oldPath) && existsSync(oldPath)) {
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
    database.transaction(() => {
      const presetPath = runtimePackage.manifest.backingPresetPath;
      const presetBytes = presetPath === undefined ? undefined : files[presetPath];
      if (presetPath !== undefined && presetBytes === undefined) throw new Error('scene_preset_missing');
      const officialPresetId = presetPath === undefined || presetBytes === undefined
        ? undefined
        : officialPresetIdForBytes(presetBytes, presetPath);
      const installedPreset = typeof installed.backingPresetId === 'string'
        ? repositories.presets.get(installed.backingPresetId)
        : undefined;
      const reusableInstalledPreset = installedPreset !== undefined
        && officialPresetIdForPreset(installedPreset) === officialPresetId
        ? installedPreset
        : undefined;
      const replacementPreset = presetPath === undefined || presetBytes === undefined
        ? undefined
        : (officialPresetId === undefined ? undefined : repositories.presets.get(officialPresetId))
          ?? reusableInstalledPreset
          ?? persistPresetBytes(repositories, presetBytes, presetPath);
      const next = {
        ...installed,
        revision,
        updatedAt,
        version: runtimePackage.manifest.version,
        archiveDigest: runtimePackage.digest,
        installPath: target,
        manifest: runtimePackage.manifest,
        ...(replacementPreset === undefined ? {} : { backingPresetId: replacementPreset.id }),
      };
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
        sceneId,
      );
      if (result.changes !== 1) throw new Error('scene_upgrade_not_found');
    });
    if (oldPath !== undefined && oldPath !== target && within(sceneRoot, oldPath) && existsSync(oldPath)) {
      try { rmSync(oldPath, { recursive: true, force: true }); }
      catch {
        // The new package is already committed. A stale immutable asset directory
        // is safe to retain and must not turn successful activation into failure.
      }
    }
  } catch (error) {
    if (existsSync(stage) && within(sceneRoot, stage)) rmSync(stage, { recursive: true, force: true });
    const current = database.sqlite.prepare('SELECT archive_digest FROM installed_scenes WHERE id = ?').get(sceneId);
    if (current?.archive_digest !== runtimePackage.digest && existsSync(target) && within(sceneRoot, target)) {
      rmSync(target, { recursive: true, force: true });
    }
    throw error;
  }
}

export function upgradeInstalledOfficialScenes(
  database: TavernDatabase,
  dataDir: string,
  repositories: Repositories,
): OfficialSceneUpgradeFailure[] {
  const failures: OfficialSceneUpgradeFailure[] = [];
  for (const sceneId of officialSceneIds()) {
    try { upgradeOne(database, dataDir, sceneId, repositories); }
    catch (error) { failures.push({ sceneId, code: failureCode(error) }); }
  }
  return failures;
}
