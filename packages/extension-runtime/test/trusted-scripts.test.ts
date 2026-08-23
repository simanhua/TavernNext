import { describe, expect, it } from 'vitest';
import { buildTrustedScriptManifest, type TrustedScriptOwnerInput } from '../src/index.js';

function owner(kind: 'preset' | 'character', patch: Partial<TrustedScriptOwnerInput> = {}): TrustedScriptOwnerInput {
  return {
    owner: { kind, id: `${kind}-id` }, revision: 1, bundleDigest: kind.repeat(64).slice(0, 64), trusted: true,
    assets: [{
      kind: 'tavern_helper', sourceKey: `${kind}-tree`, ordinal: 0, enabled: true,
      payload: {
        id: `${kind}-folder`, type: 'folder', enabled: true, children: [{
          id: `${kind}-script`, type: 'script', name: `${kind} script`, enabled: true,
          content: `window.started.push('${kind}')`,
          button: { enabled: true, buttons: [{ name: `${kind} action`, visible: true }] },
        }],
      },
    }],
    ...patch,
  };
}

describe('trusted script runtime manifest', () => {
  it('starts only trusted enabled active owners in Preset then Character tree order', () => {
    const manifest = buildTrustedScriptManifest('conversation-1', {
      preset: owner('preset'),
      character: owner('character'),
    });

    expect(manifest.scripts.map(({ owner, id }) => `${owner.kind}:${id}`)).toEqual([
      'preset:preset:preset-id:preset-script',
      'character:character:character-id:character-script',
    ]);
    expect(manifest.buttons.map(({ scriptId, name }) => `${scriptId}:${name}`)).toEqual([
      'preset:preset-id:preset-script:preset action',
      'character:character-id:character-script:character action',
    ]);
    expect(manifest.runtimeKey).toContain('conversation-1');
    expect(manifest.runtimeKey).toContain('preset-id:1');
    expect(manifest.runtimeKey).toContain('character-id:1');
  });

  it('omits untrusted, disabled, and hidden script resources', () => {
    const preset = owner('preset', { trusted: false });
    const character = owner('character');
    const payload = character.assets[0]!.payload as { children: Array<Record<string, unknown>> };
    payload.children.push({ id: 'off', type: 'script', enabled: false, content: 'throw new Error()', button: {} });
    payload.children.push({ id: 'hidden-button', type: 'script', enabled: true, content: '', button: {
      enabled: true, buttons: [{ name: 'hidden', visible: false }],
    } });

    const manifest = buildTrustedScriptManifest('conversation-1', { preset, character });

    expect(manifest.scripts.map(({ sourceId }) => sourceId)).toEqual(['character-script', 'hidden-button']);
    expect(manifest.buttons.map(({ name }) => name)).toEqual(['character action']);
  });

  it('pins reviewed static imports to the same-origin verified cache', () => {
    const preset = owner('preset', {
      remoteEntries: [{ url: 'https://cdn.example/script.js', sha256: 'f'.repeat(64) }],
    });
    const payload = preset.assets[0]!.payload as { children: Array<Record<string, unknown>> };
    payload.children[0]!.content = "import 'https://cdn.example/script.js';";

    const manifest = buildTrustedScriptManifest('conversation-1', { preset });

    expect(manifest.scripts[0]?.content).toBe(
      `import '/api/extension-trust/preset/preset-id/cache/${'f'.repeat(64)}';`,
    );
  });
});
