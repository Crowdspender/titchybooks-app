import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";
import { summarizePreflight } from "@/lib/ai/template-preflight";
import { evaluateTemplateReadiness } from "@/lib/ai/template-readiness";

export const dynamic = "force-dynamic";

const publishSchema = z.object({
  /**
   * Refuse the publication itself when the template cannot back AI generation.
   * Manual-only publication leaves this unset: the template is still usable by
   * the editor, it just never appears in AI selection.
   */
  requireAiReady: z.boolean().optional(),
});

// POST /api/admin/templates/[id]/publish - Publish a template
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const parsed = publishSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const existing = await prisma.submission.findUnique({
    where: { id },
    select: {
      id: true,
      isTemplate: true,
      version: true,
      pages: { select: { pageLabel: true, sceneJson: true } },
      templateElements: {
        orderBy: { order: "asc" },
        select: { pageLabel: true, elementJson: true },
      },
    },
  });

  if (!existing || !existing.isTemplate) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const version = existing.version + 1;
  const { result, manifest } = await evaluateTemplateReadiness({
    templateId: existing.id,
    templateVersion: version,
    elements: existing.templateElements,
    pages: existing.pages,
  });

  if (!result.ok && parsed.data.requireAiReady) {
    // Nothing is published: the admin asked for AI readiness and the template
    // cannot deliver it, so the issues name exactly what to fix.
    return NextResponse.json(
      { error: summarizePreflight(result), issues: result.issues },
      { status: 422 },
    );
  }

  const template = await prisma.submission.update({
    where: { id },
    data: {
      status: SubmissionStatus.APPROVED,
      publishedAt: new Date(),
      version,
      // Readiness always describes the version being published, so a template
      // that regressed stops being an AI candidate immediately.
      aiReady: result.ok,
      aiManifest: result.ok ? (manifest as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    },
    select: { id: true, status: true, version: true, aiReady: true },
  });

  return NextResponse.json({
    template,
    readiness: {
      ok: result.ok,
      summary: summarizePreflight(result),
      issues: result.issues,
    },
  });
}
