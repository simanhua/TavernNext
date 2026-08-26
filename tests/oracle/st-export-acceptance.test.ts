import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportPreset, inspectPreset } from '@tavernnext/st-compat';

const oracleRoot = process.env.TAVERNNEXT_ST_ORACLE_ROOT;
const fixtureRoot = join(import.meta.dirname, '..', 'fixtures');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe.runIf(oracleRoot !== undefined)('pinned SillyTavern export import acceptance', () => {
  it('runs exported presets through the pinned Preset Manager import block', async () => {
    const sourcePath = join(oracleRoot!, 'public', 'scripts', 'preset-manager.js');
    const source = await readFile(sourcePath, 'utf8');
    expect(sha256(source)).toBe('327c5b2cf3e9093d9ada2984f983b99d4c862d49e269bc11b7143d016cd215ee');
    const startMarker = "const fileName = file.name.replace('.json', '').replace('.settings', '');";
    const endMarker = 'await presetManager.savePreset(name, data);';
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const importBlock = source.slice(start, end + endMarker.length);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...values: unknown[]) => Promise<{ data: Record<string, unknown>; name: string }>;
    const runPinnedImport = new AsyncFunction(
      'file', 'parseJsonFile', 'presetManager', `${importBlock}\nreturn { data, name };`,
    );

    const fixtures = [
      'presets/chat/synthetic-chat.settings',
      'presets/text/synthetic-text.json',
      'presets/context/synthetic-context.json',
      'presets/instruct/synthetic-instruct.json',
      'presets/system/synthetic-system.json',
      'presets/reasoning/synthetic-reasoning.json',
    ];
    for (const fixture of fixtures) {
      const bytes = new Uint8Array(await readFile(join(fixtureRoot, ...fixture.split('/'))));
      const preview = await inspectPreset(bytes, basename(fixture));
      const exported = await exportPreset(preview);
      const document = JSON.parse(Buffer.from(exported.bytes).toString('utf8')) as Record<string, unknown>;
      const saves: Array<{ name: string; data: Record<string, unknown> }> = [];
      const accepted = await runPinnedImport(
        { name: exported.fileName },
        async () => structuredClone(document),
        { async savePreset(name: string, data: Record<string, unknown>) { saves.push({ name, data: structuredClone(data) }); } },
      );
      expect(saves).toEqual([{ name: accepted.name, data: accepted.data }]);
      expect(accepted.data.name).toBe(accepted.name);
    }
  });

});
