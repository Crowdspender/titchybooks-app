import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// GET /api/ai/books/:id - poll the status of an autonomous AI book job
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

  const stageOutput = (job.stageOutput ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    id: job.id,
    status: job.status,
    stage: job.stage,
    submissionId: job.submissionId,
    errorMessage: job.errorMessage,
    qaReport: stageOutput.qaReport ?? null,
  });
}
