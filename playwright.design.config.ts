import { defineConfig, devices } from '@playwright/test';
import { applyTestEnvironment, offlineTestEnvironment } from './scripts/test-environment.mts';

const env = offlineTestEnvironment();
applyTestEnvironment(env);

export default defineConfig({
  testDir: './tests/design-browser',
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/design/results.json' }]],
  outputDir: 'test-results/design',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3200', viewport: { width: 1800, height: 1200 }, headless: Boolean(process.env.CI), launchOptions: { ignoreDefaultArgs: ['--disable-popup-blocking'] }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node node_modules/tsx/dist/cli.mjs scripts/test-db.ts design-server', url: 'http://127.0.0.1:3200/tests/browser-fixtures/design.html', reuseExistingServer: false, timeout: 60000, env },
});
