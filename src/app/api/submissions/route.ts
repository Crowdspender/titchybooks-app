import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { generateTitchybookPdf } from "@/lib/pdf/generate";
import {
  PAGE_LABELS,
  SubmissionMode,
  SubmissionStatus,
} from "@/lib/constants";
import { createEmptySubmissionPageSeeds } from "@/lib/editor/validation";

export const dynamic = "force-dynamic";


const imageEntrySchema = z.object({
  pageLabel: z.enum(PAGE_LABELS),
  s3Key: z.string().min(1),
  order: z.number().int().min(0).max(7),
  originalFilename: z.string().min(1),
  mimeType: z.string().min(1),
});

const createSubmissionSchema = z.object({
  images: z.array(imageEntrySchema).length(8),
});

const createEditorDraftSchema = z.object({
  mode: z.enum([SubmissionMode.EDITOR, SubmissionMode.TEMPLATE]),
  title: z.string().trim().max(120).optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const submissions = await prisma.submission.findMany({
    where: { userId: session.user.id, isTemplate: false },
    include: {
      images: { orderBy: { order: "asc" } },
      pages: { orderBy: { order: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ submissions });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    if (body?.mode === SubmissionMode.EDITOR || body?.mode === SubmissionMode.TEMPLATE) {
      const parsedEditorDraft = createEditorDraftSchema.safeParse(body);

      if (!parsedEditorDraft.success) {
        return NextResponse.json(
          { error: parsedEditorDraft.error.issues[0].message },
          { status: 400 }
        );
      }

      const { title, mode } = parsedEditorDraft.data;
      const emptyPages = createEmptySubmissionPageSeeds();

      const submission = await prisma.submission.create({
        data: {
          userId: session.user.id,
          mode,
          title: title || null,
          status: SubmissionStatus.DRAFT,
          isTemplate: mode === SubmissionMode.TEMPLATE,
          pages: {
            create: emptyPages.map((page) => ({
              pageLabel: page.pageLabel,
              order: page.order,
              sceneJson: page.sceneJson,
            })),
          },
        },
        include: { pages: { orderBy: { order: "asc" } } },
      });

      return NextResponse.json(
        { submission: { id: submission.id, status: submission.status } },
        { status: 201 }
      );
    }

    const parsed = createSubmissionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { images } = parsed.data;

    // Verify all 8 page labels are present
    const labels = new Set(images.map((img) => img.pageLabel));
    if (labels.size !== 8) {
      return NextResponse.json(
        { error: "All 8 unique page labels are required" },
        { status: 400 }
      );
    }

    // Create submission with images in a transaction
    const submission = await prisma.submission.create({
      data: {
        userId: session.user.id,
        images: {
          create: images.map((img) => ({
            pageLabel: img.pageLabel,
            s3Key: img.s3Key,
            order: img.order,
            originalFilename: img.originalFilename,
            mimeType: img.mimeType,
          })),
        },
      },
      include: { images: true },
    });

    // Generate PDF asynchronously (don't await - let it run in background)
    generateTitchybookPdf(submission.id).catch((err) => {
      console.error(`PDF generation failed for submission ${submission.id}:`, err);
    });

    return NextResponse.json(
      { submission: { id: submission.id, status: submission.status } },
      { status: 201 }
    );
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
