import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/design-browser',
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: [['list']],
  outputDir: 'test-results/design',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3200', viewport: { width: 1800, height: 1200 }, headless: Boolean(process.env.CI), trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npx tsx scripts/design-browser-server.mts', url: 'http://127.0.0.1:3200/tests/browser-fixtures/design.html', reuseExistingServer: !process.env.CI, timeout: 60000 },
});
