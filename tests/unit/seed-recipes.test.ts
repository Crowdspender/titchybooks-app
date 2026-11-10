import { describe, expect, it } from "vitest";
import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import { preflightTemplateRows } from "@/lib/ai/template-preflight";
import { SEED_RECIPES, backgroundFor, elementSeeds, pageSeeds } from "../../prisma/seed-recipes";

/**
 * The starter recipes are the templates an AI book is most likely to run on, so
 * they have to survive the same preflight the catalog and pipeline use. A
 * recipe that fails here would only be noticed as a runtime job failure.
 */

function recipeRows(recipe: (typeof SEED_RECIPES)[number]) {
  return elementSeeds(recipe).map((row) => ({
    pageLabel: row.pageLabel,
    elementJson: row.elementJson,
  }));
}

function recipeBackgrounds(recipe: (typeof SEED_RECIPES)[number]) {
  return new Map<PageLabel, string>(
    PAGE_LABELS.map((label) => [label, backgroundFor(recipe, label)]),
  );
}

describe("starter recipes", () => {
  it("ships the three text-first books the catalog promises", () => {
    expect(SEED_RECIPES.map((recipe) => recipe.key)).toEqual([
      "seed-story-v1",
      "seed-guide-v1",
      "seed-promo-v1",
    ]);
    // Keys are the seed's ownership identity, so they must be unique.
    expect(new Set(SEED_RECIPES.map((recipe) => recipe.key)).size).toBe(SEED_RECIPES.length);
  });

  it.each(SEED_RECIPES.map((recipe) => [recipe.title, recipe] as const))(
    "%s passes AI preflight",
    (_title, recipe) => {
      const { result } = preflightTemplateRows({
        templateId: `test-${recipe.key}`,
        templateVersion: 1,
        rows: recipeRows(recipe),
        pageBackgrounds: recipeBackgrounds(recipe),
      });

      expect(result.issues.map((issue) => `${issue.code} ${issue.pageLabel ?? ""}`)).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  it.each(SEED_RECIPES.map((recipe) => [recipe.title, recipe] as const))(
    "%s lays out all eight pages once",
    (_title, recipe) => {
      const pages = pageSeeds(recipe);
      expect(pages.map((page) => page.pageLabel)).toEqual([...PAGE_LABELS]);
      expect(pages.map((page) => page.order)).toEqual(PAGE_LABELS.map((_, index) => index));
    },
  );

  it.each(SEED_RECIPES.map((recipe) => [recipe.title, recipe] as const))(
    "%s uses element ids that are unique across the book",
    (_title, recipe) => {
      // Content overrides are keyed by element id, so a duplicate would make one
      // slot silently overwrite another.
      const ids = recipe.elements.map((element) => element.id);

      expect(new Set(ids).size).toBe(ids.length);
    },
  );
});
