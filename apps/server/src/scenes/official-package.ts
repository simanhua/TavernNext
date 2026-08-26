import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SceneCatalogSchema,
  SceneManifestSchema,
  type SceneCatalog,
  type SceneManifest,
} from '@tavernnext/domain';
import {
  attachedVariableValue,
  decodeInspectedCharacter,
  stripPngTextMetadata,
} from '@tavernnext/st-compat';
import { strToU8, zipSync } from 'fflate';

export const DESTINED_POEM_SCENE_ID = '018f2000-0000-7000-8000-000000000001';
const GENERATED_AT = '2026-08-24T00:00:00.000Z';
const PACKAGE_URL = 'builtin:destined-poem';
const DESTINED_POEM_ASSET_ROOT = ['apps/server/assets/official-scenes/destined-poem', 'assets/official-scenes/destined-poem']
  .map((path) => resolve(process.cwd(), path))
  .find(existsSync);

function destinedPoemAsset(path: string): Uint8Array {
  if (DESTINED_POEM_ASSET_ROOT === undefined) throw new Error('official_scene_asset_missing');
  return new Uint8Array(readFileSync(resolve(DESTINED_POEM_ASSET_ROOT, ...path.split('/'))));
}

function destinedPoemStateSchema(): Record<string, unknown> {
  return JSON.parse(Buffer.from(destinedPoemAsset('content/state-schema.json')).toString('utf8')) as Record<string, unknown>;
}

function characterCardPath(): string {
  const candidates = [
    resolve(process.cwd(), 'example-role-card', 'v4.2.1.png'),
    resolve(process.cwd(), '..', '..', 'example-role-card', 'v4.2.1.png'),
  ];
  const found = candidates.find(existsSync);
  if (found === undefined) throw new Error('official_scene_source_missing');
  return found;
}

function initialState(cardBytes: Uint8Array): Record<string, unknown> {
  const decoded = decodeInspectedCharacter(cardBytes, 'v4.2.1.png');
  if (decoded.character === null) throw new Error('official_scene_character_invalid');
  const variables = attachedVariableValue(decoded.character.extensions) ?? {};
  const mapMarkers = Array.isArray(variables.map_markers) ? variables.map_markers : [];
  return {
    事件: { 开启: false, 结束: false, 标题: '', 阶段: '', 已完成事件: [] },
    世界: { 时间: '', 地点: '' },
    任务列表: {},
    主角: {
      姓名: '', 描述: '', 种族: '', 身份: [], 职业: [], 生命层级: '第一层级/普通', 等级: 1,
      累计经验值: 0, 升级所需经验: 120, 冒险者等级: '未评级', 属性点: 0,
      属性: { 力量: 0, 敏捷: 0, 体质: 0, 智力: 0, 精神: 0 },
      生命值上限: 0, 生命值: 0, 法力值上限: 0, 法力值: 0, 体力值上限: 0, 体力值: 0,
      状态效果: {}, 金钱: 0, 装备: {}, 背包: {}, 技能: {},
    },
    命运点数: 0,
    关系列表: {},
    地图: { 标记: mapMarkers },
  };
}

export function destinedPoemManifest(): SceneManifest {
  return SceneManifestSchema.parse({
    id: DESTINED_POEM_SCENE_ID,
    slug: 'destined-poem',
    version: '2.5.0',
    name: '命定之诗与黄昏之歌',
    summary: '在阿斯塔利亚开启一段拥有独立状态、任务、关系与地图的命运旅程。',
    description: '完整迁移自命定之诗与黄昏之歌 v4.2 的官方 TavernNext 场景。每个存档拥有隔离的消息和世界状态。',
    author: 'The Poem of Destiny',
    minimumTavernNextVersion: '1.0.0',
    sceneSdkVersion: 2,
    frontendEntry: 'frontend/app.js',
    frontendStyles: ['frontend/styles.css'],
    serverEntry: 'server/index.mjs',
    coverPath: 'content/cover.png',
    setupSchema: { type: 'object', required: ['origin'], properties: { origin: { type: 'string', minLength: 1 } } },
    stateSchema: destinedPoemStateSchema(),
    generationRecipe: { source: 'scene', outputProtocol: 'mvu-json-patch-v1' },
    files: [
      'manifest.json', 'frontend/app.js', 'frontend/action-info.mjs', 'frontend/status-rail.mjs', 'frontend/styles.css',
      'server/index.mjs', 'content/initial-state.json', 'content/state-schema.json',
      'content/character.png', 'content/cover.png',
    ],
  });
}

export interface OfficialScenePackage {
  manifest: SceneManifest;
  bytes: Uint8Array;
  digest: string;
}

export function buildDestinedPoemPackage(): OfficialScenePackage {
  const manifest = destinedPoemManifest();
  const cardBytes = new Uint8Array(readFileSync(characterCardPath()));
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'frontend/app.js': destinedPoemAsset('frontend/app.js'),
    'frontend/action-info.mjs': destinedPoemAsset('frontend/action-info.mjs'),
    'frontend/status-rail.mjs': destinedPoemAsset('frontend/status-rail.mjs'),
    'frontend/styles.css': destinedPoemAsset('frontend/styles.css'),
    'server/index.mjs': destinedPoemAsset('server/index.mjs'),
    'content/initial-state.json': strToU8(JSON.stringify(initialState(cardBytes))),
    'content/state-schema.json': destinedPoemAsset('content/state-schema.json'),
    'content/character.png': cardBytes,
    'content/cover.png': stripPngTextMetadata(cardBytes),
  };
  // ZIP stores DOS local-time fields. Constructing the same local calendar
  // value on every host keeps the signed archive digest platform-independent.
  const bytes = zipSync(files, { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0) });
  return { manifest, bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

export function officialCatalog(): SceneCatalog {
  const scene = buildDestinedPoemPackage();
  return SceneCatalogSchema.parse({
    version: 1,
    generatedAt: GENERATED_AT,
    scenes: [{
      sceneId: scene.manifest.id,
      version: scene.manifest.version,
      packageUrl: PACKAGE_URL,
      minimumTavernNextVersion: scene.manifest.minimumTavernNextVersion,
      name: scene.manifest.name,
      summary: scene.manifest.summary,
      author: scene.manifest.author,
    }],
  });
}

export function builtInPackage(url: string): OfficialScenePackage | undefined {
  return url === PACKAGE_URL ? buildDestinedPoemPackage() : undefined;
}
