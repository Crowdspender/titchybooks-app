import { defineConfig, devices } from '@playwright/test';
import { testEnvironment } from './scripts/test-environment.mts';

const env = testEnvironment();
Object.assign(process.env, env);
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
  webServer: {
    command: 'node node_modules/tsx/dist/cli.mjs scripts/test-db.ts server',
    url: 'http://localhost:3100/login',
    reuseExistingServer: false,
    timeout: 120000,
    env,
  },
});
