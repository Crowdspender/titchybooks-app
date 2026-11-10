import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { deriveAiBookPhase } from "@/lib/ai/job-status";
import { aiQueueSignal } from "@/lib/queue-health";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/books/:id - typed status for one AI book job.
 *
 * Deliberately URL-free: the client links to `/api/ai/books/:id/downloads`
 * instead, which mints a fresh signed URL per click. Embedding signed URLs in a
 * polled response would hand the browser links that expire while it waits.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const job = await prisma.aiBookJob.findUnique({ where: { id } });
  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (job.userId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [submission, queue] = await Promise.all([
    job.submissionId
      ? prisma.submission.findUnique({
          where: { id: job.submissionId },
          select: {
            id: true,
            title: true,
            status: true,
            pdfS3Key: true,
            readingPdfS3Key: true,
          },
        })
      : Promise.resolve(null),
    aiQueueSignal(Date.now()),
  ]);

  const stageOutput = (job.stageOutput ?? {}) as Record<string, unknown>;
  const phase = deriveAiBookPhase({
    status: job.status,
    stage: job.stage,
    hasQaReport: Boolean(stageOutput.qaReport),
    repairCount: job.repairCount,
    errorMessage: job.errorMessage,
  });

  // Both artifacts are required before a book counts as finished; a print sheet
  // without the reading PDF is not a complete deliverable.
  const approved = submission?.status === "APPROVED";
  const printSheet = Boolean(submission?.pdfS3Key);
  const readingPdf = Boolean(submission?.readingPdfS3Key);

  return NextResponse.json({
    id: job.id,
    status: job.status,
    stage: job.stage,
    phase,
    submissionId: job.submissionId,
    title: submission?.title ?? null,
    errorMessage: job.errorMessage,
    attempts: { used: job.failureCount, allowed: job.maxAttempts },
    repairs: { used: job.repairCount, allowed: job.maxRepairs },
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
    queue,
    artifacts: {
      approved,
      printSheet,
      readingPdf,
      ready: approved && printSheet && readingPdf,
    },
    // Structured QA detail is an operator concern, not customer copy.
    qaReport: session.user.role === "ADMIN" ? (stageOutput.qaReport ?? null) : null,
  });
}
