import { defineConfig } from '@playwright/test';

const apiPort = Number(process.env.TAVERNNEXT_E2E_API_PORT ?? 40_000 + Math.floor(Math.random() * 20_000));
process.env.TAVERNNEXT_E2E_API_PORT = String(apiPort);
process.env.TAVERNNEXT_API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -w @tavernnext/web -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
