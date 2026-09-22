import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RenderJob } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { lockSubmission, SubmissionError, type Actor, type Transaction } from '@/lib/editor/submission-store';
import { captureSnapshot, InvalidRenderInput, parseRenderSnapshot, type RenderSnapshot } from './snapshot';
import type { RenderArtifacts } from './render-output';

export enum RenderJobStatus {
  QUEUED = 'QUEUED', PROCESSING = 'PROCESSING', COMPLETED = 'COMPLETED', FAILED = 'FAILED',
}
export const LEASE_MS = 120_000;
export const HEARTBEAT_MS = 20_000;
const RETRY_DELAYS = [5_000, 30_000];

// Caller holds the submission lock; enqueue and lifecycle change commit together.
export async function enqueueInTransaction(tx: Transaction, id: string, actor: Actor, options: { retry?: boolean; force?: boolean } = {}) {
  const submission = await lockSubmission(tx, id, actor);
  if (submission.isTemplate) throw new SubmissionError(400, 'Templates are published through template management');
  const active = await tx.renderJob.findFirst({ where: { submissionId: id, status: { in: ['QUEUED', 'PROCESSING'] } }, orderBy: { createdAt: 'desc' } });
  if (submission.status === 'PROCESSING' && active) return { jobId: active.id, submission, dpiWarnings: [] };
  if (submission.status !== (options.retry ? 'FAILED' : 'DRAFT')) throw new SubmissionError(409, 'This submission cannot be queued in its current state');
  const previous = options.retry ? await tx.renderJob.findFirst({ where: { submissionId: id }, orderBy: { createdAt: 'desc' } }) : null;
  const captured = previous?.inputSnapshot
    ? { input: parseRenderSnapshot(previous.inputSnapshot), warnings: [] }
    : await captureSnapshot(tx, submission, actor, options.force);
  const job = await tx.renderJob.create({ data: { submissionId: id, inputSnapshot: captured.input } });
  const updated = await tx.submission.update({ where: { id }, data: { status: 'PROCESSING', submittedAt: new Date() } });
  return { jobId: job.id, submission: updated, dpiWarnings: captured.warnings };
}
export async function enqueueRenderJob(id: string, actor: Actor, options: { retry?: boolean; force?: boolean } = {}) {
  return prisma.$transaction(tx => enqueueInTransaction(tx, id, actor, options), { timeout: 20000 });
}

export type ClaimedJob = RenderJob & { exhausted: boolean };
export async function claimRenderJob(): Promise<ClaimedJob | null> {
  const token = randomUUID();
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    WITH candidate AS (
      SELECT "id", ("attempts" >= "maxAttempts") AS exhausted FROM "RenderJob"
      WHERE ("status" = 'QUEUED' AND "nextAttemptAt" <= clock_timestamp())
         OR ("status" = 'PROCESSING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp()))
      ORDER BY "nextAttemptAt", "createdAt"
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "RenderJob" j SET "status" = 'PROCESSING',
      "attempts" = LEAST(j."attempts" + 1, j."maxAttempts"),
      "claimToken" = ${token}, "leaseExpiresAt" = clock_timestamp() + interval '120 seconds',
      "startedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
    FROM candidate c WHERE j."id" = c."id" RETURNING j.*, c.exhausted`;
  return rows[0] ?? null;
}
export async function heartbeat(job: ClaimedJob) {
  const count = await prisma.$executeRaw`
    UPDATE "RenderJob" SET "leaseExpiresAt" = clock_timestamp() + interval '120 seconds', "updatedAt" = clock_timestamp()
    WHERE "id" = ${job.id} AND "claimToken" = ${job.claimToken} AND "status" = 'PROCESSING'
      AND "leaseExpiresAt" > clock_timestamp()`;
  return count === 1;
}

async function fence(tx: Transaction, job: ClaimedJob) {
  await lockSubmission(tx, job.submissionId);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "RenderJob" WHERE "id" = ${job.id} AND "claimToken" = ${job.claimToken}
    AND "status" = 'PROCESSING' AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`;
  return rows.length === 1;
}
export async function publishRender(job: ClaimedJob, artifacts: RenderArtifacts) {
  return prisma.$transaction(async tx => {
    if (!await fence(tx, job)) return false;
    await tx.submission.update({ where: { id: job.submissionId }, data: { status: 'PENDING', pdfS3Key: artifacts.pdfS3Key } });
    for (const preview of artifacts.previews) {
      await tx.submissionPage.updateMany({ where: { submissionId: job.submissionId, pageLabel: preview.pageLabel }, data: { previewS3Key: preview.s3Key } });
    }
    await tx.renderJob.update({ where: { id: job.id }, data: {
      status: 'COMPLETED', pdfS3Key: artifacts.pdfS3Key, completedAt: new Date(), errorMessage: null, leaseExpiresAt: null, claimToken: null,
    } });
    return true;
  });
}
export async function failRender(job: ClaimedJob, terminal = false) {
  return prisma.$transaction(async tx => {
    if (!await fence(tx, job)) return false;
    const exhausted = terminal || job.attempts >= job.maxAttempts;
    await tx.renderJob.update({ where: { id: job.id }, data: {
      status: exhausted ? 'FAILED' : 'QUEUED', claimToken: null, leaseExpiresAt: null,
      nextAttemptAt: new Date(Date.now() + (RETRY_DELAYS[job.attempts - 1] ?? 30_000)),
      completedAt: exhausted ? new Date() : null,
      errorMessage: terminal ? 'The saved render input is invalid or unavailable.' : 'Rendering failed. Please retry if the problem persists.',
    } });
    await tx.submission.update({ where: { id: job.submissionId }, data: { status: exhausted ? 'FAILED' : 'PROCESSING' } });
    return true;
  });
}
async function frozenInput(job: ClaimedJob) {
  if (job.inputSnapshot) return parseRenderSnapshot(job.inputSnapshot);
  // Historical interrupted jobs had no snapshot. Capture once under the same locks.
  return prisma.$transaction(async tx => {
    if (!await fence(tx, job)) throw new Error('Lease lost');
    const submission = await tx.submission.findUniqueOrThrow({ where: { id: job.submissionId } });
    const owner = await tx.user.findUniqueOrThrow({ where: { id: submission.userId } });
    const { input } = await captureSnapshot(tx, submission, { id: owner.id, role: owner.role }, true);
    await tx.renderJob.update({ where: { id: job.id }, data: { inputSnapshot: input } });
    return input;
  }, { timeout: 20000 });
}
export async function processRenderJob(job: ClaimedJob, render?: (input: RenderSnapshot, prefix: string) => Promise<RenderArtifacts>) {
  let lostLease = false;
  const timer = setInterval(() => {
    void heartbeat(job).then(ok => { if (!ok) lostLease = true; }).catch(() => { lostLease = true; });
  }, HEARTBEAT_MS);
  try {
    if (job.exhausted) { await failRender(job, true); return; }
    const input = await frozenInput(job);
    if (input.submissionId !== job.submissionId) throw new InvalidRenderInput('Snapshot identity mismatch');
    const generator = render ?? (await import('./generate')).generateTitchybookPdf;
    const { buildRenderAttemptPrefix } = await import('@/lib/s3');
    const artifacts = await generator(input, buildRenderAttemptPrefix(input.userId, job.submissionId, job.id, job.attempts, job.claimToken!));
    if (!lostLease) await publishRender(job, artifacts);
  } catch (error) {
    console.error(JSON.stringify({ event: 'render-failed', jobId: job.id, attempt: job.attempts }));
    if (!lostLease) await failRender(job, error instanceof InvalidRenderInput || error instanceof SubmissionError || error instanceof z.ZodError || error instanceof SyntaxError);
  } finally { clearInterval(timer); }
}
