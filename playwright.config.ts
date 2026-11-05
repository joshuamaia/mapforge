import { defineConfig, devices } from '@playwright/test';

const PORT = 4321;

/** Os testes rodam contra o build de produção, servido localmente, sem serviços externos. */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 3,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1500, height: 950 },
    baseURL: `http://127.0.0.1:${PORT}`,
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  },
  webServer: {
    command: `node tests/e2e/serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
  },
});
