import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../fixtures/database';
import { consumeRateLimit } from '@/lib/rate-limit';

/**
 * Exercises the durable fixed-window limiter against the real Postgres
 * instance used by the integration suite (single atomic UPSERT path).
 */
const KEY_PREFIX = 'itest:rate-limit';

describe('durable rate limiting (RateLimitBucket)', () => {
  beforeAll(async () => {
    await db.rateLimitBucket.deleteMany({ where: { bucketKey: { startsWith: KEY_PREFIX } } });
  });

  afterAll(async () => {
    await db.rateLimitBucket.deleteMany({ where: { bucketKey: { startsWith: KEY_PREFIX } } });
    await db.$disconnect();
  });

  it('allows up to the limit, then blocks with a bounded retry window', async () => {
    const key = `${KEY_PREFIX}:cap:${Date.now()}`;
    const spec = { limit: 2, windowMs: 60_000 };

    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);
    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);

    const blocked = await consumeRateLimit(key, spec);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('reopens the window after it expires', async () => {
    const key = `${KEY_PREFIX}:reset:${Date.now()}`;
    // Generous window: a tight (millisecond-scale) window flakes whenever DB
    // latency outruns the deadline under parallel suite load.
    const spec = { limit: 1, windowMs: 500 };

    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);
    // Immediately follow up so the window cannot lapse between calls.
    expect((await consumeRateLimit(key, spec)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);
  });

  it('keeps buckets independent per key', async () => {
    const stamp = Date.now();
    const spec = { limit: 1, windowMs: 60_000 };

    expect((await consumeRateLimit(`${KEY_PREFIX}:a:${stamp}`, spec)).allowed).toBe(true);
    expect((await consumeRateLimit(`${KEY_PREFIX}:a:${stamp}`, spec)).allowed).toBe(false);
    expect((await consumeRateLimit(`${KEY_PREFIX}:b:${stamp}`, spec)).allowed).toBe(true);
  });

  it('is atomic under concurrent consumers', async () => {
    const key = `${KEY_PREFIX}:race:${Date.now()}`;
    const spec = { limit: 5, windowMs: 60_000 };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateLimit(key, spec)),
    );
    const allowed = results.filter((r) => r.allowed).length;
    // The UPSERT increments atomically: exactly `limit` requests pass.
    expect(allowed).toBe(5);
  });
});
