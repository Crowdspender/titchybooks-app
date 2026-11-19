import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { applyTestEnvironment, offlineTestEnvironment } from './scripts/test-environment.mts';

applyTestEnvironment(offlineTestEnvironment());

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['./scripts/test-network-guard.mjs'],
    clearMocks: true,
    restoreMocks: true,
  },
});
