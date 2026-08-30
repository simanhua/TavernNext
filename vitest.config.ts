import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.tsbuild/**', '**/.worktrees/**', 'tests/e2e/**'],
  },
  resolve: {
    alias: {
      '@tavernnext/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@tavernnext/st-compat': fileURLToPath(new URL('./packages/st-compat/src/index.ts', import.meta.url)),
      '@tavernnext/tokenizer-engine': fileURLToPath(new URL('./packages/tokenizer-engine/src/index.ts', import.meta.url)),
      '@tavernnext/prompt-engine': fileURLToPath(new URL('./packages/prompt-engine/src/index.ts', import.meta.url)),
      '@tavernnext/provider-openai-compatible': fileURLToPath(new URL('./packages/provider-openai-compatible/src/index.ts', import.meta.url)),
    },
  },
});
