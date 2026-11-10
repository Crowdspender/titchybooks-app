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
import { testEnvironment } from './test-environment.mts';

const env = testEnvironment();
function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const action = process.argv[2];
if (action === 'migrate') {
  run('node_modules/prisma/build/index.js', ['migrate', 'deploy']);
  run('node_modules/prisma/build/index.js', ['migrate', 'diff', '--from-url', env.DATABASE_URL,
    '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code']);
} else if (action === 'integration') {
  run('node_modules/vitest/vitest.mjs', ['run', '--config', 'vitest.integration.config.mts']);
} else if (action === 'browser') {
  run('node_modules/@playwright/test/cli.js', ['test']);
} else if (action === 'build') {
  run('node_modules/prisma/build/index.js', ['generate']);
  run('node_modules/next/dist/bin/next', ['build']);
} else if (action === 'server') {
  run('node_modules/next/dist/bin/next', ['start', '-p', '3100']);
} else {
  throw new Error('Expected migrate, integration, browser, build, or server');
}
