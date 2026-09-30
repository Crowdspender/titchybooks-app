import { randomUUID } from "node:crypto";
import type { AiBookJob, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isAIConfigured } from "./client";

export enum AiBookStage {
  CONCEPT = "CONCEPT",
  CONTENT = "CONTENT",
  COMPOSE = "COMPOSE",
  RENDER = "RENDER",
  QA = "QA",
}
export enum AiBookJobStatus {
  QUEUED = "QUEUED",
  PROCESSING = "PROCESSING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

// LLM stages are slower than rendering, so the lease is longer.
export const LEASE_MS = Number(process.env.AI_BOOK_LEASE_MS ?? 300_000);
export const HEARTBEAT_MS = Number(process.env.AI_HEARTBEAT_MS ?? 60_000);
const LEASE_SECONDS = Math.max(1, Math.floor(LEASE_MS / 1000));
const RETRY_DELAYS = [5_000, 30_000];
const MAX_ACTIVE_JOBS = Number(process.env.AI_MAX_ACTIVE_JOBS ?? 2);

export class AiBookError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** A failure that should not be retried; the pipeline marks the job FAILED. */
export class AiBookTerminalError extends Error {}

export type ClaimedAiBookJob = AiBookJob & { exhausted: boolean };

/**
 * Create a queued AI book job. Rejects when AI is unconfigured or the user
 * already has too many active jobs.
 */
export async function enqueueAiBookJob(
  userId: string,
  concept: string,
  templateId?: string,
): Promise<{ jobId: string }> {
  if (!isAIConfigured()) {
    throw new AiBookError(503, "AI assistant is not configured. OPENAI_API_KEY is missing.");
  }
  const active = await prisma.aiBookJob.count({
    where: { userId, status: { in: [AiBookJobStatus.QUEUED, AiBookJobStatus.PROCESSING] } },
  });
  if (active >= MAX_ACTIVE_JOBS) {
    throw new AiBookError(429, "You have too many AI books in progress. Wait for them to finish.");
  }
  const job = await prisma.aiBookJob.create({
    data: { userId, concept, templateId: templateId ?? null },
  });
  return { jobId: job.id };
}

/**
 * Atomically claim the next runnable job with a lease, reclaiming jobs whose
 * lease expired. Mirrors claimRenderJob() in lib/pdf/render-job.ts.
 */
export async function claimAiBookJob(): Promise<ClaimedAiBookJob | null> {
  const token = randomUUID();
  const rows = await prisma.$queryRaw<ClaimedAiBookJob[]>`
    WITH candidate AS (
      SELECT "id", ("attempts" >= "maxAttempts") AS exhausted FROM "AiBookJob"
      WHERE ("status" = 'QUEUED' AND "nextAttemptAt" <= clock_timestamp())
         OR ("status" = 'PROCESSING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp()))
      ORDER BY "nextAttemptAt", "createdAt"
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "AiBookJob" j SET "status" = 'PROCESSING',
      "attempts" = LEAST(j."attempts" + 1, j."maxAttempts"),
      "claimToken" = ${token}, "leaseExpiresAt" = clock_timestamp() + make_interval(secs => ${LEASE_SECONDS}),
      "startedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
    FROM candidate c WHERE j."id" = c."id" RETURNING j.*, c.exhausted`;
  return rows[0] ?? null;
}

/** Extend the lease for a job we still hold. Returns false if the lease was lost. */
export async function heartbeatAiBookJob(job: ClaimedAiBookJob): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE "AiBookJob" SET "leaseExpiresAt" = clock_timestamp() + make_interval(secs => ${LEASE_SECONDS}), "updatedAt" = clock_timestamp()
    WHERE "id" = ${job.id} AND "claimToken" = ${job.claimToken} AND "status" = 'PROCESSING'
      AND "leaseExpiresAt" > clock_timestamp()`;
  return count === 1;
}

/** Re-check that this worker still holds a valid, unexpired lease on the job. */
async function fence(job: ClaimedAiBookJob, tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "AiBookJob" WHERE "id" = ${job.id} AND "claimToken" = ${job.claimToken}
    AND "status" = 'PROCESSING' AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`;
  return rows.length === 1;
}

/**
 * Persist progress: advance the stage and merge a patch into stageOutput so a
 * retry resumes from the last completed stage instead of restarting.
 */
export async function advanceStage(
  job: ClaimedAiBookJob,
  stage: AiBookStage,
  outputPatch: Record<string, unknown> = {},
  data: { submissionId?: string; renderJobId?: string } = {},
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await fence(job, tx))) return false;
    const current = await tx.aiBookJob.findUnique({ where: { id: job.id }, select: { stageOutput: true } });
    const merged = { ...((current?.stageOutput as Record<string, unknown>) ?? {}), ...outputPatch };
    await tx.aiBookJob.update({ where: { id: job.id }, data: { stage: stage.valueOf(), stageOutput: merged as Prisma.InputJsonValue, ...data } });
    return true;
  });
}

/**
 * Mark the job complete, merging any final output patch. `extra` runs inside
 * the same lease-fenced transaction so side effects (e.g. approving the
 * submission) only apply while this worker still holds the lease.
 */
export async function completeAiBook(
  job: ClaimedAiBookJob,
  outputPatch: Record<string, unknown> = {},
  extra?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (!(await fence(job, tx))) return false;
      const current = await tx.aiBookJob.findUnique({ where: { id: job.id }, select: { stageOutput: true } });
      const merged = { ...((current?.stageOutput as Record<string, unknown>) ?? {}), ...outputPatch };
      if (extra) await extra(tx);
      await tx.aiBookJob.update({
        where: { id: job.id },
        data: {
          status: AiBookJobStatus.COMPLETED,
          stageOutput: merged as Prisma.InputJsonValue,
          errorMessage: null,
          leaseExpiresAt: null,
          claimToken: null,
          completedAt: new Date(),
        },
      });
      return true;
    }, { timeout: 20000 });
  } catch (error) {
    // P2025: a row the transaction needed (e.g. the submission targeted by the
    // extra callback) is gone. Fail terminally with a clear message instead of
    // requeueing until retries exhaust.
    if ((error as { code?: string }).code === "P2025") {
      throw new AiBookTerminalError("The book draft no longer exists.");
    }
    throw error;
  }
}

/**
 * Fail the job: retry with backoff unless terminal or attempts are exhausted.
 * On exhaustion the job is marked FAILED with the surfaced error message.
 */
export async function failAiBook(
  job: ClaimedAiBookJob,
  terminal = false,
  message = "The AI could not complete this book. Please try again.",
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await fence(job, tx))) return false;
    const exhausted = terminal || job.attempts >= job.maxAttempts;
    await tx.aiBookJob.update({
      where: { id: job.id },
      data: {
        status: exhausted ? AiBookJobStatus.FAILED : AiBookJobStatus.QUEUED,
        claimToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + (RETRY_DELAYS[job.attempts - 1] ?? 30_000)),
        completedAt: exhausted ? new Date() : null,
        errorMessage: exhausted ? message : null,
      },
    });
    return true;
  });
}
