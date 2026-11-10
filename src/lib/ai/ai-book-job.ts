import { createHash, randomUUID } from "node:crypto";
import {
  AiBookJobStatus,
  AiBookStage,
  type AiBookJob,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isAIConfigured } from "./client";

// Re-export the database enums so callers keep importing the pipeline's state
// machine from this module while Prisma remains the single source of truth.
export { AiBookJobStatus, AiBookStage };

// LLM stages are slower than rendering, so the lease is longer than the
// render queue's. It must stay well under the 5-minute drain cadence: a job
// whose worker dies (e.g. an abandoned serverless invocation) is only
// reclaimable once its lease expires. Live workers extend the lease via the
// heartbeat, so long LLM stages are unaffected.
export const LEASE_MS = Number(process.env.AI_BOOK_LEASE_MS ?? 120_000);
export const HEARTBEAT_MS = Number(process.env.AI_HEARTBEAT_MS ?? 60_000);
const LEASE_SECONDS = Math.max(1, Math.floor(LEASE_MS / 1000));
const RETRY_DELAYS = [5_000, 30_000, 120_000];
const MAX_ACTIVE_JOBS = Number(process.env.AI_MAX_ACTIVE_JOBS ?? 2);

/**
 * A text job may run for this long measured from its first claim. The limit is
 * an execution truth (not a wall-clock promise): it stops a permanently stalled
 * provider from keeping a job alive forever.
 */
export const JOB_LIFETIME_MS = Number(process.env.AI_BOOK_LIFETIME_MS ?? 30 * 60 * 1000);
/** Default pause before re-checking a render dependency. */
export const CONTINUE_DELAY_MS = Number(process.env.AI_BOOK_CONTINUE_DELAY_MS ?? 10_000);
/** Content repair cycles are bounded independently of infrastructure retries. */
export const MAX_REPAIRS = Number(process.env.AI_BOOK_MAX_REPAIRS ?? 2);

export class AiBookError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** A failure that should not be retried; the pipeline marks the job FAILED. */
export class AiBookTerminalError extends Error {}

/**
 * A claimed job plus the accounting flags computed atomically at claim time.
 *
 * `attempts` is claim telemetry only. Budget is decided by `failureCount`
 * (see maxAttempts), so waiting on a render or yielding for a drain never
 * spends the failure budget.
 */
export type ClaimedAiBookJob = AiBookJob & {
  exhausted: boolean;
  deadlineExpired: boolean;
};

function digestPayload(payload: { concept: string; templateId: string | null }): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export interface EnqueueAiBookResult {
  jobId: string;
  /** True when an existing job matched the request key (idempotent replay). */
  duplicate: boolean;
}

/**
 * Create a queued AI book job, or return the existing one for a repeated
 * request key.
 *
 * The user row is locked so the active-job cap cannot be bypassed by
 * concurrent requests; the cap check and the insert then observe the same
 * snapshot. A repeated key with a different payload is a conflict: silently
 * returning the first job would hand the user a book they did not ask for.
 */
export async function enqueueAiBookJob(
  userId: string,
  concept: string,
  templateId?: string,
  options: { requestKey?: string } = {},
): Promise<EnqueueAiBookResult> {
  if (!isAIConfigured()) {
    throw new AiBookError(503, "AI assistant is not configured. OPENAI_API_KEY is missing.");
  }
  const payloadDigest = digestPayload({ concept, templateId: templateId ?? null });
  const requestKey = options.requestKey?.trim() || randomUUID();

  try {
    return await prisma.$transaction(
      async (tx) => {
        // Serializes cap enforcement and insertion per user. Lock ordering is
        // always user -> AiBookJob, matching the claim/fence paths.
        await tx.$executeRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;

        const existing = await tx.aiBookJob.findUnique({
          where: { userId_requestKey: { userId, requestKey } },
          select: { id: true, payloadDigest: true },
        });
        if (existing) {
          if (existing.payloadDigest && existing.payloadDigest !== payloadDigest) {
            throw new AiBookError(
              409,
              "This request id was already used for a different book request.",
            );
          }
          return { jobId: existing.id, duplicate: true };
        }

        const active = await tx.aiBookJob.count({
          where: {
            userId,
            status: { in: [AiBookJobStatus.QUEUED, AiBookJobStatus.PROCESSING] },
          },
        });
        if (active >= MAX_ACTIVE_JOBS) {
          throw new AiBookError(
            429,
            "You have too many AI books in progress. Wait for them to finish.",
          );
        }

        const job = await tx.aiBookJob.create({
          data: {
            userId,
            concept,
            templateId: templateId ?? null,
            requestKey,
            payloadDigest,
            maxRepairs: MAX_REPAIRS,
          },
        });
        return { jobId: job.id, duplicate: false };
      },
      { timeout: 15000 },
    );
  } catch (error) {
    // A concurrent identical request can still lose the unique-index race.
    // Re-read and apply the same duplicate/conflict rules instead of failing.
    if ((error as { code?: string }).code === "P2002") {
      const existing = await prisma.aiBookJob.findUnique({
        where: { userId_requestKey: { userId, requestKey } },
        select: { id: true, payloadDigest: true },
      });
      if (existing) {
        if (existing.payloadDigest && existing.payloadDigest !== payloadDigest) {
          throw new AiBookError(
            409,
            "This request id was already used for a different book request.",
          );
        }
        return { jobId: existing.id, duplicate: true };
      }
    }
    throw error;
  }
}

/**
 * Atomically claim the next runnable job with a lease.
 *
 * Reclaiming an expired PROCESSING lease is counted as exactly one failure:
 * the job's owner stopped without reporting anything, which is a real
 * execution failure rather than a claim. `attempts` still increments on every
 * claim so telemetry stays complete.
 */
export async function claimAiBookJob(): Promise<ClaimedAiBookJob | null> {
  const token = randomUUID();
  const lifetimeSeconds = Math.max(1, Math.floor(JOB_LIFETIME_MS / 1000));
  const rows = await prisma.$queryRaw<ClaimedAiBookJob[]>`
    WITH candidate AS (
      SELECT "id",
        ("status" = 'PROCESSING') AS reclaimed,
        ("failureCount" + CASE WHEN "status" = 'PROCESSING' THEN 1 ELSE 0 END) >= "maxAttempts" AS exhausted,
        ("deadlineAt" IS NOT NULL AND "deadlineAt" <= clock_timestamp()) AS "deadlineExpired"
      FROM "AiBookJob"
      WHERE ("status" = 'QUEUED' AND "nextAttemptAt" <= clock_timestamp())
         OR ("status" = 'PROCESSING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp()))
      ORDER BY "nextAttemptAt", "createdAt"
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "AiBookJob" j SET "status" = 'PROCESSING',
      "attempts" = j."attempts" + 1,
      "failureCount" = j."failureCount" + CASE WHEN c.reclaimed THEN 1 ELSE 0 END,
      "claimToken" = ${token},
      "leaseExpiresAt" = clock_timestamp() + make_interval(secs => ${LEASE_SECONDS}),
      "deadlineAt" = COALESCE(j."deadlineAt", clock_timestamp() + make_interval(secs => ${lifetimeSeconds})),
      "startedAt" = COALESCE(j."startedAt", clock_timestamp()),
      "updatedAt" = clock_timestamp()
    FROM candidate c WHERE j."id" = c."id"
    RETURNING j.*, c.exhausted, c."deadlineExpired"`;
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

/**
 * Re-check that this worker still holds a valid, unexpired lease on the job.
 * Exported so callers can run their own side effects inside the same fence.
 */
export async function fenceAiBookJob(
  job: ClaimedAiBookJob,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "AiBookJob" WHERE "id" = ${job.id} AND "claimToken" = ${job.claimToken}
    AND "status" = 'PROCESSING' AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`;
  return rows.length === 1;
}

async function mergeStageOutput(
  tx: Prisma.TransactionClient,
  jobId: string,
  patch: Record<string, unknown> | undefined,
): Promise<Prisma.InputJsonValue | undefined> {
  if (!patch) return undefined;
  const current = await tx.aiBookJob.findUnique({
    where: { id: jobId },
    select: { stageOutput: true },
  });
  return {
    ...((current?.stageOutput as Record<string, unknown>) ?? {}),
    ...patch,
  } as Prisma.InputJsonValue;
}

export interface StageData {
  submissionId?: string;
  renderJobId?: string;
}

/**
 * Persist progress: advance the stage and merge a patch into stageOutput so a
 * retry resumes from the last completed stage instead of restarting.
 *
 * `extra` runs inside the same lease-fenced transaction, so a side effect
 * (creating or rewriting the draft) can never commit without also advancing
 * the stage, and a worker that lost its lease can never write either. It may
 * return job columns (e.g. the newly created submission id) that must be
 * persisted with the advance.
 */
export async function advanceStage(
  job: ClaimedAiBookJob,
  stage: AiBookStage,
  outputPatch: Record<string, unknown> = {},
  data: StageData = {},
  extra?: (tx: Prisma.TransactionClient) => Promise<StageData | void>,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await fenceAiBookJob(job, tx))) return false;
    const extraData = extra ? await extra(tx) : undefined;
    const merged = await mergeStageOutput(tx, job.id, outputPatch);
    await tx.aiBookJob.update({
      where: { id: job.id },
      data: {
        stage,
        ...(merged ? { stageOutput: merged } : {}),
        ...data,
        ...(extraData ?? {}),
      },
    });
    return true;
  }, { timeout: 20000 });
}

export type ContinueOutcome =
  | "queued"
  | "lease-lost"
  | "deadline-exceeded"
  | "repair-exhausted";

export interface ContinueAiBookOptions {
  /** Stage to persist before requeueing. Defaults to leaving it unchanged. */
  stage?: AiBookStage;
  patch?: Record<string, unknown>;
  data?: { submissionId?: string; renderJobId?: string };
  /** Short not-before delay so a resumed claim lands after the dependency. */
  notBeforeMs?: number;
  /** Spend one content-repair cycle as part of this continuation. */
  repair?: boolean;
}

/**
 * Lease-fenced continuation: persist progress, requeue the job for a later
 * check, and release the lease. This is how waiting on a render or yielding a
 * bounded drain works, so neither spends failure budget.
 */
export async function continueAiBook(
  job: ClaimedAiBookJob,
  options: ContinueAiBookOptions = {},
): Promise<ContinueOutcome> {
  return prisma.$transaction(async (tx) => {
    if (!(await fenceAiBookJob(job, tx))) return "lease-lost" as const;

    const current = await tx.aiBookJob.findUnique({
      where: { id: job.id },
      select: {
        deadlineAt: true,
        repairCount: true,
        maxRepairs: true,
        stageOutput: true,
      },
    });
    if (!current) return "lease-lost" as const;

    if (current.deadlineAt && current.deadlineAt.getTime() <= Date.now()) {
      await tx.aiBookJob.update({
        where: { id: job.id },
        data: {
          status: AiBookJobStatus.FAILED,
          claimToken: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
          errorMessage: "This AI book exceeded its generation time limit.",
        },
      });
      return "deadline-exceeded" as const;
    }

    if (options.repair && current.repairCount >= current.maxRepairs) {
      return "repair-exhausted" as const;
    }

    const merged = options.patch
      ? ({
          ...((current.stageOutput as Record<string, unknown>) ?? {}),
          ...options.patch,
        } as Prisma.InputJsonValue)
      : undefined;

    await tx.aiBookJob.update({
      where: { id: job.id },
      data: {
        status: AiBookJobStatus.QUEUED,
        claimToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + (options.notBeforeMs ?? CONTINUE_DELAY_MS)),
        ...(options.stage ? { stage: options.stage } : {}),
        ...(merged ? { stageOutput: merged } : {}),
        ...(options.data ?? {}),
        ...(options.repair ? { repairCount: { increment: 1 } } : {}),
      },
    });
    return "queued" as const;
  }, { timeout: 20000 });
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
      if (!(await fenceAiBookJob(job, tx))) return false;
      const merged = await mergeStageOutput(tx, job.id, outputPatch);
      if (extra) await extra(tx);
      await tx.aiBookJob.update({
        where: { id: job.id },
        data: {
          status: AiBookJobStatus.COMPLETED,
          ...(merged ? { stageOutput: merged } : {}),
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
 * Fail the job: spend one unit of the failure budget, retry with backoff unless
 * terminal or the budget is exhausted. On exhaustion the job is marked FAILED
 * with the surfaced error message.
 */
export async function failAiBook(
  job: ClaimedAiBookJob,
  terminal = false,
  message = "The AI could not complete this book. Please try again.",
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await fenceAiBookJob(job, tx))) return false;
    const current = await tx.aiBookJob.findUnique({
      where: { id: job.id },
      select: { failureCount: true, maxAttempts: true, deadlineAt: true },
    });
    if (!current) return false;
    const failures = current.failureCount + 1;
    const expired = current.deadlineAt ? current.deadlineAt.getTime() <= Date.now() : false;
    const exhausted = terminal || expired || failures >= current.maxAttempts;
    await tx.aiBookJob.update({
      where: { id: job.id },
      data: {
        failureCount: failures,
        status: exhausted ? AiBookJobStatus.FAILED : AiBookJobStatus.QUEUED,
        claimToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(
          Date.now() + (RETRY_DELAYS[Math.min(failures - 1, RETRY_DELAYS.length - 1)] ?? 30_000),
        ),
        completedAt: exhausted ? new Date() : null,
        errorMessage: exhausted
          ? expired
            ? "This AI book exceeded its generation time limit."
            : message
          : null,
      },
    });
    return true;
  });
}

/** Remaining failure budget for this claim (for logging and status responses). */
export function failureBudgetRemaining(job: AiBookJob): number {
  return Math.max(0, job.maxAttempts - job.failureCount);
}
