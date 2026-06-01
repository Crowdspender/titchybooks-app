import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseEditorScene } from "@/lib/editor/schema";
import type { EditorElement } from "@/lib/editor/schema";

export const dynamic = "force-dynamic";


// POST /api/submissions/[id]/detach-from-template
// Materializes template elements into the instance as user-owned elements,
// then clears the template linkage. This action cannot be undone.
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
    include: { pages: { orderBy: { order: "asc" } } },
  });

  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (submission.userId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!submission.templateId) {
    return NextResponse.json(
      { error: "This submission is not linked to a template" },
      { status: 400 }
    );
  }

  // Fetch template elements
  const templateElements = await prisma.templateElement.findMany({
    where: { templateId: submission.templateId },
    orderBy: { order: "asc" },
  });

  // Group template elements by page label
  const elementsByPage = new Map<string, EditorElement[]>();
  for (const te of templateElements) {
    const parsed = JSON.parse(te.elementJson) as EditorElement;
    const existing = elementsByPage.get(te.pageLabel) ?? [];
    existing.push(parsed);
    elementsByPage.set(te.pageLabel, existing);
  }

  // Merge template elements into each page's scene
  const updatedPages = submission.pages.map((page) => {
    const userScene = parseEditorScene(page.sceneJson);
    const pageTemplateElements = elementsByPage.get(page.pageLabel) ?? [];

    if (pageTemplateElements.length > 0) {
      // Template elements become user elements
      const mergedScene = {
        ...userScene,
        elements: [...pageTemplateElements, ...userScene.elements],
      };
      return {
        ...page,
        sceneJson: JSON.stringify(mergedScene),
      };
    }

    return page;
  });

  // Update all pages and clear template linkage in a transaction
  await prisma.$transaction(async (tx) => {
    for (const page of updatedPages) {
      await tx.submissionPage.update({
        where: { id: page.id },
        data: { sceneJson: page.sceneJson },
      });
    }

    await tx.submission.update({
      where: { id },
      data: {
        templateId: null,
        templateVersion: null,
      },
    });
  });

  return NextResponse.json({
    success: true,
    message: "Template elements have been materialized into the submission. Template linkage removed.",
  });
}
