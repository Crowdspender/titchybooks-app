import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getPresignedDownloadUrl } from "@/lib/s3";

export const dynamic = "force-dynamic";

/**
 * GET /api/submissions/:id/render-status
 *
 * Returns the latest render job status for a submission.
 * Clients can poll this endpoint to track PDF generation progress.
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
      pdfS3Key: true,
      renderJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          attempts: true,
          maxAttempts: true,
          errorMessage: true,
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

  // If no job exists but we have a PDF, the submission was processed before
  // the job system was introduced.
  if (!job && submission.pdfS3Key) {
    const pdfUrl = await getPresignedDownloadUrl(submission.pdfS3Key);
    return NextResponse.json({
      status: "COMPLETED",
      pdfUrl,
      legacy: true,
    });
  }

  if (!job) {
    return NextResponse.json({
      status: submission.status,
      job: null,
    });
  }

  let pdfUrl: string | null = null;
  if (job.status === "COMPLETED" && submission.pdfS3Key) {
    pdfUrl = await getPresignedDownloadUrl(submission.pdfS3Key);
  }

  return NextResponse.json({
    status: job.status,
    job: {
      id: job.id,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      errorMessage: job.errorMessage,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
    },
    pdfUrl,
  });
}
