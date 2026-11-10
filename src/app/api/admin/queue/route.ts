import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { collectQueueHealth } from "@/lib/queue-health";

// Admin queue operations view: health report, recent terminal failures, and
// drain-run history. Read-only; recovery actions stay in the existing admin
// submission/order tools.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [health, failedAiJobs, failedRenderJobs, recentRuns] = await Promise.all([
    collectQueueHealth(),
    prisma.aiBookJob.findMany({
      where: { status: "FAILED" },
      orderBy: { completedAt: { sort: "desc", nulls: "last" } },
      take: 20,
      select: {
        id: true,
        concept: true,
        stage: true,
        attempts: true,
        maxAttempts: true,
        errorMessage: true,
        completedAt: true,
        createdAt: true,
        submissionId: true,
        user: { select: { email: true, name: true } },
        submission: { select: { title: true } },
      },
    }),
    prisma.renderJob.findMany({
      where: { status: "FAILED" },
      orderBy: { completedAt: { sort: "desc", nulls: "last" } },
      take: 20,
      select: {
        id: true,
        attempts: true,
        maxAttempts: true,
        errorMessage: true,
        completedAt: true,
        createdAt: true,
        submissionId: true,
        submission: {
          select: { title: true, user: { select: { email: true, name: true } } },
        },
      },
    }),
    prisma.queueDrainRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 20,
    }),
  ]);

  return NextResponse.json({ health, failedAiJobs, failedRenderJobs, recentRuns });
}
