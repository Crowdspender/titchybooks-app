import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getPresignedDownloadUrl } from "@/lib/s3";
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

  // The card thumbnail is the cover page preview the render pipeline already
  // produced, so no separate preview path is needed. A template approved
  // without ever being rendered - the seeded starters, for instance - simply
  // has none, and the gallery falls back to its placeholder. URLs are signed
  // per request because they expire.
  const covers = await prisma.submissionPage.findMany({
    where: {
      submissionId: { in: eligible.map((template) => template.id) },
      pageLabel: "FRONT_COVER",
    },
    select: { submissionId: true, previewS3Key: true },
  });
  const coverKeys = new Map<string, string>();
  for (const cover of covers) {
    if (cover.previewS3Key) coverKeys.set(cover.submissionId, cover.previewS3Key);
  }

  const result = await Promise.all(
    eligible.map(async (t) => {
      const coverKey = coverKeys.get(t.id);
      return {
        id: t.id,
        title: t.title,
        previewImage: coverKey ? await getPresignedDownloadUrl(coverKey) : null,
        createdAt: t.createdAt.toISOString(),
      };
    }),
  );

  return NextResponse.json({ templates: result });
}
