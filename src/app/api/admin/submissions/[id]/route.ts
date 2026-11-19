import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";
import { z } from "zod";
import { errorResponse, lockSubmission, SubmissionError } from "@/lib/editor/submission-store";

export const dynamic = "force-dynamic";


const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("APPROVE") }).strict(),
  z.object({
    action: z.literal("REJECT"),
    rejectionReason: z.string().trim().min(10, "Explain the required correction in 10–1000 characters").max(1000),
  }).strict(),
]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Sign in to review submissions" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const operator = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
    if (operator?.role !== "ADMIN") {
      return NextResponse.json({ error: "Administrator access is required" }, { status: 403 });
    }
    const body = await request.json();
    const parsed = actionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const action = parsed.data.action;
    const rejectionReason = parsed.data.action === "REJECT" ? parsed.data.rejectionReason : null;

    const updated = await prisma.$transaction(async (tx) => {
      const submission = await lockSubmission(tx, id);
      if (submission.status !== "PENDING" || !submission.pdfS3Key) {
        throw new SubmissionError(409, "Only rendered submissions awaiting review can be moderated; reload the list before retrying");
      }
      return tx.submission.update({
        where: { id },
        data: {
          status: action === "APPROVE" ? SubmissionStatus.APPROVED : SubmissionStatus.REJECTED,
          rejectionReason,
        },
      });
    });

    return NextResponse.json({ submission: updated });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request JSON" }, { status: 400 });
    return errorResponse(error);
  }
}
