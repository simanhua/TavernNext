import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const officialScenes = ['destined-poem', 'scene-lab', 'taixu-chronicles'];

describe('official Scene speech input', () => {
  it.each(officialScenes)('%s uses the platform speech input primitive', (scene) => {
    const source = readFileSync(resolve(
      'apps', 'server', 'assets', 'official-scenes', scene, 'frontend', 'app.js',
    ), 'utf8');

    expect(source).toContain('sdk.ui.speechInput.mount');
    expect(source).toContain('speechInputController?.destroy()');
  });
});
