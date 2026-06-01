import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getPresignedDownloadUrl } from "@/lib/s3";
import { z } from "zod";
import { SubmissionMode } from "@/lib/constants";
import { parseEditorScene } from "@/lib/editor/schema";

export const dynamic = "force-dynamic";


const updateSubmissionSchema = z.object({
  title: z.string().trim().max(120).nullable().optional(),
});

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
    include: {
      images: { orderBy: { order: "asc" } },
      pages: { orderBy: { order: "asc" } },
    },
  });

  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.userId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let pdfDownloadUrl: string | null = null;
  if (submission.pdfS3Key) {
    pdfDownloadUrl = await getPresignedDownloadUrl(submission.pdfS3Key);
  }

  const hydratedSubmission =
    submission.mode === SubmissionMode.EDITOR || submission.isTemplate
      ? {
          ...submission,
          pages: submission.pages.map((page) => ({
            ...page,
            scene: parseEditorScene(page.sceneJson),
          })),
        }
      : submission;

  return NextResponse.json({
    submission: hydratedSubmission,
    pdfDownloadUrl,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existingSubmission = await prisma.submission.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });

  if (!existingSubmission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (
    existingSubmission.userId !== session.user.id &&
    session.user.role !== "ADMIN"
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const parsed = updateSubmissionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const submission = await prisma.submission.update({
      where: { id },
      data: {
        title:
          parsed.data.title === undefined
            ? undefined
            : parsed.data.title || null,
      },
      include: {
        images: { orderBy: { order: "asc" } },
        pages: { orderBy: { order: "asc" } },
      },
    });

    return NextResponse.json({ submission });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existingSubmission = await prisma.submission.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true },
  });

  if (!existingSubmission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (
    existingSubmission.userId !== session.user.id &&
    session.user.role !== "ADMIN"
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Only allow deletion of DRAFT submissions
  if (existingSubmission.status !== "DRAFT") {
    return NextResponse.json(
      { error: "Only draft submissions can be deleted" },
      { status: 400 }
    );
  }

  try {
    // Delete related pages first
    await prisma.submissionPage.deleteMany({
      where: { submissionId: id },
    });

    // Delete the submission
    await prisma.submission.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
