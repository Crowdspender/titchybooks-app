import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionMode, SubmissionStatus } from "@/lib/constants";
import { createEmptySubmissionPageSeeds } from "@/lib/editor/validation";
import { summarizePreflight } from "@/lib/ai/template-preflight";
import { evaluateTemplateReadiness } from "@/lib/ai/template-readiness";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** How many preflight issues the list returns per template. */
const LISTED_ISSUES = 5;


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
      aiReady: true,
      publishedAt: true,
      createdAt: true,
      pages: { select: { pageLabel: true, sceneJson: true } },
      templateElements: {
        orderBy: { order: "asc" },
        select: { pageLabel: true, elementJson: true },
      },
      _count: {
        select: { instances: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Readiness is evaluated live rather than read from the stored flag: an admin
  // may have edited a published template since, and the row would then claim it
  // is AI-ready when the next job would reject it.
  const readiness = await Promise.all(
    templates.map((t) =>
      evaluateTemplateReadiness({
        templateId: t.id,
        templateVersion: t.version,
        elements: t.templateElements,
        pages: t.pages,
      }),
    ),
  );

  const result = templates.map((t, index) => {
    const { result: preflight } = readiness[index];
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      version: t.version,
      isTemplate: t.isTemplate,
      aiReady: preflight.ok,
      aiSummary: summarizePreflight(preflight),
      aiIssues: preflight.issues.slice(0, LISTED_ISSUES),
      publishedAt: t.publishedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      instanceCount: t._count.instances,
    };
  });

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
