import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionMode, SubmissionStatus } from "@/lib/constants";
import { createEmptySubmissionPageSeeds } from "@/lib/editor/validation";
import { z } from "zod";

export const dynamic = "force-dynamic";


const createTemplateSchema = z.object({
  title: z.string().trim().max(120).optional(),
});

// GET /api/admin/templates - List all templates
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const templates = await prisma.submission.findMany({
    where: { isTemplate: true },
    select: {
      id: true,
      title: true,
      status: true,
      version: true,
      isTemplate: true,
      publishedAt: true,
      createdAt: true,
      _count: {
        select: { instances: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const result = templates.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    version: t.version,
    isTemplate: t.isTemplate,
    publishedAt: t.publishedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    instanceCount: t._count.instances,
  }));

  return NextResponse.json({ templates: result });
}

// POST /api/admin/templates - Create new template
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const parsed = createTemplateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const emptyPages = createEmptySubmissionPageSeeds();

    const template = await prisma.submission.create({
      data: {
        userId: session.user.id,
        mode: SubmissionMode.TEMPLATE,
        title: parsed.data.title || null,
        status: SubmissionStatus.DRAFT,
        isTemplate: true,
        version: 1,
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
      { template: { id: template.id, status: template.status } },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
