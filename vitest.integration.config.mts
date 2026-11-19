import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { applyTestEnvironment, testEnvironment } from './scripts/test-environment.mts';

applyTestEnvironment(testEnvironment());
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./scripts/test-network-guard.mjs'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
    clearMocks: true,
    restoreMocks: true,
  },
});
