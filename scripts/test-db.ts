// Load .env before testEnvironment() reads TEST_DATABASE_URL: this script runs
// under tsx, which (unlike Next.js and the Prisma CLI) does not read .env on its
// own, so the documented `npm run test:*` commands would otherwise fail with
// "Set TEST_DATABASE_URL explicitly" even when .env defines it. dotenv never
// overrides a variable that is already set, so CI's real environment still wins.
//
// Loaded here rather than in test-environment.mts on purpose: that module is
// also imported directly by the unit suite, and pulling a developer's real
// credentials into unit tests would make them depend on local secrets.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { offlineTestEnvironment, testEnvironment } from './test-environment.mts';
import { SYNTHETIC_SHIPPING_POLICY } from '../tests/fixtures/pricing';

const action = process.argv[2];
const baseEnv = ['unit', 'pricing', 'design', 'design-server', 'generate'].includes(action)
  ? offlineTestEnvironment() : testEnvironment();
const env: Record<string, string> & { NODE_ENV: 'production' | 'test' } = {
  ...baseEnv, NODE_ENV: ['build', 'server', 'server-quotes'].includes(action) ? 'production' : 'test',
};
if (action === 'server-quotes') {
  // Explicit synthetic policy only after local test-database validation above.
  // Never read inherited/developer policy values or enable real carrier coverage.
  env.ORDER_SHIPPING_POLICY_JSON = JSON.stringify(SYNTHETIC_SHIPPING_POLICY);
}
function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (action === 'unit') {
  run('node_modules/vitest/vitest.mjs', ['run', ...process.argv.slice(3)]);
} else if (action === 'pricing') {
  run('node_modules/tsx/dist/cli.mjs', ['src/lib/pricing/__tests__/engine.test.ts']);
} else if (action === 'design') {
  run('node_modules/@playwright/test/cli.js', ['test', '--config', 'playwright.design.config.ts', ...process.argv.slice(3)]);
} else if (action === 'design-server') {
  run('node_modules/tsx/dist/cli.mjs', ['scripts/design-browser-server.mts']);
} else if (action === 'migrate') {
  run('node_modules/prisma/build/index.js', ['migrate', 'deploy']);
  run('node_modules/prisma/build/index.js', ['migrate', 'diff', '--from-url', env.DATABASE_URL,
    '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
} else if (action === 'schema-audit') {
  run('node_modules/prisma/build/index.js', ['validate']);
  run('node_modules/prisma/build/index.js', ['migrate', 'status']);
  run('node_modules/prisma/build/index.js', ['migrate', 'diff', '--from-url', env.DATABASE_URL,
    '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
} else if (action === 'integration') {
  run('node_modules/vitest/vitest.mjs', ['run', '--config', 'vitest.integration.config.mts', ...process.argv.slice(3)]);
} else if (action === 'browser') {
  run('node_modules/@playwright/test/cli.js', ['test', ...process.argv.slice(3)]);
} else if (action === 'restore') {
  run('node_modules/tsx/dist/cli.mjs', ['scripts/test-restore.mts']);
} else if (action === 'payment-evidence') {
  run('node_modules/tsx/dist/cli.mjs', ['tests/fixtures/payment-browser-evidence.mts', ...process.argv.slice(3)]);
} else if (action === 'generate') {
  run('node_modules/prisma/build/index.js', ['generate']);
} else if (action === 'build') {
  run('node_modules/prisma/build/index.js', ['generate']);
  run('node_modules/next/dist/bin/next', ['build']);
} else if (action === 'server' || action === 'server-quotes') {
  run('node_modules/next/dist/bin/next', ['start', '-p', '3100']);
} else {
  throw new Error('Expected unit, pricing, design, design-server, migrate, schema-audit, integration, browser, restore, payment-evidence, generate, build, server, or server-quotes');
}
