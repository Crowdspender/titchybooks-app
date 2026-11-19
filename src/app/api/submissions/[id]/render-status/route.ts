import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export const dynamic = "force-dynamic";

/**
 * GET /api/submissions/:id/render-status
 *
 * Returns the latest render job status for a submission, plus both
 * deliverables. Clients can poll this endpoint to track PDF generation
 * progress. Same-origin links authorize the transfer when clicked; unavailable
 * reading PDFs are never substituted with the print sheet.
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
      artifactManifest: true,
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
  const legacyPrintOnly = hasPrintSheet && !hasReadingPdf && submission.artifactManifest === null;
  const base = `/api/submissions/${encodeURIComponent(id)}/downloads`;
  const available = {
    printSheet: canDownload && hasPrintSheet,
    readingPdf: canDownload && hasReadingPdf,
  };

  // If no job exists but we have a PDF, the submission was processed before
  // the job system was introduced.
  if (!job && submission.pdfS3Key) {
    const pdfUrl = canDownload ? `${base}?kind=print` : null;
    return NextResponse.json({
      status: "COMPLETED",
      jobStatus: "COMPLETED",
      submissionStatus: submission.status,
      pdfUrl,
      readingPdfUrl: available.readingPdf ? `${base}?kind=reading` : null,
      readingPdfAvailable: hasReadingPdf,
      artifacts: available,
      ready: canDownload && hasPrintSheet && (hasReadingPdf || legacyPrintOnly),
      legacy: true,
    }, { headers: privateHeaders });
  }

  if (!job) {
    return NextResponse.json({
      status: submission.status,
      jobStatus: null,
      submissionStatus: submission.status,
      job: null,
      pdfUrl: available.printSheet ? `${base}?kind=print` : null,
      readingPdfUrl: available.readingPdf ? `${base}?kind=reading` : null,
      readingPdfAvailable: hasReadingPdf,
      artifacts: available,
      ready: false,
    }, { headers: privateHeaders });
  }

  const pdfUrl = job.status === 'COMPLETED' && available.printSheet ? `${base}?kind=print` : null;
  const readingPdfUrl = job.status === 'COMPLETED' && available.readingPdf ? `${base}?kind=reading` : null;

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
    artifacts: available,
    legacy: legacyPrintOnly,
    // Preserve historical print-only files without calling an unfinished new render ready.
    ready: job.status === 'COMPLETED' && canDownload && hasPrintSheet && (hasReadingPdf || legacyPrintOnly),
  }, { headers: privateHeaders });
}
