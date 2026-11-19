import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionMode, SubmissionStatus } from "@/lib/constants";
import { z } from "zod";
import { errorResponse, lockSubmission, mergedPages, SubmissionError, validateSceneAssets } from '@/lib/editor/submission-store';
import { editorSceneSchema } from '@/lib/editor/schema';

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

    const submission = await prisma.$transaction(async tx => {
      const template = await lockSubmission(tx, templateId);
      if (!template.isTemplate || template.status !== SubmissionStatus.APPROVED) {
        throw new SubmissionError(404, 'Template not found or not published');
      }
      await validateSceneAssets(tx, (await mergedPages(tx, template)).map(page => page.scene), { id: session.user.id!, role: session.user.role });
      const pages = await tx.submissionPage.findMany({ where: { submissionId: templateId }, orderBy: { order: 'asc' } });

      // Create instance with page metadata copied from template
      const instancePages = pages.map((page) => {
        // Parse the template page scene to get page metadata
        const templateScene = editorSceneSchema.parse(JSON.parse(page.sceneJson));

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

      return tx.submission.create({
        data: {
          userId: session.user.id!,
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
    }, { timeout: 20000 });

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
  } catch (error) {
    return errorResponse(error);
  }
}
