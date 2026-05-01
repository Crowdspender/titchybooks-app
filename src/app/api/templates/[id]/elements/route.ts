import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";
import type { EditorElement } from "@/lib/editor/schema";

interface TemplateAsset {
  id: string;
  originalFilename: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  downloadUrl: string;
  previewUrl: string;
}

function extractAssetIds(elementJsons: string[]): string[] {
  const ids = new Set<string>();
  for (const json of elementJsons) {
    try {
      const parsed = JSON.parse(json) as { type?: string; assetId?: string };
      if (parsed.type === "image" && typeof parsed.assetId === "string") {
        ids.add(parsed.assetId);
      }
    } catch {
      // skip malformed entries
    }
  }
  return Array.from(ids);
}

async function fetchTemplateAssets(assetIds: string[]): Promise<TemplateAsset[]> {
  if (assetIds.length === 0) return [];
  const assets = await prisma.asset.findMany({
    where: { id: { in: assetIds } },
    select: {
      id: true,
      originalFilename: true,
      mimeType: true,
      width: true,
      height: true,
    },
  });
  return assets.map((asset) => ({
    id: asset.id,
    originalFilename: asset.originalFilename,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    downloadUrl: `/api/assets/${asset.id}/image`,
    previewUrl: `/api/assets/${asset.id}/image`,
  }));
}

// GET /api/templates/[id]/elements
// Returns the template's elements for rendering the locked background layer
// in the instance editor. Authorized when ANY of the following is true:
//   1. Caller is ADMIN.
//   2. Template is APPROVED (publicly usable).
//   3. Caller owns a Submission linked to this template (so they can render
//      their own instance even if the template is later unpublished).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const template = await prisma.submission.findUnique({
    where: { id },
    select: {
      id: true,
      isTemplate: true,
      status: true,
      version: true,
    },
  });

  if (!template || !template.isTemplate) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const isAdmin = session.user.role === "ADMIN";
  const isApproved = template.status === SubmissionStatus.APPROVED;

  let isAuthorized = isAdmin || isApproved;

  if (!isAuthorized) {
    const ownedInstance = await prisma.submission.findFirst({
      where: {
        templateId: id,
        userId: session.user.id,
      },
      select: { id: true },
    });
    isAuthorized = !!ownedInstance;
  }

  if (!isAuthorized) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.templateElement.findMany({
    where: { templateId: id },
    orderBy: [{ pageLabel: "asc" }, { order: "asc" }],
    select: {
      pageLabel: true,
      order: true,
      elementJson: true,
    },
  });

  // Fallback: templates authored before the TemplateElement split-storage
  // migration still keep their elements inside SubmissionPage.sceneJson.
  // If the TemplateElement table is empty, materialize them from sceneJson
  // so non-admin consumers (instances) can still render the template layer.
  if (rows.length === 0) {
    const pages = await prisma.submissionPage.findMany({
      where: { submissionId: id },
      orderBy: { order: "asc" },
      select: { pageLabel: true, sceneJson: true },
    });

    const fallbackRows: Array<{
      pageLabel: string;
      order: number;
      elementJson: string;
    }> = [];

    for (const page of pages) {
      let parsed: { elements?: unknown } | null = null;
      try {
        parsed = JSON.parse(page.sceneJson) as { elements?: unknown };
      } catch {
        continue;
      }

      const elements = Array.isArray(parsed?.elements)
        ? (parsed.elements as EditorElement[])
        : [];

      elements.forEach((el, index) => {
        fallbackRows.push({
          pageLabel: page.pageLabel,
          order: index,
          elementJson: JSON.stringify(el),
        });
      });
    }

    const fallbackAssetIds = extractAssetIds(
      fallbackRows.map((r) => r.elementJson),
    );
    const fallbackAssets = await fetchTemplateAssets(fallbackAssetIds);

    return NextResponse.json({
      templateId: template.id,
      templateVersion: template.version,
      templateElements: fallbackRows,
      templateAssets: fallbackAssets,
    });
  }

  const assetIds = extractAssetIds(rows.map((r) => r.elementJson));
  const templateAssets = await fetchTemplateAssets(assetIds);

  return NextResponse.json({
    templateId: template.id,
    templateVersion: template.version,
    templateElements: rows,
    templateAssets,
  });
}
