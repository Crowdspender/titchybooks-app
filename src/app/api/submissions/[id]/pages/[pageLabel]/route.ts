import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { SubmissionMode } from "@/lib/constants";
import {
  editorPageLabelSchema,
  parseEditorScene,
  type EditorElement,
  type EditorScene,
} from "@/lib/editor/schema";
import { validateEditorScene } from "@/lib/editor/validation";
import { EDITOR_MAX_ELEMENTS_PER_PAGE } from "@/lib/editor/constants";
import { prisma } from "@/lib/prisma";

const updateSubmissionPageSchema = z.object({
  scene: z.unknown(),
});

async function getAuthorizedEditorSubmission(
  submissionId: string,
  userId: string,
  role: string
) {
  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      mode: true,
      userId: true,
      isTemplate: true,
      templateId: true,
    },
  });

  if (!submission) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  if (submission.userId !== userId && role !== "ADMIN") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  if (submission.mode !== SubmissionMode.EDITOR && !submission.isTemplate) {
    return {
      error: NextResponse.json(
        { error: "Submission is not an editor draft" },
        { status: 400 }
      ),
    };
  }

  return { submission };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; pageLabel: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, pageLabel: rawPageLabel } = await params;
  const parsedPageLabel = editorPageLabelSchema.safeParse(rawPageLabel);

  if (!parsedPageLabel.success) {
    return NextResponse.json({ error: "Invalid page label" }, { status: 400 });
  }

  const access = await getAuthorizedEditorSubmission(
    id,
    session.user.id,
    session.user.role
  );

  if (access.error) {
    return access.error;
  }

  const page = await prisma.submissionPage.findUnique({
    where: {
      submissionId_pageLabel: {
        submissionId: id,
        pageLabel: parsedPageLabel.data,
      },
    },
  });

  if (!page) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  // Return TemplateElement rows when either:
  //  - this submission IS a template (return its own template elements), or
  //  - this submission is an instance linked to a template (return linked template's elements).
  let templateElements: Array<{ pageLabel: string; elementJson: string }> = [];
  const templateIdForElements = access.submission.isTemplate
    ? access.submission.id
    : access.submission.templateId;

  if (templateIdForElements) {
    templateElements = await prisma.templateElement.findMany({
      where: {
        templateId: templateIdForElements,
        pageLabel: parsedPageLabel.data,
      },
      orderBy: { order: "asc" },
      select: {
        pageLabel: true,
        elementJson: true,
      },
    });
  }

  return NextResponse.json({
    page: {
      ...page,
      scene: parseEditorScene(page.sceneJson),
    },
    templateElements,
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; pageLabel: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, pageLabel: rawPageLabel } = await params;
  const parsedPageLabel = editorPageLabelSchema.safeParse(rawPageLabel);

  if (!parsedPageLabel.success) {
    return NextResponse.json({ error: "Invalid page label" }, { status: 400 });
  }

  const access = await getAuthorizedEditorSubmission(
    id,
    session.user.id,
    session.user.role
  );

  if (access.error) {
    return access.error;
  }

  const submission = access.submission;

  try {
    const body = await request.json();
    const parsedBody = updateSubmissionPageSchema.safeParse(body);

    if (!parsedBody.success) {
      return NextResponse.json(
        { error: parsedBody.error.issues[0].message },
        { status: 400 }
      );
    }

    const scene = validateEditorScene(parsedBody.data.scene);
    const order = editorPageLabelSchema.options.indexOf(parsedPageLabel.data);

    // ---------------------------------------------------------------------
    // Template branch: persist elements to TemplateElement; keep only page
    // metadata in sceneJson (elements: []). Bump template version.
    // templateTextOverrides are instance-only and are stripped here.
    // ---------------------------------------------------------------------
    if (submission.isTemplate) {
      const metadataOnlyScene = {
        version: scene.version,
        page: scene.page,
        elements: [] as EditorElement[],
      };
      const elementRows = scene.elements.map((element, index) => ({
        templateId: id,
        pageLabel: parsedPageLabel.data,
        order: index,
        elementJson: JSON.stringify(element),
      }));

      const result = await prisma.$transaction(async (tx) => {
        await tx.templateElement.deleteMany({
          where: { templateId: id, pageLabel: parsedPageLabel.data },
        });

        if (elementRows.length > 0) {
          await tx.templateElement.createMany({ data: elementRows });
        }

        const upserted = await tx.submissionPage.upsert({
          where: {
            submissionId_pageLabel: {
              submissionId: id,
              pageLabel: parsedPageLabel.data,
            },
          },
          update: {
            sceneJson: JSON.stringify(metadataOnlyScene),
          },
          create: {
            submissionId: id,
            pageLabel: parsedPageLabel.data,
            order,
            sceneJson: JSON.stringify(metadataOnlyScene),
          },
        });

        await tx.submission.update({
          where: { id },
          data: { version: { increment: 1 } },
        });

        return upserted;
      });

      return NextResponse.json({ page: result });
    }

    // ---------------------------------------------------------------------
    // Instance branch: reject any template-element IDs in payload, enforce
    // combined cap, validate templateTextOverrides against template text
    // elements, persist user slice only.
    // ---------------------------------------------------------------------
    if (submission.templateId) {
      const templateRows = await prisma.templateElement.findMany({
        where: {
          templateId: submission.templateId,
          pageLabel: parsedPageLabel.data,
        },
        select: { elementJson: true },
      });

      const templateElementIds = new Set<string>();
      const templateTextElementIds = new Set<string>();
      for (const row of templateRows) {
        try {
          const parsed = JSON.parse(row.elementJson) as EditorElement;
          if (parsed?.id) {
            templateElementIds.add(parsed.id);
            if (parsed.type === "text") {
              templateTextElementIds.add(parsed.id);
            }
          }
        } catch {
          // Skip malformed rows; they will not match anything.
        }
      }

      const collidesWithTemplate = scene.elements.some((element) =>
        templateElementIds.has(element.id)
      );

      if (collidesWithTemplate) {
        return NextResponse.json(
          { error: "Template elements cannot be modified by the instance" },
          { status: 400 }
        );
      }

      if (
        templateRows.length + scene.elements.length >
        EDITOR_MAX_ELEMENTS_PER_PAGE
      ) {
        return NextResponse.json(
          {
            error: `Combined template + user elements exceed per-page limit of ${EDITOR_MAX_ELEMENTS_PER_PAGE}`,
          },
          { status: 400 }
        );
      }

      // Validate that every templateTextOverride key references an existing
      // template element of type "text" on this page. Unknown keys are
      // rejected so stale overrides cannot silently accumulate.
      if (scene.templateTextOverrides) {
        for (const key of Object.keys(scene.templateTextOverrides)) {
          if (!templateTextElementIds.has(key)) {
            return NextResponse.json(
              {
                error:
                  "Template text override references a non-text or non-template element",
              },
              { status: 400 }
            );
          }
        }
      }
    }

    // ---------------------------------------------------------------------
    // Plain EDITOR (and validated instance) branch: persist scene as-is.
    // For plain (non-instance) editor drafts, strip templateTextOverrides
    // since they only make sense when a template layer is present.
    // ---------------------------------------------------------------------
    const sceneToPersist: EditorScene = submission.templateId
      ? scene
      : {
        version: scene.version,
        page: scene.page,
        elements: scene.elements,
      };

    const page = await prisma.submissionPage.upsert({
      where: {
        submissionId_pageLabel: {
          submissionId: id,
          pageLabel: parsedPageLabel.data,
        },
      },
      update: {
        sceneJson: JSON.stringify(sceneToPersist),
      },
      create: {
        submissionId: id,
        pageLabel: parsedPageLabel.data,
        order,
        sceneJson: JSON.stringify(sceneToPersist),
      },
    });

    return NextResponse.json({ page });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || "Invalid editor scene" },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
