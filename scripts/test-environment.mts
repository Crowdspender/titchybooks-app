import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Keep OS/process-launch necessities, not developer/provider credentials.
const inheritedNames = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'PROGRAMFILES', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'CI', 'TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR', 'NODE_ENV',
];
// Runners execute from the workspace root, including Playwright's CJS loader.
const networkGuard = pathToFileURL(resolve('scripts/test-network-guard.mjs'));

export function offlineTestEnvironment(): Record<string, string> & { NODE_ENV: 'test' } {
  const env: Record<string, string> = {};
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    NODE_ENV: 'test',
    // Never use a developer database in database-free suites.
    DATABASE_URL: 'postgresql://127.0.0.1:1/isolated_unit_test',
    TEST_DATABASE_URL: '',
    // Also prevents dotenv/Next from filling these from .env files.
    DIRECT_URL: '', SHADOW_DATABASE_URL: '',
    NEXTAUTH_SECRET: '', AUTH_SECRET_1: '', AUTH_SECRET_2: '', AUTH_SECRET_3: '',
    AUTH_SECRET: 'isolated-test-auth-secret-not-for-production',
    AUTH_TRUST_HOST: 'true',
    AUTH_URL: 'http://localhost:3100',
    NEXTAUTH_URL: 'http://localhost:3100',
    CRON_SECRET: 'isolated-test-cron-secret-not-for-production',
    VECTOR_RENDER: 'false',
    AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test-only', AWS_SECRET_ACCESS_KEY: 'test-only',
    AWS_SESSION_TOKEN: '', AWS_PROFILE: '',
    AWS_SHARED_CREDENTIALS_FILE: resolve('scripts/no-test-credentials'),
    AWS_CONFIG_FILE: resolve('scripts/no-test-config'),
    AWS_EC2_METADATA_DISABLED: 'true',
    S3_BUCKET_NAME: 'test-only',
    OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'test-model',
    RESEND_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
    ORDER_SHIPPING_POLICY_JSON: '',
    EMAIL_FROM: 'fixture@example.invalid', CONTACT_INBOX_EMAIL: 'fixture@example.invalid',
    ADMIN_EMAIL: '', ADMIN_PASSWORD: '', TEST_EMAIL: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*',
    NEXT_TELEMETRY_DISABLED: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1',
    PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: '0',
    // Replaces inherited loaders; inherited children/workers get the guard too.
    NODE_OPTIONS: `--import="${networkGuard.href}"`,
  };
}

export function applyTestEnvironment(env: Record<string, string | undefined>) {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
}

// All database test entry points must call this before importing application code.
export function testEnvironment(): ReturnType<typeof offlineTestEnvironment> {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("Set TEST_DATABASE_URL explicitly; application DATABASE_URL is never used for tests.");
  const url = new URL(raw);
  if (!['postgresql:', 'postgres:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^\/[a-z0-9_]*test[a-z0-9_]*$/i.test(url.pathname) ||
      [...url.searchParams.keys()].some(name =>
        !['schema', 'sslmode', 'connection_limit', 'pool_timeout', 'connect_timeout', 'pgbouncer'].includes(name))) {
    throw new Error("Tests require a local PostgreSQL database with 'test' in its name.");
  }
  return {
    ...offlineTestEnvironment(),
    DATABASE_URL: raw,
    TEST_DATABASE_URL: raw,
  };
}
