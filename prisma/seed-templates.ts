import { Prisma, type PrismaClient } from "@prisma/client";
import { PAGE_LABELS, type PageLabel } from "../src/lib/constants";
import { preflightTemplateRows, summarizePreflight } from "../src/lib/ai/template-preflight";
import { SEED_RECIPES, backgroundFor, elementSeeds, pageSeeds } from "./seed-recipes";

/**
 * Seed the three complete text-first starter recipes.
 *
 * Ownership is explicit: a recipe is matched by `managedKey`, so re-seeding
 * updates only its own content. Admin-authored templates have no key and are
 * never overwritten, and the seed no longer bails out just because some other
 * template exists.
 *
 * A recipe is only marked `aiReady` after the shared preflight accepts the rows
 * it just wrote — the same check the pipeline and the catalog use.
 */
export async function seedTemplates(prisma: PrismaClient, adminId: string): Promise<void> {
  for (const recipe of SEED_RECIPES) {
    const pages = pageSeeds(recipe);
    const elements = elementSeeds(recipe);
    const existing = await prisma.submission.findUnique({
      where: { managedKey: recipe.key },
      select: { id: true },
    });

    const template = existing
      ? await prisma.submission.update({
          where: { id: existing.id },
          data: { title: recipe.title, pages: { deleteMany: {}, create: pages } },
        })
      : await prisma.submission.create({
          data: {
            userId: adminId,
            mode: "TEMPLATE",
            title: recipe.title,
            status: "DRAFT",
            isTemplate: true,
            version: 1,
            managedKey: recipe.key,
            pages: { create: pages },
          },
        });

    await prisma.templateElement.deleteMany({ where: { templateId: template.id } });
    await prisma.templateElement.createMany({
      data: elements.map((element) => ({ templateId: template.id, ...element })),
    });

    const rows = await prisma.templateElement.findMany({
      where: { templateId: template.id },
      select: { pageLabel: true, elementJson: true },
    });
    const backgrounds = new Map<PageLabel, string>(
      PAGE_LABELS.map((label) => [label, backgroundFor(recipe, label)]),
    );
    const { result, manifest } = preflightTemplateRows({
      templateId: template.id,
      templateVersion: template.version,
      rows,
      pageBackgrounds: backgrounds,
    });

    await prisma.submission.update({
      where: { id: template.id },
      data: {
        status: result.ok ? "APPROVED" : "DRAFT",
        aiReady: result.ok,
        aiManifest: result.ok ? (manifest as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        publishedAt: result.ok ? new Date() : null,
      },
    });

    if (result.ok) {
      console.log(`Seeded AI-ready template: ${recipe.title}`);
    } else {
      console.error(`Seeded template "${recipe.title}" is not AI-ready: ${summarizePreflight(result)}`);
    }
  }
}
