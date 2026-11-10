import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";
import { evaluateTemplateReadiness } from "@/lib/ai/template-readiness";

export const dynamic = "force-dynamic";

/**
 * GET /api/templates/public - List published templates for users
 *
 * `?ai=1` narrows the list to templates the autonomous pipeline can actually
 * finish, using the same readiness check as publication and job selection.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const onlyAiReady = new URL(request.url).searchParams.get("ai") === "1";

  const templates = await prisma.submission.findMany({
    where: {
      isTemplate: true,
      status: SubmissionStatus.APPROVED,
      // A stored readiness flag is a hint, but it can be stale after an admin
      // edit; the readiness check below is what actually decides.
      ...(onlyAiReady ? { aiReady: true } : {}),
    },
    select: {
      id: true,
      title: true,
      version: true,
      createdAt: true,
      ...(onlyAiReady
        ? {
            pages: { select: { pageLabel: true, sceneJson: true } },
            templateElements: { select: { pageLabel: true, elementJson: true } },
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  const eligible = onlyAiReady
    ? (
        await Promise.all(
          templates.map(async (template) => {
            const withRows = template as typeof template & {
              pages: Array<{ pageLabel: string; sceneJson: string }>;
              templateElements: Array<{ pageLabel: string; elementJson: string }>;
            };
            const { result } = await evaluateTemplateReadiness({
              templateId: template.id,
              templateVersion: template.version,
              elements: withRows.templateElements,
              pages: withRows.pages,
            });
            return result.ok ? template : null;
          }),
        )
      ).filter((template): template is (typeof templates)[number] => template !== null)
    : templates;

  const result = eligible.map((t) => ({
    id: t.id,
    title: t.title,
    previewImage: null as string | null, // TODO: generate preview images
    createdAt: t.createdAt.toISOString(),
  }));

  return NextResponse.json({ templates: result });
}
