import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { enqueueInTransaction } from "@/lib/pdf/render-job";
import { errorResponse, SubmissionError } from "@/lib/editor/submission-store";
import {
  PAGE_LABELS,
  SubmissionMode,
  SubmissionStatus,
  MAX_FILE_SIZE,
} from "@/lib/constants";
import { headS3Object } from "@/lib/s3";
import { consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";
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

  // Durable per-user cap on submission creation.
  const rl = await consumeRateLimit(`submission:user:${session.user.id}`, {
    limit: 20,
    windowMs: 60 * 60_000,
  });
  if (!rl.allowed) {
    return tooManyRequests(rl, "Too many submissions - please try again later.");
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

    if (images.some(image => !image.s3Key.startsWith(`uploads/${session.user.id}/`))) {
      throw new SubmissionError(403, "An uploaded image belongs to another account");
    }

    // Verify the uploaded objects server-side: presigned PUTs are open to the
    // client for their validity window, so confirm each key exists, is
    // non-empty, and stays within MAX_FILE_SIZE before accepting them.
    const uploads = await Promise.all(images.map((img) => headS3Object(img.s3Key)));
    for (const [i, head] of uploads.entries()) {
      const pageLabel = images[i].pageLabel;
      if (!head) {
        return NextResponse.json(
          { error: `The upload for ${pageLabel} is missing. Please upload it again.` },
          { status: 400 }
        );
      }
      if (head.size === 0 || head.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `The upload for ${pageLabel} must be between 1 byte and ${MAX_FILE_SIZE / (1024 * 1024)} MB.` },
          { status: 400 }
        );
      }
    }

    const actor = { id: session.user.id, role: session.user.role };
    const result = await prisma.$transaction(async (tx) => {
    const submission = await tx.submission.create({
      data: {
        userId: actor.id,
        status: SubmissionStatus.DRAFT,
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

    return enqueueInTransaction(tx, submission.id, actor);
    });

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
