import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionMode, SubmissionStatus } from "@/lib/constants";
import { parseEditorScene } from "@/lib/editor/schema";
import { z } from "zod";

export const dynamic = "force-dynamic";


const updateTemplateSchema = z.object({
  title: z.string().trim().max(120).nullable().optional(),
  status: z.enum(["DRAFT", "APPROVED"]).optional(),
});

// GET /api/admin/templates/[id] - Get template details with elements
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const template = await prisma.submission.findUnique({
    where: { id },
    include: {
      pages: { orderBy: { order: "asc" } },
      templateElements: { orderBy: [{ pageLabel: "asc" }, { order: "asc" }] },
      _count: {
        select: { instances: true },
      },
    },
  });

  if (!template || !template.isTemplate) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  // Parse template elements
  const parsedElements = template.templateElements.map((te) => ({
    id: te.id,
    templateId: te.templateId,
    pageLabel: te.pageLabel,
    order: te.order,
    elementJson: te.elementJson,
  }));

  // Parse pages
  const parsedPages = template.pages.map((page) => ({
    ...page,
    scene: parseEditorScene(page.sceneJson),
  }));

  return NextResponse.json({
    template: {
      id: template.id,
      title: template.title,
      status: template.status,
      version: template.version,
      isTemplate: template.isTemplate,
      publishedAt: template.publishedAt?.toISOString() ?? null,
      createdAt: template.createdAt.toISOString(),
      instanceCount: template._count.instances,
      pages: parsedPages,
      templateElements: parsedElements,
    },
  });
}

// PUT /api/admin/templates/[id] - Update template metadata
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const existing = await prisma.submission.findUnique({
    where: { id },
    select: { id: true, isTemplate: true },
  });

  if (!existing || !existing.isTemplate) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  try {
    const body = await request.json();
    const parsed = updateTemplateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const template = await prisma.submission.update({
      where: { id },
      data: {
        title:
          parsed.data.title === undefined
            ? undefined
            : parsed.data.title || null,
        status: parsed.data.status,
      },
    });

    return NextResponse.json({ template });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// DELETE /api/admin/templates/[id] - Delete template
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const existing = await prisma.submission.findUnique({
    where: { id },
    select: { id: true, isTemplate: true },
  });

  if (!existing || !existing.isTemplate) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  // Check for instances
  const instanceCount = await prisma.submission.count({
    where: { templateId: id },
  });

  // Delete template elements first (cascade should handle this, but be explicit)
  await prisma.templateElement.deleteMany({
    where: { templateId: id },
  });

  await prisma.submission.delete({
    where: { id },
  });

  return NextResponse.json({
    success: true,
    deletedInstanceCount: instanceCount,
  });
}
