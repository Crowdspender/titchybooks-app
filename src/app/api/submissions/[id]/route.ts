import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { SubmissionMode } from "@/lib/constants";
import { parseEditorScene } from "@/lib/editor/schema";
import { errorResponse, lockSubmission, saveTitle, SubmissionError } from "@/lib/editor/submission-store";
import { requireNoTemplateDependents } from '@/lib/assets/references';

export const dynamic = "force-dynamic";


const updateSubmissionSchema = z.object({
  title: z.string().trim().max(120).nullable(),
  revision: z.number().int().nonnegative(),
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

  const canDownload = submission.status === 'APPROVED' || session.user.role === 'ADMIN';
  const pdfBase = `/api/submissions/${encodeURIComponent(id)}/downloads`;
  const pdfDownloadUrl = canDownload && submission.pdfS3Key ? `${pdfBase}?kind=print` : null;
  const readingPdfDownloadUrl = canDownload && submission.readingPdfS3Key ? `${pdfBase}?kind=reading` : null;

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
    readingPdfDownloadUrl,
    pdfPreviewUrl: pdfDownloadUrl ? `${pdfDownloadUrl}&disposition=inline` : null,
  }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
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

    const submission = await saveTitle(id, { id: session.user.id, role: session.user.role }, parsed.data.title || null, parsed.data.revision);

    return NextResponse.json({ submission });
  } catch (error) {
    return errorResponse(error);
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
    await prisma.$transaction(async (tx) => {
      const current = await lockSubmission(tx, id, { id: session.user.id!, role: session.user.role });
      if (current.status !== "DRAFT") throw new SubmissionError(409, "Only drafts can be deleted");
      if (current.isTemplate) await requireNoTemplateDependents(tx, id);
      await tx.submission.delete({ where: { id } });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
