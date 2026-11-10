import { afterEach, describe, expect, it, vi } from 'vitest';

// The assessment is pure; keep Prisma out of the unit environment entirely.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  assessQueueHealth,
  backlogAlertMs,
  drainStaleMs,
  type QueueHealthInput,
} from '@/lib/queue-health';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const THRESHOLDS = { staleAfterMs: 15 * 60_000, backlogAfterMs: 30 * 60_000 };

function run(startedAt: Date, errored = false) {
  return {
    id: 'run-1',
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1_200),
    durationMs: 1_200,
    claimed: 3,
    finished: 2,
    yielded: 1,
    errored,
  };
}

function input(overrides: Partial<QueueHealthInput> = {}): QueueHealthInput {
  return {
    queue: 'ai',
    due: 0,
    processing: 0,
    failed: 0,
    failedRecent: 0,
    oldestDueAt: null,
    lastRun: run(new Date(NOW - 60_000)),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assessQueueHealth', () => {
  it('is healthy with a fresh successful run and no runnable work', () => {
    const health = assessQueueHealth(input(), NOW, THRESHOLDS);
    expect(health.healthy).toBe(true);
    expect(health.reasons).toEqual([]);
    expect(health.lastRunAgeMs).toBe(60_000);
  });

  it('flags a queue whose drain has never run', () => {
    const health = assessQueueHealth(input({ lastRun: null }), NOW, THRESHOLDS);
    expect(health.healthy).toBe(false);
    expect(health.reasons).toContain('drain-never-ran');
    expect(health.lastRun).toBeNull();
    expect(health.lastRunAgeMs).toBeNull();
  });

  it('flags a stalled scheduler once the last run exceeds the threshold', () => {
    const stale = assessQueueHealth(
      input({ lastRun: run(new Date(NOW - THRESHOLDS.staleAfterMs - 1)) }),
      NOW,
      THRESHOLDS,
    );
    expect(stale.reasons).toContain('drain-stalled');

    const fresh = assessQueueHealth(
      input({ lastRun: run(new Date(NOW - THRESHOLDS.staleAfterMs)) }),
      NOW,
      THRESHOLDS,
    );
    expect(fresh.healthy).toBe(true);
  });

  it('flags a backlog only when the oldest due job exceeds the threshold', () => {
    const backlogged = assessQueueHealth(
      input({
        due: 4,
        oldestDueAt: new Date(NOW - THRESHOLDS.backlogAfterMs - 1),
      }),
      NOW,
      THRESHOLDS,
    );
    expect(backlogged.reasons).toEqual(['due-backlog']);
    expect(backlogged.oldestDueAgeMs).toBe(THRESHOLDS.backlogAfterMs + 1);

    const justDue = assessQueueHealth(
      input({ due: 4, oldestDueAt: new Date(NOW - 1_000) }),
      NOW,
      THRESHOLDS,
    );
    expect(justDue.healthy).toBe(true);
  });

  it('flags a drain run that stopped on a database error', () => {
    const health = assessQueueHealth(
      input({ lastRun: run(new Date(NOW - 60_000), true) }),
      NOW,
      THRESHOLDS,
    );
    expect(health.reasons).toEqual(['last-run-error']);
    expect(health.lastRun?.errored).toBe(true);
  });

  it('serializes run timestamps as ISO strings for the JSON endpoints', () => {
    const health = assessQueueHealth(input(), NOW, THRESHOLDS);
    expect(health.lastRun?.startedAt).toBe('2026-10-21T11:59:00.000Z');
    expect(health.lastRun?.queue).toBe('ai');
  });
});

describe('health thresholds', () => {
  it('defaults to two missed 5-minute drains and a 30-minute backlog', () => {
    expect(drainStaleMs()).toBe(15 * 60_000);
    expect(backlogAlertMs()).toBe(30 * 60_000);
  });

  it('accepts configured values above the minimum', () => {
    vi.stubEnv('QUEUE_STALE_DRAIN_MS', '120000');
    vi.stubEnv('QUEUE_BACKLOG_ALERT_MS', '3600000');
    expect(drainStaleMs()).toBe(120_000);
    expect(backlogAlertMs()).toBe(3_600_000);
  });

  it('falls back for values below the minimum or non-numeric input', () => {
    vi.stubEnv('QUEUE_STALE_DRAIN_MS', '10');
    vi.stubEnv('QUEUE_BACKLOG_ALERT_MS', 'not-a-number');
    expect(drainStaleMs()).toBe(15 * 60_000);
    expect(backlogAlertMs()).toBe(30 * 60_000);
  });
});
