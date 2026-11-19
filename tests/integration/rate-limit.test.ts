import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, createUser, cleanupFixtures, trackFixtureRateLimit } from '../fixtures/database';
import { consumeRateLimit, peekRateLimit, releaseRateLimit } from '@/lib/rate-limit';

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

  it('cleans exact fixture-owned user/email/IP buckets and preserves unrelated buckets', async () => {
    const user = await createUser();
    const unrelated = `${KEY_PREFIX}:preserved:${Date.now()}`;
    const owned = [`submission:user:${user.id}`, `login:${user.email}`, `forgot:email:${user.email}`,
      trackFixtureRateLimit(`reset:ip:192.0.2.166`)];
    try {
      for (const key of [...owned, unrelated]) await consumeRateLimit(key, { limit: 2, windowMs: 60000 });
      await cleanupFixtures();
      expect(await db.rateLimitBucket.count({ where: { bucketKey: { in: owned } } })).toBe(0);
      expect(await db.rateLimitBucket.count({ where: { bucketKey: unrelated } })).toBe(1);
      expect(await db.user.findUnique({ where: { id: user.id } })).toBeNull();
    } finally { await cleanupFixtures(); }
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

  it('peek predicts the next consume without spending budget', async () => {
    const key = `${KEY_PREFIX}:peek:${Date.now()}`;
    const spec = { limit: 2, windowMs: 60_000 };

    expect((await peekRateLimit(key, spec)).allowed).toBe(true);
    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);
    expect((await peekRateLimit(key, spec)).allowed).toBe(true);
    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);
    // At the cap the next consume would block, and peeking must not change
    // that state no matter how often it is called.
    expect((await peekRateLimit(key, spec)).allowed).toBe(false);
    expect((await peekRateLimit(key, spec)).allowed).toBe(false);
    expect((await consumeRateLimit(key, spec)).allowed).toBe(false);
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

  it('release refunds a reservation so only failures count toward the limit', async () => {
    const key = `${KEY_PREFIX}:release:${Date.now()}`;
    const spec = { limit: 2, windowMs: 60_000 };

    // A failed attempt keeps its slot.
    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);
    // A successful attempt reserves then refunds, spending no budget.
    const success = await consumeRateLimit(key, spec);
    expect(success.allowed).toBe(true);
    await releaseRateLimit(key, success.windowExpiresAt);
    // Another failure fills the window...
    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);
    // ...and the next admission is denied even though a success passed through.
    expect((await consumeRateLimit(key, spec)).allowed).toBe(false);
  });

  it('release floors at zero so refunds cannot corrupt the count', async () => {
    const key = `${KEY_PREFIX}:release-floor:${Date.now()}`;
    const spec = { limit: 2, windowMs: 60_000 };

    // Refunding a bucket that does not exist is a harmless no-op.
    await releaseRateLimit(key, new Date(Date.now() + 60_000));
    const first = await consumeRateLimit(key, spec);
    expect(first.allowed).toBe(true);
    await releaseRateLimit(key, first.windowExpiresAt);
    await releaseRateLimit(key, first.windowExpiresAt); // would go negative without the GREATEST floor
    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);
    expect((await consumeRateLimit(key, spec)).allowed).toBe(true);
    expect((await consumeRateLimit(key, spec)).allowed).toBe(false);
  });

  it('release bound to an expired window cannot decrement its replacement', async () => {
    const key = `${KEY_PREFIX}:release-window:${Date.now()}`;
    const spec = { limit: 1, windowMs: 500 };

    const stale = await consumeRateLimit(key, spec);
    expect(stale.allowed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    // A new request resets the bucket into a replacement window.
    const fresh = await consumeRateLimit(key, spec);
    expect(fresh.allowed).toBe(true);
    expect(fresh.windowExpiresAt.getTime()).not.toBe(stale.windowExpiresAt.getTime());
    // The late refund from the old window must be a no-op, not steal the
    // replacement window's only slot.
    await releaseRateLimit(key, stale.windowExpiresAt);
    expect((await consumeRateLimit(key, spec)).allowed).toBe(false);
  });
});
