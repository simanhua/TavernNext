import { createHash } from 'node:crypto';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js/dist/sql-asm.js';

const databasePath = resolve(
  process.env.TAVERNNEXT_DATABASE_PATH ?? 'apps/server/.tavernnext/tavernnext.sqlite',
);
const origin = process.env.TAVERNNEXT_ORIGIN ?? 'http://127.0.0.1:4312';
const target = resolve(process.cwd(), 'apps/server/assets/official-presets');
const expectedTarget = resolve(process.cwd(), 'apps/server/assets/official-presets');
if (target !== expectedTarget) throw new Error('official_preset_capture_target_invalid');

async function json(path) {
  const response = await fetch(`${origin}${path}`);
  if (!response.ok) throw new Error(`preset_capture_http_${response.status}:${path}`);
  return response.json();
}

function rows(database, sql, parameters = []) {
  const statement = database.prepare(sql);
  try {
    statement.bind(parameters);
    const values = [];
    while (statement.step()) values.push(statement.getAsObject());
    return values;
  } finally {
    statement.free();
  }
}

function withoutEntityMetadata(value, omitted = []) {
  const copy = structuredClone(value);
  for (const key of ['revision', 'createdAt', 'updatedAt', ...omitted]) delete copy[key];
  return copy;
}

const SQL = await initSqlJs();
const database = new SQL.Database(new Uint8Array(await readFile(databasePath)));
const presets = rows(database, 'SELECT payload FROM presets ORDER BY created_at, id')
  .map((row) => JSON.parse(String(row.payload)));
const safePresets = new Map((await Promise.all(
  presets.map((preset) => json(`/api/presets/${preset.id}`)),
)).map((preset) => [preset.id, preset]));
const unique = new Map();

for (const preset of presets) {
  const safe = safePresets.get(preset.id);
  if (safe === undefined) throw new Error(`preset_capture_missing:${preset.id}`);
  const canonical = JSON.stringify({ kind: safe.kind, settings: safe.settings });
  const digest = createHash('sha256').update(canonical).digest('hex');
  const existing = unique.get(digest);
  if (existing === undefined) {
    unique.set(digest, { digest, preset, duplicateIds: [] });
  } else {
    existing.duplicateIds.push(preset.id);
  }
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
const entries = [];
const reportEntries = [];
let ordinal = 0;
for (const { digest, preset, duplicateIds } of unique.values()) {
  ordinal += 1;
  const file = `${String(ordinal).padStart(2, '0')}-${digest.slice(0, 12)}.json`;
  const extensionAssets = rows(database, `
    SELECT payload FROM extension_assets
    WHERE owner_kind = 'preset' AND owner_id = ?
    ORDER BY ordinal, created_at, id
  `, [preset.id]).map((row) => withoutEntityMetadata(
    JSON.parse(String(row.payload)), ['ownerKind', 'ownerId'],
  ));
  const runtimeStateRow = rows(database, `
    SELECT payload FROM extension_states
    WHERE scope = 'preset' AND scope_id = ? LIMIT 1
  `, [preset.id])[0];
  const runtimeState = runtimeStateRow === undefined
    ? undefined
    : withoutEntityMetadata(JSON.parse(String(runtimeStateRow.payload)), ['scope', 'scopeId']);
  const safePreset = safePresets.get(preset.id);
  if (safePreset === undefined) throw new Error(`preset_capture_missing:${preset.id}`);
  await writeFile(resolve(target, file), `${JSON.stringify({
    name: preset.name,
    kind: preset.kind,
    settings: safePreset.settings,
    extensions: preset.extensions ?? {},
    extensionAssets,
    ...(runtimeState === undefined ? {} : { runtimeState }),
  }, null, 2)}\n`, 'utf8');
  const entry = {
    id: preset.id,
    name: preset.name,
    kind: preset.kind,
    file,
    sha256: digest,
  };
  entries.push(entry);
  reportEntries.push({ ...entry, duplicateLocalIds: duplicateIds });
}

await writeFile(resolve(target, 'catalog.json'), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ localRows: presets.length, officialPresets: entries.length, entries: reportEntries }, null, 2));
database.close();
