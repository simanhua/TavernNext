import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildDestinedPoemPackage, officialCatalog } from '../apps/server/src/scenes/official-package.js';

const requiredTokens = [
  '--vp-c-bg', '--vp-c-bg-alt', '--vp-c-bg-elv', '--vp-c-bg-soft',
  '--vp-c-text-1', '--vp-c-text-2', '--vp-c-text-3', '--vp-c-divider', '--vp-c-border',
  '--vp-c-brand-1', '--vp-c-brand-2', '--vp-c-brand-3', '--vp-c-brand-soft',
  '--vp-c-success-1', '--vp-c-success-soft', '--vp-c-warning-1', '--vp-c-warning-soft',
  '--vp-c-danger-1', '--vp-c-danger-soft', '--vp-shadow-1', '--vp-shadow-2',
] as const;

describe('host and Scene theme token contract', () => {
  it('keeps every allowlisted VitePress token in both trusted built-in stylesheets', () => {
    const hostCss = readFileSync(resolve('apps/web/src/styles.css'), 'utf8');
    const scenePackage = buildDestinedPoemPackage();
    const sceneCss = strFromU8(unzipSync(scenePackage.bytes)['frontend/styles.css']!);
    for (const token of requiredTokens) {
      expect(hostCss, `host ${token}`).toContain(`${token}:`);
      expect(sceneCss, `scene ${token}`).toContain(`${token}:`);
    }
    expect(scenePackage.manifest.version).toBe('2.17.0');
    expect(officialCatalog().scenes[0]).toMatchObject({
      sceneId: scenePackage.manifest.id,
      version: scenePackage.manifest.version,
    });
  });
});
