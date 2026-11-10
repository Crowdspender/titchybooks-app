// Queue operability: persist one record per drain invocation and derive a
// health report from queue depth, failure counts, and scheduler freshness.
// The drain endpoints are invoked by .github/workflows/drain.yml every five
// minutes; the health endpoint lets an external monitor (or the workflow
// itself) fail loudly when the scheduler stops or work backs up.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { DrainSummary } from "@/lib/queue-drain";

export type QueueName = "ai" | "render";

/** Terminal failures counted as "recent" in the health report and admin view. */
export const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Drain-run history retained for throughput inspection. */
export const DRAIN_RUN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export type QueueHealthReason =
  | "drain-never-ran"
  | "drain-stalled"
  | "due-backlog"
  | "last-run-error";

export interface DrainRunView {
  id: string;
  queue: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  claimed: number;
  finished: number;
  yielded: number;
  errored: boolean;
}

export interface QueueHealthInput {
  queue: QueueName;
  /** Runnable now: QUEUED past nextAttemptAt, or PROCESSING with an expired lease. */
  due: number;
  processing: number;
  failed: number;
  failedRecent: number;
  /** Oldest row among the due work, used to age the backlog. */
  oldestDueAt: Date | null;
  lastRun: {
    id: string;
    startedAt: Date;
    finishedAt: Date;
    durationMs: number;
    claimed: number;
    finished: number;
    yielded: number;
    errored: boolean;
  } | null;
}

export interface QueueHealth {
  queue: QueueName;
  due: number;
  processing: number;
  failed: number;
  failedRecent: number;
  oldestDueAt: string | null;
  oldestDueAgeMs: number | null;
  lastRun: DrainRunView | null;
  lastRunAgeMs: number | null;
  healthy: boolean;
  reasons: QueueHealthReason[];
}

export interface QueueHealthReport {
  healthy: boolean;
  checkedAt: string;
  staleAfterMs: number;
  backlogAfterMs: number;
  queues: QueueHealth[];
}

function envDurationMs(name: string, fallback: number, minimum: number): number {
  const configured = Number(process.env[name]);
  if (Number.isFinite(configured) && configured >= minimum) return configured;
  return fallback;
}

/**
 * How long may the scheduler be silent before the queue is unhealthy?
 * The workflow runs every 5 minutes, so the default tolerates two missed runs.
 */
export function drainStaleMs(): number {
  return envDurationMs("QUEUE_STALE_DRAIN_MS", 15 * 60_000, 60_000);
}

/**
 * How old may runnable work be before the queue is unhealthy? AI books can
 * occupy several consecutive drain slices, so this is deliberately looser
 * than the scheduler threshold.
 */
export function backlogAlertMs(): number {
  return envDurationMs("QUEUE_BACKLOG_ALERT_MS", 30 * 60_000, 60_000);
}

/** Pure policy: no database access, so the alerting rules are unit-testable. */
export function assessQueueHealth(
  input: QueueHealthInput,
  now: number,
  thresholds: { staleAfterMs: number; backlogAfterMs: number } = {
    staleAfterMs: drainStaleMs(),
    backlogAfterMs: backlogAlertMs(),
  },
): QueueHealth {
  const reasons: QueueHealthReason[] = [];

  if (!input.lastRun) {
    reasons.push("drain-never-ran");
  } else {
    if (now - input.lastRun.startedAt.getTime() > thresholds.staleAfterMs) {
      reasons.push("drain-stalled");
    }
    if (input.lastRun.errored) reasons.push("last-run-error");
  }

  const oldestDueAgeMs = input.oldestDueAt
    ? Math.max(0, now - input.oldestDueAt.getTime())
    : null;
  if (oldestDueAgeMs !== null && oldestDueAgeMs > thresholds.backlogAfterMs) {
    reasons.push("due-backlog");
  }

  return {
    queue: input.queue,
    due: input.due,
    processing: input.processing,
    failed: input.failed,
    failedRecent: input.failedRecent,
    oldestDueAt: input.oldestDueAt?.toISOString() ?? null,
    oldestDueAgeMs,
    lastRun: input.lastRun
      ? {
          id: input.lastRun.id,
          queue: input.queue,
          startedAt: input.lastRun.startedAt.toISOString(),
          finishedAt: input.lastRun.finishedAt.toISOString(),
          durationMs: input.lastRun.durationMs,
          claimed: input.lastRun.claimed,
          finished: input.lastRun.finished,
          yielded: input.lastRun.yielded,
          errored: input.lastRun.errored,
        }
      : null,
    lastRunAgeMs: input.lastRun ? Math.max(0, now - input.lastRun.startedAt.getTime()) : null,
    healthy: reasons.length === 0,
    reasons,
  };
}

const lastRunSelect = {
  id: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  claimed: true,
  finished: true,
  yielded: true,
  errored: true,
} as const;

async function aiQueueInput(now: Date, recentCutoff: Date): Promise<QueueHealthInput> {
  const dueWhere: Prisma.AiBookJobWhereInput = {
    OR: [
      { status: "QUEUED", nextAttemptAt: { lte: now } },
      {
        status: "PROCESSING",
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
    ],
  };
  const [due, processing, failed, failedRecent, oldestDue, lastRun] = await Promise.all([
    prisma.aiBookJob.count({ where: dueWhere }),
    prisma.aiBookJob.count({ where: { status: "PROCESSING" } }),
    prisma.aiBookJob.count({ where: { status: "FAILED" } }),
    prisma.aiBookJob.count({ where: { status: "FAILED", completedAt: { gte: recentCutoff } } }),
    // updatedAt is the closest proxy for "work has waited since" across both
    // due conditions (queued backoff and expired leases).
    prisma.aiBookJob.findFirst({
      where: dueWhere,
      orderBy: { updatedAt: "asc" },
      select: { updatedAt: true },
    }),
    prisma.queueDrainRun.findFirst({
      where: { queue: "ai" },
      orderBy: { startedAt: "desc" },
      select: lastRunSelect,
    }),
  ]);
  return {
    queue: "ai",
    due,
    processing,
    failed,
    failedRecent,
    oldestDueAt: oldestDue?.updatedAt ?? null,
    lastRun,
  };
}

async function renderQueueInput(now: Date, recentCutoff: Date): Promise<QueueHealthInput> {
  const dueWhere: Prisma.RenderJobWhereInput = {
    OR: [
      { status: "QUEUED", nextAttemptAt: { lte: now } },
      {
        status: "PROCESSING",
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
    ],
  };
  const [due, processing, failed, failedRecent, oldestDue, lastRun] = await Promise.all([
    prisma.renderJob.count({ where: dueWhere }),
    prisma.renderJob.count({ where: { status: "PROCESSING" } }),
    prisma.renderJob.count({ where: { status: "FAILED" } }),
    prisma.renderJob.count({ where: { status: "FAILED", completedAt: { gte: recentCutoff } } }),
    prisma.renderJob.findFirst({
      where: dueWhere,
      orderBy: { updatedAt: "asc" },
      select: { updatedAt: true },
    }),
    prisma.queueDrainRun.findFirst({
      where: { queue: "render" },
      orderBy: { startedAt: "desc" },
      select: lastRunSelect,
    }),
  ]);
  return {
    queue: "render",
    due,
    processing,
    failed,
    failedRecent,
    oldestDueAt: oldestDue?.updatedAt ?? null,
    lastRun,
  };
}

/**
 * Customer-facing queue signal.
 *
 * Polling clients need to know whether a job is waiting because the queue is
 * busy or because nothing is consuming it, without the cost of a full health
 * report. Two reads answer that: the last recorded AI drain and the oldest
 * runnable job.
 *
 * `stalled` deliberately means "runnable work exists and has been runnable for
 * longer than the backlog threshold", not "no drain ran recently": a dedicated
 * worker (which never records drain runs) is a healthy consumer too.
 */
export interface AiQueueSignal {
  /** Jobs runnable right now (queued past their delay, or lease expired). */
  due: number;
  /** Jobs currently held by a worker. */
  processing: number;
  oldestDueAgeMs: number | null;
  lastRunAgeMs: number | null;
  lastRunErrored: boolean;
  backlogAfterMs: number;
  stalled: boolean;
}

export async function aiQueueSignal(now = Date.now()): Promise<AiQueueSignal> {
  const nowDate = new Date(now);
  const dueWhere: Prisma.AiBookJobWhereInput = {
    OR: [
      { status: "QUEUED", nextAttemptAt: { lte: nowDate } },
      {
        status: "PROCESSING",
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: nowDate } }],
      },
    ],
  };
  const [due, processing, oldestDue, lastRun] = await Promise.all([
    prisma.aiBookJob.count({ where: dueWhere }),
    prisma.aiBookJob.count({ where: { status: "PROCESSING" } }),
    prisma.aiBookJob.findFirst({
      where: dueWhere,
      orderBy: { updatedAt: "asc" },
      select: { updatedAt: true },
    }),
    prisma.queueDrainRun.findFirst({
      where: { queue: "ai" },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, errored: true },
    }),
  ]);

  const backlogAfterMs = backlogAlertMs();
  const oldestDueAgeMs = oldestDue ? Math.max(0, now - oldestDue.updatedAt.getTime()) : null;
  return {
    due,
    processing,
    oldestDueAgeMs,
    lastRunAgeMs: lastRun ? Math.max(0, now - lastRun.startedAt.getTime()) : null,
    lastRunErrored: lastRun?.errored ?? false,
    backlogAfterMs,
    stalled: oldestDueAgeMs !== null && oldestDueAgeMs > backlogAfterMs,
  };
}

/** Build the current health report for both queues. */
export async function collectQueueHealth(now = Date.now()): Promise<QueueHealthReport> {
  const nowDate = new Date(now);
  const recentCutoff = new Date(now - RECENT_FAILURE_WINDOW_MS);
  const [ai, render] = await Promise.all([
    aiQueueInput(nowDate, recentCutoff),
    renderQueueInput(nowDate, recentCutoff),
  ]);
  const thresholds = { staleAfterMs: drainStaleMs(), backlogAfterMs: backlogAlertMs() };
  const queues = [
    assessQueueHealth(ai, now, thresholds),
    assessQueueHealth(render, now, thresholds),
  ];
  return {
    healthy: queues.every((queue) => queue.healthy),
    checkedAt: nowDate.toISOString(),
    staleAfterMs: thresholds.staleAfterMs,
    backlogAfterMs: thresholds.backlogAfterMs,
    queues,
  };
}

/**
 * Persist the outcome of one drain invocation and emit a structured log line.
 * Observability must never take the drain down: write failures are logged and
 * swallowed. Expired history is pruned opportunistically (about 2% of runs).
 */
export async function recordDrainRun(
  queue: QueueName,
  summary: DrainSummary,
): Promise<void> {
  console.info(
    JSON.stringify({
      event: "queue-drain-finished",
      queue,
      claimed: summary.claimed,
      finished: summary.finished,
      yielded: summary.yielded,
      errored: summary.errored,
      durationMs: summary.durationMs,
    }),
  );
  try {
    await prisma.queueDrainRun.create({
      data: {
        queue,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        durationMs: summary.durationMs,
        claimed: summary.claimed,
        finished: summary.finished,
        yielded: summary.yielded,
        errored: summary.errored,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "queue-drain-record-failed",
        queue,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  if (Math.random() < 0.02) {
    try {
      await prisma.queueDrainRun.deleteMany({
        where: { startedAt: { lt: new Date(Date.now() - DRAIN_RUN_RETENTION_MS) } },
      });
    } catch {
      // Best-effort retention: the run itself is already recorded.
    }
  }
}
