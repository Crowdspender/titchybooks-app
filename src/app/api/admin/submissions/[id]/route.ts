import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";
import { z } from "zod";
import { errorResponse, lockSubmission, SubmissionError } from "@/lib/editor/submission-store";

export const dynamic = "force-dynamic";


const actionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  rejectionReason: z.string().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const body = await request.json();
    const parsed = actionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { action, rejectionReason } = parsed.data;

    const updated = await prisma.$transaction(async (tx) => {
    const submission = await lockSubmission(tx, id);
    if (submission.status !== "PENDING" || !submission.pdfS3Key) {
      throw new SubmissionError(409, "Only rendered submissions awaiting review can be moderated");
    }
    return tx.submission.update({
      where: { id },
      data: {
        status:
          action === "APPROVE"
            ? SubmissionStatus.APPROVED
            : SubmissionStatus.REJECTED,
        rejectionReason: action === "REJECT" ? rejectionReason : null,
      },
    });
    });

    return NextResponse.json({ submission: updated });
  } catch (error) {
    return errorResponse(error);
  }
}
