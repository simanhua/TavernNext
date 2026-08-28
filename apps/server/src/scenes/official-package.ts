import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  SceneCatalogSchema,
  SceneManifestSchema,
  type InstalledScene,
  type SceneCatalog,
  type SceneManifest,
} from '@tavernnext/domain';
import { strToU8, zipSync } from 'fflate';

export const DESTINED_POEM_SCENE_ID = '018f2000-0000-7000-8000-000000000001';
export const SCENE_LAB_SCENE_ID = '018f2000-0000-7000-8000-000000000002';
const GENERATED_AT = '2026-08-24T00:00:00.000Z';

export interface OfficialSceneDefinition {
  id: string;
  slug: string;
  packageUrl: `builtin:${string}`;
}

const definitions: readonly OfficialSceneDefinition[] = [
  { id: DESTINED_POEM_SCENE_ID, slug: 'destined-poem', packageUrl: 'builtin:destined-poem' },
  { id: SCENE_LAB_SCENE_ID, slug: 'scene-lab', packageUrl: 'builtin:scene-lab' },
];

function assertRegistry(): void {
  for (const field of ['id', 'slug', 'packageUrl'] as const) {
    const values = definitions.map((definition) => definition[field]);
    if (new Set(values).size !== values.length) throw new Error(`official_scene_${field}_duplicate`);
  }
}

assertRegistry();

const byId = new Map(definitions.map((definition) => [definition.id, definition]));
const byUrl = new Map(definitions.map((definition) => [definition.packageUrl, definition]));

function sceneAssetRoot(definition: OfficialSceneDefinition): string {
  const candidates = [
    resolve(process.cwd(), 'apps/server/assets/official-scenes', definition.slug),
    resolve(process.cwd(), 'assets/official-scenes', definition.slug),
  ];
  const found = candidates.find(existsSync);
  if (found === undefined) throw new Error(`official_scene_asset_missing:${definition.slug}`);
  return found;
}

function portableFiles(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? portableFiles(root, path) : [relative(root, path).replaceAll('\\', '/')];
  });
}

function readManifest(definition: OfficialSceneDefinition): SceneManifest {
  const path = resolve(sceneAssetRoot(definition), 'manifest.json');
  let manifest: SceneManifest;
  try {
    manifest = SceneManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new Error(`official_scene_manifest_invalid:${definition.slug}`);
  }
  if (manifest.id !== definition.id || manifest.slug !== definition.slug
    || definition.packageUrl !== `builtin:${manifest.slug}`) {
    throw new Error(`official_scene_registry_mismatch:${definition.slug}`);
  }
  if (manifest.backingCharacterPath === undefined) {
    throw new Error(`official_scene_backing_character_missing:${definition.slug}`);
  }
  const declared = new Set(manifest.files);
  const actual = portableFiles(sceneAssetRoot(definition));
  if (actual.some((file) => !declared.has(file)) || manifest.files.some((file) => !actual.includes(file))) {
    throw new Error(`official_scene_files_mismatch:${definition.slug}`);
  }
  return manifest;
}

export interface OfficialScenePackage {
  manifest: SceneManifest;
  bytes: Uint8Array;
  digest: string;
}

const packageCache = new Map<string, OfficialScenePackage>();

function cachedPackage(definition: OfficialSceneDefinition): OfficialScenePackage {
  const existing = packageCache.get(definition.id);
  if (existing !== undefined) return existing;
  const root = sceneAssetRoot(definition);
  const manifest = readManifest(definition);
  const files = Object.fromEntries([...manifest.files].sort().map((path) => [
    path,
    path === 'manifest.json'
      ? strToU8(JSON.stringify(manifest))
      : new Uint8Array(readFileSync(resolve(root, ...path.split('/')))),
  ]));
  const bytes = zipSync(files, { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0) });
  const value = { manifest, bytes, digest: createHash('sha256').update(bytes).digest('hex') };
  packageCache.set(definition.id, value);
  return value;
}

function clonedPackage(definition: OfficialSceneDefinition): OfficialScenePackage {
  const value = cachedPackage(definition);
  return {
    manifest: structuredClone(value.manifest),
    bytes: new Uint8Array(value.bytes),
    digest: value.digest,
  };
}

export function buildOfficialScenePackage(sceneId: string): OfficialScenePackage | undefined {
  const definition = byId.get(sceneId);
  return definition === undefined ? undefined : clonedPackage(definition);
}

export function destinedPoemManifest(): SceneManifest {
  return structuredClone(cachedPackage(byId.get(DESTINED_POEM_SCENE_ID)!).manifest);
}

export function buildDestinedPoemPackage(): OfficialScenePackage {
  return clonedPackage(byId.get(DESTINED_POEM_SCENE_ID)!);
}

export function officialCatalog(): SceneCatalog {
  return SceneCatalogSchema.parse({
    version: 1,
    generatedAt: GENERATED_AT,
    scenes: definitions.map((definition) => {
      const scene = cachedPackage(definition);
      return {
        sceneId: scene.manifest.id,
        version: scene.manifest.version,
        packageUrl: definition.packageUrl,
        minimumTavernNextVersion: scene.manifest.minimumTavernNextVersion,
        name: scene.manifest.name,
        summary: scene.manifest.summary,
        author: scene.manifest.author,
      };
    }),
  });
}

export function builtInPackage(url: string): OfficialScenePackage | undefined {
  const definition = byUrl.get(url as OfficialSceneDefinition['packageUrl']);
  return definition === undefined ? undefined : clonedPackage(definition);
}

export function isBundledOfficialScene(scene: Pick<InstalledScene, 'id'>): boolean {
  return byId.has(scene.id);
}

export function officialSceneIds(): string[] {
  return definitions.map((definition) => definition.id);
}
