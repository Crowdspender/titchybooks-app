// All database test entry points must call this before importing application code.
export function testEnvironment() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("Set TEST_DATABASE_URL explicitly; application DATABASE_URL is never used for tests.");
  const url = new URL(raw);
  if (!['postgresql:', 'postgres:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/^\/[a-z0-9_]*test[a-z0-9_]*$/i.test(url.pathname) || url.searchParams.has('host')) {
    throw new Error("Tests require a local PostgreSQL database with 'test' in its name.");
  }
  return {
    ...process.env,
    DATABASE_URL: raw,
    TEST_DATABASE_URL: raw,
    AUTH_SECRET: 'isolated-test-auth-secret-not-for-production',
    AUTH_TRUST_HOST: 'true',
    AUTH_URL: 'http://localhost:3100',
    NEXTAUTH_URL: 'http://localhost:3100',
    VECTOR_RENDER: 'false',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test-only',
    AWS_SECRET_ACCESS_KEY: 'test-only',
    S3_BUCKET_NAME: 'test-only',
    OPENAI_API_KEY: 'test-only',
    RESEND_API_KEY: 're_test_only',
  };
}
