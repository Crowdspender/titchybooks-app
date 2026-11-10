import { describe, it, expect } from 'vitest';
import { validateRuntimeEnv, assertProductionEnv } from '../../src/lib/env-validation';

/** A minimal environment that passes all checks. */
function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:pass@host:5432/db',
    NEXTAUTH_SECRET: 'a-long-enough-random-secret',
    CRON_SECRET: 'a-long-enough-random-cron-secret',
    AWS_REGION: 'eu-west-1',
    AWS_ACCESS_KEY_ID: 'AKIATESTER',
    AWS_SECRET_ACCESS_KEY: 'secret',
    S3_BUCKET_NAME: 'titchybook-uploads',
    OPENAI_API_KEY: 'sk-test',
    RESEND_API_KEY: 're-test',
    ...overrides,
  };
}

describe('validateRuntimeEnv', () => {
  it('accepts a complete production environment', () => {
    const { errors } = validateRuntimeEnv(validEnv());
    expect(errors).toEqual([]);
  });

  it('reports every missing required variable at once (fail fast, no first-hit-only)', () => {
    const { errors } = validateRuntimeEnv({
      NODE_ENV: 'production',
      NEXTAUTH_SECRET: 'a-long-enough-random-secret',
      CRON_SECRET: 'a-long-enough-random-cron-secret',
    });
    expect(errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
    expect(errors.some((e) => e.includes('S3_BUCKET_NAME'))).toBe(true);
  });

  it('rejects placeholder secrets', () => {
    const { errors } = validateRuntimeEnv(
      validEnv({ CRON_SECRET: 'change-me-to-a-random-secret', NEXTAUTH_SECRET: 'short' }),
    );
    expect(errors.some((e) => e.includes('CRON_SECRET'))).toBe(true);
    expect(errors.some((e) => e.includes('Session secret'))).toBe(true);
  });

  it('enforces the lease >= 2x heartbeat invariant', () => {
    const { errors } = validateRuntimeEnv(validEnv({ AI_BOOK_LEASE_MS: '60000', AI_HEARTBEAT_MS: '60000' }));
    expect(errors.some((e) => e.includes('twice AI_HEARTBEAT_MS'))).toBe(true);
  });

  it('enforces the lease > drain budget invariant', () => {
    const { errors } = validateRuntimeEnv(validEnv({ AI_BOOK_LEASE_MS: '40000', DRAIN_BUDGET_MS: '45000' }));
    expect(errors.some((e) => e.includes('exceed DRAIN_BUDGET_MS'))).toBe(true);
  });

  it('bounds DRAIN_BUDGET_MS to the 60s function limit', () => {
    const { errors } = validateRuntimeEnv(validEnv({ DRAIN_BUDGET_MS: '120000' }));
    expect(errors.some((e) => e.includes('DRAIN_BUDGET_MS'))).toBe(true);
  });

  it('rejects non-numeric and out-of-range lease values', () => {
    expect(validateRuntimeEnv(validEnv({ AI_BOOK_LEASE_MS: 'abc' })).errors.some((e) => e.includes('AI_BOOK_LEASE_MS'))).toBe(true);
    expect(validateRuntimeEnv(validEnv({ AI_BOOK_LEASE_MS: '3600000' })).errors.some((e) => e.includes('AI_BOOK_LEASE_MS'))).toBe(true);
  });

  it('warns (not errors) about optional AI and email features', () => {
    const { errors, warnings } = validateRuntimeEnv(validEnv({ OPENAI_API_KEY: undefined, RESEND_API_KEY: undefined }));
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('OPENAI_API_KEY'))).toBe(true);
    expect(warnings.some((w) => w.includes('RESEND_API_KEY'))).toBe(true);
    // Stripe unset must also be a warning only: manual admin mark-PAID still works.
    expect(warnings.some((w) => w.includes('Stripe'))).toBe(true);
  });
});

describe('assertProductionEnv', () => {
  it('throws in production when errors exist', () => {
    expect(() => assertProductionEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /Invalid production configuration/,
    );
  });

  it('does not throw outside production even with errors', () => {
    expect(() => assertProductionEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('passes with a valid production environment', () => {
    expect(() => assertProductionEnv(validEnv() as NodeJS.ProcessEnv)).not.toThrow();
  });
});
