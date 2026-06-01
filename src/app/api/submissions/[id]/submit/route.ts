import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { SubmissionMode, SubmissionStatus } from "@/lib/constants";
import { parseEditorScene } from "@/lib/editor/schema";
import { prisma } from "@/lib/prisma";
import { generateTitchybookPdf } from "@/lib/pdf/generate";

export const dynamic = "force-dynamic";


export async function POST(
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
    include: {
      pages: { orderBy: { order: "asc" } },
    },
  });

  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.userId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (submission.mode !== SubmissionMode.EDITOR) {
    return NextResponse.json(
      { error: "Only editor drafts can be submitted with this endpoint" },
      { status: 400 }
    );
  }

  if (submission.pages.length !== 8) {
    return NextResponse.json(
      { error: "All 8 pages are required before submission" },
      { status: 400 }
    );
  }

  try {
    for (const page of submission.pages) {
      parseEditorScene(page.sceneJson);
    }

    await prisma.submission.update({
      where: { id },
      data: {
        submittedAt: new Date(),
        status: SubmissionStatus.PROCESSING,
      },
    });

    generateTitchybookPdf(id).catch((error) => {
      console.error(`Editor PDF generation failed for submission ${id}:`, error);
    });

    return NextResponse.json({
      success: true,
      submission: {
        id,
        status: SubmissionStatus.PROCESSING,
      },
    });
  } catch (error) {
    console.error("Editor submission validation failed:", error);
    return NextResponse.json(
      { error: "Editor submission is invalid" },
      { status: 400 }
    );
  }
}
