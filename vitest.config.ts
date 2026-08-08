import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.tsbuild/**'],
  },
  resolve: {
    alias: {
      '@tavernnext/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@tavernnext/provider-openai-compatible': fileURLToPath(new URL('./packages/provider-openai-compatible/src/index.ts', import.meta.url)),
    },
  },
});
