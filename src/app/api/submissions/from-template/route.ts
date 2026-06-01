import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionMode, SubmissionStatus } from "@/lib/constants";
import { createEmptySubmissionPageSeeds } from "@/lib/editor/validation";
import { z } from "zod";

export const dynamic = "force-dynamic";


const fromTemplateSchema = z.object({
  templateId: z.string().min(1),
});

// POST /api/submissions/from-template - Create instance from template
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = fromTemplateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const { templateId } = parsed.data;

    // Fetch the template
    const template = await prisma.submission.findUnique({
      where: { id: templateId },
      include: { pages: { orderBy: { order: "asc" } } },
    });

    if (!template || !template.isTemplate || template.status !== SubmissionStatus.APPROVED) {
      return NextResponse.json(
        { error: "Template not found or not published" },
        { status: 404 },
      );
    }

    // Create instance with page metadata copied from template
    const instancePages = template.pages.map((page) => {
      // Parse the template page scene to get page metadata
      const templateScene = JSON.parse(page.sceneJson) as {
        version: number;
        page: { widthPx: number; heightPx: number; backgroundColor: string };
        elements: unknown[];
      };

      // Create a new scene with the same page metadata but empty elements
      const instanceScene = {
        version: templateScene.version,
        page: templateScene.page,
        elements: [], // User starts with an empty user layer
      };

      return {
        pageLabel: page.pageLabel,
        order: page.order,
        sceneJson: JSON.stringify(instanceScene),
      };
    });

    const submission = await prisma.submission.create({
      data: {
        userId: session.user.id,
        mode: SubmissionMode.EDITOR,
        title: template.title ? `${template.title} (copy)` : null,
        status: SubmissionStatus.DRAFT,
        templateId: template.id,
        templateVersion: template.version,
        pages: {
          create: instancePages,
        },
      },
    });

    return NextResponse.json(
      {
        submission: {
          id: submission.id,
          templateId: submission.templateId,
          templateVersion: submission.templateVersion,
          status: submission.status,
        },
      },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
