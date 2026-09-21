import { afterEach, expect, it, vi } from 'vitest';
import { testEnvironment } from '../../scripts/test-environment.mts';

afterEach(() => vi.unstubAllEnvs());
it('never falls back to the application DATABASE_URL', () => {
  vi.stubEnv('TEST_DATABASE_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://localhost/application');
  expect(() => testEnvironment()).toThrow('explicitly');
});
it.each([
  'postgresql://remote.example/test',
  'postgresql://localhost/application',
  'postgresql://localhost/app_test?host=remote.example',
  'https://localhost/app_test',
])('rejects unsafe test target %s', url => {
  vi.stubEnv('TEST_DATABASE_URL', url);
  expect(() => testEnvironment()).toThrow();
});
it('overrides provider credentials and the database with test-only values', () => {
  vi.stubEnv('TEST_DATABASE_URL', 'postgresql://localhost/app_test');
  const env = testEnvironment();
  expect(env.DATABASE_URL).toBe('postgresql://localhost/app_test');
  expect(env.AWS_ACCESS_KEY_ID).toBe('test-only');
  expect(env.OPENAI_API_KEY).toBe('test-only');
});
