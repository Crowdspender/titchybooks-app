import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runDrain, isCronAuthorized, drainBudgetMs, type DrainSummary } from '../../src/lib/queue-drain';

const ORIGINAL_ENV = { ...process.env };

// Shared assertions for the counters plus the run framing fields added for
// drain-run metrics: timestamps must be coherent and duration derived from them.
function expectCounts(
  summary: DrainSummary,
  expected: { claimed: number; finished: number; yielded: number },
) {
  expect(summary).toMatchObject(expected);
  expect(summary.errored).toBe(false);
  expect(summary.finishedAt.getTime()).toBeGreaterThanOrEqual(summary.startedAt.getTime());
  expect(summary.durationMs).toBe(summary.finishedAt.getTime() - summary.startedAt.getTime());
}

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
    expectCounts(summary, { claimed: 2, finished: 2, yielded: 0 });
    expect(processed).toEqual(['a', 'b']);
  });

  it('reports nothing when there is no due work', async () => {
    const summary = await runDrain(async () => null, async () => {}, 5_000);
    expectCounts(summary, { claimed: 0, finished: 0, yielded: 0 });
  });

  it('stops safely when claim throws (transient DB error)', async () => {
    const summary = await runDrain(
      async () => { throw new Error('db down'); },
      async () => {},
      5_000,
    );
    // A claim failure is surfaced instead of looking like an empty queue.
    expect(summary).toMatchObject({ claimed: 0, finished: 0, yielded: 0, errored: true });
  });

  it('yields the in-flight job when the budget is exhausted', async () => {
    let started = false;
    const summary = await runDrain(
      async () => (started ? null : ((started = true), { id: 'slow' })),
      // Never resolves within the tiny budget; simulates a long stage.
      () => new Promise((resolve) => setTimeout(resolve, 1_000)),
      50,
    );
    expectCounts(summary, { claimed: 1, finished: 0, yielded: 1 });
  });

  it('treats a rejecting processor as settled (processors mark FAILED themselves)', async () => {
    const jobs = [{ id: 'a' }];
    const summary = await runDrain(
      async () => jobs.shift() ?? null,
      async () => { throw new Error('stage failed'); },
      5_000,
    );
    expectCounts(summary, { claimed: 1, finished: 1, yielded: 0 });
  });

  it('passes the drain deadline to the processor', async () => {
    const before = Date.now();
    let seenDeadline = 0;
    const jobs = [{ id: 'a' }];
    await runDrain(
      async () => jobs.shift() ?? null,
      async (_job, deadlineMs) => { seenDeadline = deadlineMs; },
      5_000,
    );
    // Deadline is the wall-clock budget horizon; claim latency can eat into it,
    // so allow slack either side of the nominal before + budget horizon.
    expect(seenDeadline).toBeGreaterThan(before);
    expect(seenDeadline - before).toBeLessThan(6_000);
  });

  it('stops and counts yielded when the processor voluntarily yields', async () => {
    const jobs = [{ id: 'a' }, { id: 'b' }];
    const processed: string[] = [];
    const summary = await runDrain(
      async () => jobs.shift() ?? null,
      async (job) => {
        processed.push(job.id);
        return job.id === 'a' ? 'yielded' : undefined;
      },
      5_000,
    );
    // The yielded job is left for a later drain; the next job is not claimed.
    expectCounts(summary, { claimed: 1, finished: 0, yielded: 1 });
    expect(processed).toEqual(['a']);
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
