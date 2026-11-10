import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupFixtures, createDraft, createUser, db } from '../fixtures/database';
import { enqueueRenderJob } from '@/lib/pdf/render-job';
import { prisma } from '@/lib/prisma';
import { collectQueueHealth, recordDrainRun } from '@/lib/queue-health';
import { GET as queueHealth } from '@/app/api/queue/health/route';

/**
 * Queue operability against real Postgres: drain-run persistence (the
 * scheduler heartbeat), queue-depth/failure snapshots, and the status codes
 * the monitoring workflow depends on.
 */
const SECRET = 'integration-cron-secret';

function healthRequest(token: string | null = SECRET) {
  return new Request('http://localhost/api/queue/health', {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

async function insertRun(queue: 'ai' | 'render', startedAt: Date, errored = false) {
  await db.queueDrainRun.create({
    data: {
      queue,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 500),
      durationMs: 500,
      claimed: 1,
      finished: 1,
      yielded: 0,
      errored,
    },
  });
}

beforeEach(async () => {
  await db.queueDrainRun.deleteMany();
  vi.stubEnv('CRON_SECRET', SECRET);
  // Other integration files may leave due jobs in tight windows; the policy
  // itself is unit-tested, so keep this file focused on wiring and statuses.
  vi.stubEnv('QUEUE_BACKLOG_ALERT_MS', String(24 * 60 * 60 * 1000));
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  await cleanupFixtures();
  await db.queueDrainRun.deleteMany();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
  await db.$disconnect();
});

describe('queue operability', () => {
  it('persists each drain run as the scheduler heartbeat', async () => {
    const startedAt = new Date(Date.now() - 1_500);
    await recordDrainRun('render', {
      claimed: 2,
      finished: 1,
      yielded: 1,
      errored: false,
      startedAt,
      finishedAt: new Date(),
      durationMs: 1_500,
    });

    const runs = await db.queueDrainRun.findMany({ where: { queue: 'render' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      queue: 'render',
      claimed: 2,
      finished: 1,
      yielded: 1,
      errored: false,
      durationMs: 1_500,
    });
  });

  it('reports queue depth and recent terminal failures', async () => {
    const user = await createUser();
    const draft = await createDraft(user.id);
    const { jobId } = await enqueueRenderJob(draft.id, user);
    // Terminal failure, as failRender leaves it once attempts are exhausted.
    await db.renderJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        attempts: 3,
        errorMessage: 'render blew up',
        completedAt: new Date(),
      },
    });
    await insertRun('ai', new Date());
    await insertRun('render', new Date());

    const report = await collectQueueHealth();
    const render = report.queues.find((queue) => queue.queue === 'render');
    const ai = report.queues.find((queue) => queue.queue === 'ai');
    expect(render).toBeDefined();
    expect(ai).toBeDefined();
    expect(render!.failed).toBeGreaterThanOrEqual(1);
    expect(render!.failedRecent).toBeGreaterThanOrEqual(1);
    expect(render!.lastRun).not.toBeNull();
    expect(render!.lastRunAgeMs).toBeLessThan(60_000);
    // A fresh run is enough to keep the idle AI queue healthy.
    expect(ai!.due).toBe(0);
    expect(ai!.healthy).toBe(true);
    expect(report.checkedAt).toBeTruthy();
  });

  it('serves the report to the scheduler and rejects other callers', async () => {
    await insertRun('ai', new Date());
    await insertRun('render', new Date());

    expect((await queueHealth(healthRequest('wrong-secret'))).status).toBe(401);
    expect((await queueHealth(healthRequest(null))).status).toBe(401);

    const res = await queueHealth(healthRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(true);
    expect(body.queues).toHaveLength(2);
  });

  it('fails closed when CRON_SECRET is not configured', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await queueHealth(healthRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured/i);
  });

  it('returns 503 when the scheduler is stale or the last run errored', async () => {
    vi.stubEnv('QUEUE_STALE_DRAIN_MS', '60000');
    await insertRun('ai', new Date(Date.now() - 120_000), true);
    await insertRun('render', new Date());

    const res = await queueHealth(healthRequest());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.healthy).toBe(false);
    const ai = body.queues.find((queue: { queue: string }) => queue.queue === 'ai');
    expect(ai.reasons).toEqual(expect.arrayContaining(['drain-stalled', 'last-run-error']));
  });
});
