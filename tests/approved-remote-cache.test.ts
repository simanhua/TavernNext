import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyApprovedRemoteCache } from '../scripts/approved-remote-cache.mjs';

const directories: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tavernnext-approved-cache-'));
  directories.push(directory);
  const characterPath = join(directory, 'card.png');
  const presetPath = join(directory, 'preset.json');
  const cachedPath = join(directory, 'entry.js');
  const manifestPath = join(directory, 'approved-cache.json');
  writeFileSync(characterPath, 'reviewed-card');
  writeFileSync(presetPath, 'reviewed-preset');
  writeFileSync(cachedPath, 'export const reviewed = true;');
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    artifacts: { characterSha256: hash('reviewed-card'), presetSha256: hash('reviewed-preset') },
    entries: [{
      url: 'https://cdn.example/reviewed.js',
      sha256: hash('export const reviewed = true;'),
      path: 'entry.js',
    }],
  }));
  return { manifestPath, characterPath, presetPath, cachedPath };
}

describe('approved remote cache manifest', () => {
  it('binds reviewed cache bytes to the exact acceptance artifacts without network access', () => {
    const value = fixture();
    const verified = verifyApprovedRemoteCache(value.manifestPath, value);
    expect(verified.entries).toEqual([expect.objectContaining({
      url: 'https://cdn.example/reviewed.js', sha256: hash('export const reviewed = true;'),
    })]);
  });

  it('rejects cache or artifact bytes that differ from the approved hashes', () => {
    const value = fixture();
    writeFileSync(value.cachedPath, 'changed');
    expect(() => verifyApprovedRemoteCache(value.manifestPath, value)).toThrow('cached bytes do not match approved hash');
    writeFileSync(value.cachedPath, 'export const reviewed = true;');
    writeFileSync(value.characterPath, 'changed-card');
    expect(() => verifyApprovedRemoteCache(value.manifestPath, value)).toThrow('not approved for the configured Character and Preset');
  });
});
