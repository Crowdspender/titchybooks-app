import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runDrain, isCronAuthorized, drainBudgetMs } from '../../src/lib/queue-drain';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('runDrain', () => {
  it('processes a job then stops when no work remains', async () => {
    const jobs = [{ id: 'a' }, { id: 'b' }];
    const processed: string[] = [];
    const summary = await runDrain(
      async () => jobs.shift() ?? null,
      async (job) => { processed.push(job.id); },
      5_000,
    );
    expect(summary).toEqual({ claimed: 2, finished: 2, yielded: 0 });
    expect(processed).toEqual(['a', 'b']);
  });

  it('reports nothing when there is no due work', async () => {
    const summary = await runDrain(async () => null, async () => {}, 5_000);
    expect(summary).toEqual({ claimed: 0, finished: 0, yielded: 0 });
  });

  it('stops safely when claim throws (transient DB error)', async () => {
    const summary = await runDrain(
      async () => { throw new Error('db down'); },
      async () => {},
      5_000,
    );
    expect(summary).toEqual({ claimed: 0, finished: 0, yielded: 0 });
  });

  it('yields the in-flight job when the budget is exhausted', async () => {
    let started = false;
    const summary = await runDrain(
      async () => (started ? null : ((started = true), { id: 'slow' })),
      // Never resolves within the tiny budget; simulates a long stage.
      () => new Promise((resolve) => setTimeout(resolve, 1_000)),
      50,
    );
    expect(summary).toEqual({ claimed: 1, finished: 0, yielded: 1 });
  });

  it('treats a rejecting processor as settled (processors mark FAILED themselves)', async () => {
    const jobs = [{ id: 'a' }];
    const summary = await runDrain(
      async () => jobs.shift() ?? null,
      async () => { throw new Error('stage failed'); },
      5_000,
    );
    expect(summary).toEqual({ claimed: 1, finished: 1, yielded: 0 });
  });
});

describe('isCronAuthorized', () => {
  beforeEach(() => { delete process.env.CRON_SECRET; });

  it('refuses when CRON_SECRET is not configured', () => {
    const req = new Request('http://x/api/ai/drain', { headers: { authorization: 'Bearer anything' } });
    expect(isCronAuthorized(req)).toBe(false);
  });

  it('accepts a matching Bearer token', () => {
    process.env.CRON_SECRET = 's3cret';
    const req = new Request('http://x/api/ai/drain', { headers: { authorization: 'Bearer s3cret' } });
    expect(isCronAuthorized(req)).toBe(true);
  });

  it('rejects a wrong or missing token', () => {
    process.env.CRON_SECRET = 's3cret';
    expect(isCronAuthorized(new Request('http://x', { headers: { authorization: 'Bearer nope' } }))).toBe(false);
    expect(isCronAuthorized(new Request('http://x'))).toBe(false);
  });
});

describe('drainBudgetMs', () => {
  beforeEach(() => { delete process.env.DRAIN_BUDGET_MS; });

  it('defaults to 45s', () => {
    expect(drainBudgetMs()).toBe(45_000);
  });

  it('honours a valid configured value', () => {
    process.env.DRAIN_BUDGET_MS = '30000';
    expect(drainBudgetMs()).toBe(30_000);
  });

  it('falls back to default for out-of-range or invalid values', () => {
    process.env.DRAIN_BUDGET_MS = '10'; // below 5s floor
    expect(drainBudgetMs()).toBe(45_000);
    process.env.DRAIN_BUDGET_MS = 'not-a-number';
    expect(drainBudgetMs()).toBe(45_000);
  });
});
