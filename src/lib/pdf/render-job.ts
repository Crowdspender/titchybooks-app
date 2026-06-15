import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";
import { generateTitchybookPdf } from "./generate";

export enum RenderJobStatus {
  QUEUED = "QUEUED",
  PROCESSING = "PROCESSING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
}

/**
 * Create a render job for a submission and return immediately.
 * The actual rendering is handled by `processRenderJob` which
 * should be called via Next.js `after()` or fire-and-forget.
 */
export async function createRenderJob(submissionId: string): Promise<string> {
  const job = await prisma.renderJob.create({
    data: {
      submissionId,
      status: RenderJobStatus.QUEUED,
    },
  });
  return job.id;
}

/**
 * Process a render job: execute PDF generation, track status, and
 * handle retries up to maxAttempts.
 */
export async function processRenderJob(jobId: string): Promise<void> {
  const job = await prisma.renderJob.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    console.error(`Render job ${jobId} not found`);
    return;
  }

  if (job.status !== RenderJobStatus.QUEUED && job.status !== RenderJobStatus.FAILED) {
    console.warn(`Render job ${jobId} is in unexpected state: ${job.status}`);
    return;
  }

  if (job.attempts >= job.maxAttempts) {
    console.error(`Render job ${jobId} exceeded max attempts (${job.maxAttempts})`);
    await prisma.renderJob.update({
      where: { id: jobId },
      data: {
        status: RenderJobStatus.FAILED,
        errorMessage: `Exceeded max attempts (${job.maxAttempts})`,
      },
    });
    return;
  }

  // Mark as processing
  await prisma.renderJob.update({
    where: { id: jobId },
    data: {
      status: RenderJobStatus.PROCESSING,
      attempts: { increment: 1 },
      startedAt: new Date(),
    },
  });

  try {
    const pdfS3Key = await generateTitchybookPdf(job.submissionId);

    await prisma.renderJob.update({
      where: { id: jobId },
      data: {
        status: RenderJobStatus.COMPLETED,
        pdfS3Key,
        completedAt: new Date(),
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`Render job ${jobId} failed (attempt ${job.attempts + 1}/${job.maxAttempts}):`, error);

    await prisma.renderJob.update({
      where: { id: jobId },
      data: {
        status: RenderJobStatus.FAILED,
        errorMessage,
      },
    }).catch((dbError: unknown) => {
      console.error(`Failed to update render job ${jobId} status:`, dbError);
    });

    // Also mark submission as failed if this was the last attempt
    if (job.attempts + 1 >= job.maxAttempts) {
      await prisma.submission.update({
        where: { id: job.submissionId },
        data: { status: SubmissionStatus.FAILED },
      }).catch(() => undefined);
    }
  }
}

/**
 * Fire-and-forget helper: creates a render job and processes it.
 * Designed for use with Next.js `after()` or `.catch()` pattern.
 */
export async function enqueueRenderJob(submissionId: string): Promise<string> {
  const jobId = await createRenderJob(submissionId);
  // Process immediately but don't block the caller
  processRenderJob(jobId).catch((error) => {
    console.error(`Render job ${jobId} processing crashed:`, error);
  });
  return jobId;
}
