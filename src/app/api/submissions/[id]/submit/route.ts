import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { SubmissionMode, SubmissionStatus } from "@/lib/constants";
import { parseEditorScene } from "@/lib/editor/schema";
import {
  checkSubmissionResolution,
  type DpiWarning,
} from "@/lib/editor/validation";
import { prisma } from "@/lib/prisma";
import { enqueueRenderJob } from "@/lib/pdf/render-job";

export const dynamic = "force-dynamic";


export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // Check for force flag - allows submission despite DPI hard errors
  let force = false;
  try {
    const body = await request.json().catch(() => null);
    force = body?.force === true;
  } catch {
    // No body is fine
  }

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
    // Parse and validate all scenes
    const parsedPages = submission.pages.map((page) => ({
      pageLabel: page.pageLabel,
      scene: parseEditorScene(page.sceneJson),
    }));

    // --- DPI / Resolution check ---
    // Collect all asset IDs referenced across pages
    const assetIds = Array.from(
      new Set(
        parsedPages.flatMap(({ scene }) =>
          scene.elements
            .filter((el) => el.type === "image")
            .map((el) => el.assetId)
        )
      )
    );

    const assetDimensions = new Map<string, { width: number; height: number }>();
    if (assetIds.length > 0) {
      const assets = await prisma.asset.findMany({
        where: { id: { in: assetIds } },
        select: { id: true, width: true, height: true },
      });
      for (const asset of assets) {
        if (asset.width && asset.height) {
          assetDimensions.set(asset.id, { width: asset.width, height: asset.height });
        }
      }
    }

    const dpiWarnings: DpiWarning[] = checkSubmissionResolution(
      parsedPages,
      assetDimensions
    );

    const hardErrors = dpiWarnings.filter((w) => w.severity === "error");
    if (hardErrors.length > 0 && !force) {
      return NextResponse.json(
        {
          error:
            "Some images have very low resolution and may print poorly. " +
            "Use higher-resolution images or reduce element size.",
          dpiWarnings,
          canForce: true,
        },
        { status: 422 }
      );
    }

    await prisma.submission.update({
      where: { id },
      data: {
        submittedAt: new Date(),
        status: SubmissionStatus.PROCESSING,
      },
    });

    enqueueRenderJob(id).catch((error: unknown) => {
      console.error(`Failed to enqueue render job for submission ${id}:`, error);
    });

    return NextResponse.json({
      success: true,
      submission: {
        id,
        status: SubmissionStatus.PROCESSING,
      },
      dpiWarnings: dpiWarnings.length > 0 ? dpiWarnings : undefined,
    });
  } catch (error) {
    console.error("Editor submission validation failed:", error);
    return NextResponse.json(
      { error: "Editor submission is invalid" },
      { status: 400 }
    );
  }
}
