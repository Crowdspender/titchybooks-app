import { prisma } from "@/lib/prisma";
import type { PageLabel } from "@/lib/constants";
import { buildManifestFromRows, type AiTemplateManifest } from "./template-contract";
import { pageBackgroundsFromScenes, preflightTemplateRows, type PreflightResult } from "./template-preflight";

/**
 * Single definition of "this template can back an AI book".
 *
 * Publication, the admin list, explicit selection and automatic selection all
 * call this, so a template cannot be published as AI-ready and then rejected at
 * generation time (or the other way round). The check is pure apart from one
 * asset-existence query, and it never mutates anything.
 */
export interface TemplateReadiness {
  result: PreflightResult;
  manifest: AiTemplateManifest;
  /** Page colours read from the persisted scenes. */
  backgrounds: Map<PageLabel, string>;
  /** Assets the template's artwork references, in first-seen order. */
  assetIds: string[];
}

export async function evaluateTemplateReadiness(input: {
  templateId: string;
  templateVersion: number;
  elements: Array<{ pageLabel: string; elementJson: string }>;
  pages: Array<{ pageLabel: string; sceneJson: string }>;
}): Promise<TemplateReadiness> {
  const backgrounds = pageBackgroundsFromScenes(input.pages);
  const rows = {
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    rows: input.elements,
    pageBackgrounds: backgrounds,
  };

  // An image element is only usable if its asset row still exists; preflight
  // then reports the missing ones by page and element.
  const { manifest: preview } = buildManifestFromRows(rows);
  const assetIds = [
    ...new Set(preview.pages.flatMap((page) => page.images.map((image) => image.assetId))),
  ];
  const knownAssetIds =
    assetIds.length === 0
      ? undefined
      : new Set(
          (
            await prisma.asset.findMany({
              where: { id: { in: assetIds } },
              select: { id: true },
            })
          ).map((asset) => asset.id),
        );

  const { result, manifest } = preflightTemplateRows(rows, { knownAssetIds });
  return { result, manifest, backgrounds, assetIds };
}
