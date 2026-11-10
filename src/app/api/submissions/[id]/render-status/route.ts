import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getPresignedDownloadUrl } from "@/lib/s3";
import { artifactFilename } from "@/lib/pdf/artifacts";

export const dynamic = "force-dynamic";

/**
 * GET /api/submissions/:id/render-status
 *
 * Returns the latest render job status for a submission, plus both
 * deliverables. Clients can poll this endpoint to track PDF generation
 * progress. Signed URLs are minted only for approved books; a reading PDF that
 * predates the dual-artifact profile is reported as unavailable rather than
 * substituted with the print sheet.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const submission = await prisma.submission.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      title: true,
      pdfS3Key: true,
      readingPdfS3Key: true,
      renderJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          errorMessage: true,
          nextAttemptAt: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
        },
      },
    },
  });

  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.userId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const job = submission.renderJobs[0] ?? null;
  const canDownload = submission.status === "APPROVED" || session.user.role === "ADMIN";
  const hasPrintSheet = Boolean(submission.pdfS3Key);
  const hasReadingPdf = Boolean(submission.readingPdfS3Key);

  // If no job exists but we have a PDF, the submission was processed before
  // the job system was introduced.
  if (!job && submission.pdfS3Key) {
    const pdfUrl = canDownload
      ? await getPresignedDownloadUrl(submission.pdfS3Key, {
          filename: artifactFilename("print", submission.title),
        })
      : null;
    return NextResponse.json({
      status: "COMPLETED",
      jobStatus: "COMPLETED",
      submissionStatus: submission.status,
      pdfUrl,
      readingPdfUrl: null,
      readingPdfAvailable: hasReadingPdf,
      ready: canDownload && hasPrintSheet && hasReadingPdf,
      legacy: true,
    });
  }

  if (!job) {
    return NextResponse.json({
      status: submission.status,
      jobStatus: null,
      submissionStatus: submission.status,
      job: null,
    });
  }

  let pdfUrl: string | null = null;
  let readingPdfUrl: string | null = null;
  if (job.status === "COMPLETED" && canDownload) {
    if (submission.pdfS3Key) {
      pdfUrl = await getPresignedDownloadUrl(submission.pdfS3Key, {
        filename: artifactFilename("print", submission.title),
      });
    }
    if (submission.readingPdfS3Key) {
      readingPdfUrl = await getPresignedDownloadUrl(submission.readingPdfS3Key, {
        filename: artifactFilename("reading", submission.title),
      });
    }
  }

  return NextResponse.json({
    status: job.status,
    jobStatus: job.status,
    submissionStatus: submission.status,
    job: {
      id: job.id,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      errorMessage: job.errorMessage ? 'Rendering could not finish. You can retry safely.' : null,
      nextAttemptAt: job.nextAttemptAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
    },
    pdfUrl,
    readingPdfUrl,
    readingPdfAvailable: hasReadingPdf,
    // A book is only downloadable once it is approved *and* both artifacts
    // exist; either half alone is not the finished book the customer ordered.
    ready: canDownload && hasPrintSheet && hasReadingPdf,
  });
}
