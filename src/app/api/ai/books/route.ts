import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { enqueueAiBookJob, AiBookError } from "@/lib/ai/ai-book-job";
import { deriveAiBookPhase } from "@/lib/ai/job-status";
import { consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** How many recent jobs the dashboard list returns. */
const RECENT_LIMIT = 20;

const bodySchema = z.object({
  concept: z.string().trim().min(1).max(2000),
  templateId: z.string().min(1).optional(),
  /**
   * Idempotency key for one deliberate generation. A network retry must reuse
   * it; pressing "create" again after the result is known gets a new one.
   */
  requestKey: z.string().trim().min(8).max(100).optional(),
});

// Per-user spacing between AI book jobs. Durable Postgres buckets: an
// in-memory map neither survives restarts nor coordinates across serverless
// instances (same rationale as the AI chat route).
const BOOK_JOB_SPACING = { limit: 1, windowMs: 10_000 };

// GET /api/ai/books - recent AI books for the signed-in user
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Ownership is applied in the query, not by the caller: a list endpoint that
  // filters afterwards leaks the existence of other users' job ids.
  const jobs = await prisma.aiBookJob.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: RECENT_LIMIT,
    select: {
      id: true,
      concept: true,
      status: true,
      stage: true,
      stageOutput: true,
      repairCount: true,
      failureCount: true,
      maxAttempts: true,
      errorMessage: true,
      submissionId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const submissionIds = jobs
    .map((job) => job.submissionId)
    .filter((id): id is string => Boolean(id));
  const submissions = submissionIds.length
    ? await prisma.submission.findMany({
        where: { id: { in: submissionIds } },
        select: { id: true, title: true, status: true, pdfS3Key: true, readingPdfS3Key: true },
      })
    : [];
  const byId = new Map(submissions.map((submission) => [submission.id, submission]));

  const result = jobs.map((job) => {
    const submission = job.submissionId ? byId.get(job.submissionId) : undefined;
    const stageOutput = (job.stageOutput ?? {}) as Record<string, unknown>;
    const phase = deriveAiBookPhase({
      status: job.status,
      stage: job.stage,
      hasQaReport: Boolean(stageOutput.qaReport),
      repairCount: job.repairCount,
      errorMessage: job.errorMessage,
    });
    const approved = submission?.status === "APPROVED";
    return {
      id: job.id,
      concept: job.concept,
      title: submission?.title ?? null,
      submissionId: job.submissionId,
      status: job.status,
      stage: job.stage,
      phase,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      artifacts: {
        approved,
        printSheet: Boolean(submission?.pdfS3Key),
        readingPdf: Boolean(submission?.readingPdfS3Key),
        ready:
          approved && Boolean(submission?.pdfS3Key) && Boolean(submission?.readingPdfS3Key),
      },
    };
  });

  return NextResponse.json({ jobs: result });
}

// POST /api/ai/books - start an autonomous AI book creation job
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request format." }, { status: 400 });
  }

  // A retry of an already-accepted request must not be throttled by the spacing
  // window: it is the same generation, not a new one.
  const known = body.requestKey
    ? await prisma.aiBookJob.findUnique({
        where: { userId_requestKey: { userId, requestKey: body.requestKey } },
        select: { id: true },
      })
    : null;

  if (!known) {
    // Rate limit: at most one enqueue per user per spacing window.
    const rl = await consumeRateLimit(`ai-book:user:${userId}`, BOOK_JOB_SPACING);
    if (!rl.allowed) {
      return tooManyRequests(rl, "Please wait a moment before creating another AI book.");
    }
  }

  try {
    const { jobId, duplicate } = await enqueueAiBookJob(userId, body.concept, body.templateId, {
      requestKey: body.requestKey,
    });
    return NextResponse.json({ jobId, duplicate }, { status: duplicate ? 200 : 202 });
  } catch (err) {
    if (err instanceof AiBookError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("AI book enqueue failed", err);
    return NextResponse.json({ error: "Unable to start AI book creation." }, { status: 500 });
  }
}
