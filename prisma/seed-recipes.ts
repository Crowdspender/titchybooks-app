import { PAGE_LABELS, type PageLabel } from "../src/lib/constants";
import {
  BACK_COVER_BRAND_TEXT,
  EDITOR_DEFAULT_BACKGROUND_COLOR,
  EDITOR_PAGE_HEIGHT_PX,
  EDITOR_PAGE_WIDTH_PX,
  EDITOR_SCENE_VERSION,
} from "../src/lib/editor/constants";

/**
 * Starter recipes for the autonomous pipeline.
 *
 * Each recipe is a complete, text-first book: a title on the front cover, a
 * substantive slot on all six interior pages, generated closing copy plus the
 * fixed branding strip on the back cover. Element ids are stable strings (not
 * TemplateElement row ids) because that is the identity the content plan and
 * text overrides reference.
 *
 * Furniture (kickers, rules, branding) is `locked`, so it is design rather than
 * a slot the model may rewrite.
 */

export interface SeedTextElement {
  kind: "text";
  id: string;
  pageLabel: PageLabel;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
  color: string;
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  locked: boolean;
}

export interface SeedShapeElement {
  kind: "shape";
  id: string;
  pageLabel: PageLabel;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: "rect" | "circle" | "line";
  fill: string;
  stroke?: string;
  strokeWidth?: number;
}

export type SeedElement = SeedTextElement | SeedShapeElement;

export interface SeedRecipe {
  /** Stable ownership key; re-seeding updates only rows carrying it. */
  key: string;
  title: string;
  background: Partial<Record<PageLabel, string>>;
  elements: SeedElement[];
}

const INTERIOR_PAGES: PageLabel[] = PAGE_LABELS.filter(
  (label) => label !== "FRONT_COVER" && label !== "BACK_COVER",
);

const PAGE_X = 60;
const PAGE_WIDTH = EDITOR_PAGE_WIDTH_PX - PAGE_X * 2;

function text(spec: Omit<SeedTextElement, "kind" | "locked"> & { locked?: boolean }): SeedTextElement {
  return { kind: "text", locked: spec.locked ?? false, ...spec };
}

function rule(spec: {
  id: string;
  pageLabel: PageLabel;
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
}): SeedShapeElement {
  return { kind: "shape", shape: "line", fill: "transparent", ...spec };
}

function brandedCover(pageLabel: PageLabel, color: string, y = 948): SeedTextElement {
  return text({
    id: "brand-strip",
    pageLabel,
    x: PAGE_X,
    y,
    width: PAGE_WIDTH,
    height: 32,
    text: BACK_COVER_BRAND_TEXT,
    fontSize: 18,
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: 2,
    color,
    align: "center",
    verticalAlign: "middle",
    locked: true,
  });
}

function bodyPages(prefix: string, spec: { color: string; heading?: boolean; headingColor?: string }): SeedElement[] {
  return INTERIOR_PAGES.flatMap((pageLabel, index) => {
    const key = pageLabel.toLowerCase().replace("_", "");
    const elements: SeedElement[] = [];
    if (spec.heading) {
      elements.push(
        text({
          id: `${prefix}-${key}-heading`,
          pageLabel,
          x: PAGE_X,
          y: 80,
          width: PAGE_WIDTH,
          height: 100,
          text: `Chapter ${index + 1}`,
          fontSize: 28,
          fontWeight: 700,
          lineHeight: 1.3,
          letterSpacing: 0,
          color: spec.headingColor ?? spec.color,
          align: "left",
          verticalAlign: "top",
          locked: false,
        }),
      );
    }
    elements.push(
      text({
        id: `${prefix}-${key}-body`,
        pageLabel,
        x: PAGE_X,
        y: spec.heading ? 210 : 110,
        width: PAGE_WIDTH,
        height: spec.heading ? 560 : 620,
        text: "Write the content for this page.",
        // 28 scene px is ~8.4 pt on the 74 mm reading page, comfortably above
        // the 8 pt print minimum the preflight enforces.
        fontSize: 28,
        fontWeight: 400,
        lineHeight: 1.5,
        letterSpacing: 0,
        color: spec.color,
        align: "left",
        verticalAlign: "top",
        locked: false,
      }),
    );
    return elements;
  });
}

/** Story: one continuous narrative, warm paper, large display title. */
const story: SeedRecipe = {
  key: "seed-story-v1",
  title: "Story Book",
  background: { FRONT_COVER: "#fdf7ee", BACK_COVER: "#fdf7ee" },
  elements: [
    text({
      id: "story-cover-kicker",
      pageLabel: "FRONT_COVER",
      x: PAGE_X,
      y: 120,
      width: PAGE_WIDTH,
      height: 40,
      text: "TITCHYBOOKS",
      fontSize: 17,
      fontWeight: 600,
      lineHeight: 1.2,
      letterSpacing: 5,
      color: "#b45309",
      align: "left",
      verticalAlign: "middle",
      locked: true,
    }),
    text({
      id: "story-cover-title",
      pageLabel: "FRONT_COVER",
      x: PAGE_X,
      y: 200,
      width: PAGE_WIDTH,
      height: 280,
      text: "The Lantern and the Sea",
      fontSize: 52,
      fontWeight: 800,
      lineHeight: 1.15,
      letterSpacing: 0,
      color: "#3f2d1d",
      align: "left",
      verticalAlign: "top",
      locked: false,
    }),
    rule({ id: "story-cover-rule", pageLabel: "FRONT_COVER", x: PAGE_X, y: 520, width: 140, height: 6, stroke: "#d97706" }),
    ...bodyPages("story", { color: "#3f2d1d" }),
    text({
      id: "story-back-closing",
      pageLabel: "BACK_COVER",
      x: PAGE_X,
      y: 110,
      width: PAGE_WIDTH,
      height: 560,
      text: "The end.",
      fontSize: 28,
      fontWeight: 400,
      lineHeight: 1.5,
      letterSpacing: 0,
      color: "#3f2d1d",
      align: "left",
      verticalAlign: "top",
      locked: false,
    }),
    brandedCover("BACK_COVER", "#b45309"),
  ],
};

/** Informational guide: heading plus body on every interior page. */
const guide: SeedRecipe = {
  key: "seed-guide-v1",
  title: "Field Guide",
  background: { FRONT_COVER: "#0f172a", BACK_COVER: "#0f172a" },
  elements: [
    text({
      id: "guide-cover-kicker",
      pageLabel: "FRONT_COVER",
      x: PAGE_X,
      y: 140,
      width: PAGE_WIDTH,
      height: 40,
      text: "A PRACTICAL GUIDE",
      fontSize: 17,
      fontWeight: 600,
      lineHeight: 1.2,
      letterSpacing: 4,
      color: "#93c5fd",
      align: "left",
      verticalAlign: "middle",
      locked: true,
    }),
    text({
      id: "guide-cover-title",
      pageLabel: "FRONT_COVER",
      x: PAGE_X,
      y: 320,
      width: PAGE_WIDTH,
      height: 260,
      text: "A Field Guide",
      fontSize: 46,
      fontWeight: 700,
      lineHeight: 1.2,
      letterSpacing: 0,
      color: "#f8fafc",
      align: "left",
      verticalAlign: "top",
      locked: false,
    }),
    rule({ id: "guide-cover-rule", pageLabel: "FRONT_COVER", x: PAGE_X, y: 640, width: 120, height: 4, stroke: "#38bdf8" }),
    ...bodyPages("guide", { color: "#1e293b", heading: true, headingColor: "#0f172a" }),
    text({
      id: "guide-back-closing",
      pageLabel: "BACK_COVER",
      x: PAGE_X,
      y: 180,
      width: PAGE_WIDTH,
      height: 560,
      text: "Where to go next.",
      fontSize: 28,
      fontWeight: 400,
      lineHeight: 1.5,
      letterSpacing: 0,
      color: "#e2e8f0",
      align: "left",
      verticalAlign: "top",
      locked: false,
    }),
    brandedCover("BACK_COVER", "#93c5fd"),
  ],
};

/** Promotional booklet: poster cover with a subtitle, short punchy pages. */
const promo: SeedRecipe = {
  key: "seed-promo-v1",
  title: "Promo Booklet",
  background: { FRONT_COVER: "#fff7ed", BACK_COVER: "#7c2d12" },
  elements: [
    text({
      id: "promo-cover-kicker",
      pageLabel: "FRONT_COVER",
      x: 56,
      y: 160,
      width: 588,
      height: 40,
      text: "TITCHYBOOKS PRESENTS",
      fontSize: 16,
      fontWeight: 700,
      lineHeight: 1.2,
      letterSpacing: 4,
      color: "#c2410c",
      align: "left",
      verticalAlign: "middle",
      locked: true,
    }),
    text({
      id: "promo-cover-title",
      pageLabel: "FRONT_COVER",
      x: 56,
      y: 260,
      width: 588,
      height: 300,
      text: "A Small Book, A Big Idea",
      fontSize: 50,
      fontWeight: 900,
      lineHeight: 1.1,
      letterSpacing: 0,
      color: "#7c2d12",
      align: "left",
      verticalAlign: "top",
      locked: false,
    }),
    text({
      id: "promo-cover-subtitle",
      pageLabel: "FRONT_COVER",
      x: 56,
      y: 620,
      width: 588,
      height: 120,
      text: "Eight pages that make the case.",
      fontSize: 28,
      fontWeight: 400,
      lineHeight: 1.4,
      letterSpacing: 0,
      color: "#9a3412",
      align: "left",
      verticalAlign: "top",
      locked: false,
    }),
    {
      kind: "shape",
      id: "promo-cover-bar",
      pageLabel: "FRONT_COVER",
      x: 56,
      y: 580,
      width: 88,
      height: 8,
      shape: "rect",
      fill: "#ea580c",
    },
    ...INTERIOR_PAGES.flatMap((pageLabel) => {
      const key = pageLabel.toLowerCase().replace("_", "");
      return [
        text({
          id: `promo-${key}-heading`,
          pageLabel,
          x: 56,
          y: 70,
          width: 588,
          height: 90,
          text: "The headline",
          fontSize: 30,
          fontWeight: 800,
          lineHeight: 1.2,
          letterSpacing: 0,
          color: "#7c2d12",
          align: "left",
          verticalAlign: "top",
          locked: false,
        }),
        text({
          id: `promo-${key}-body`,
          pageLabel,
          x: 56,
          y: 190,
          width: 588,
          height: 580,
          text: "The supporting copy for this page.",
          fontSize: 28,
          fontWeight: 400,
          lineHeight: 1.5,
          letterSpacing: 0,
          color: "#292524",
          align: "left",
          verticalAlign: "top",
          locked: false,
        }),
      ];
    }),
    text({
      id: "promo-back-closing",
      pageLabel: "BACK_COVER",
      x: 56,
      y: 160,
      width: 588,
      height: 560,
      text: "Get in touch.",
      fontSize: 28,
      fontWeight: 400,
      lineHeight: 1.5,
      letterSpacing: 0,
      color: "#fff7ed",
      align: "left",
      verticalAlign: "top",
      locked: false,
    }),
    brandedCover("BACK_COVER", "#fed7aa"),
  ],
};

export const SEED_RECIPES: SeedRecipe[] = [story, guide, promo];

/** Scene background for a page in a recipe. */
export function backgroundFor(recipe: SeedRecipe, pageLabel: PageLabel): string {
  return recipe.background[pageLabel] ?? EDITOR_DEFAULT_BACKGROUND_COLOR;
}

/** Serialise a recipe element into the persisted TemplateElement JSON shape. */
export function elementJson(element: SeedElement, zIndex: number): string {
  const base = {
    id: element.id,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: 0,
    opacity: 1,
    locked: element.kind === "text" ? element.locked : true,
    visible: true,
    zIndex,
  };
  if (element.kind === "shape") {
    return JSON.stringify({
      ...base,
      type: "shape",
      shape: element.shape,
      fill: element.fill,
      ...(element.stroke ? { stroke: element.stroke } : {}),
      ...(element.strokeWidth !== undefined ? { strokeWidth: element.strokeWidth } : {}),
    });
  }
  return JSON.stringify({
    ...base,
    type: "text",
    text: element.text,
    fontFamily: "Arial",
    fontSize: element.fontSize,
    fontWeight: element.fontWeight,
    lineHeight: element.lineHeight,
    letterSpacing: element.letterSpacing,
    color: element.color,
    align: element.align,
    verticalAlign: element.verticalAlign,
  });
}

/** Page rows for a recipe, one per page label in reading order. */
export function pageSeeds(recipe: SeedRecipe): Array<{ pageLabel: PageLabel; order: number; sceneJson: string }> {
  return PAGE_LABELS.map((pageLabel, order) => ({
    pageLabel,
    order,
    sceneJson: JSON.stringify({
      version: EDITOR_SCENE_VERSION,
      page: {
        widthPx: EDITOR_PAGE_WIDTH_PX,
        heightPx: EDITOR_PAGE_HEIGHT_PX,
        backgroundColor: backgroundFor(recipe, pageLabel),
      },
      elements: [],
    }),
  }));
}

/** TemplateElement rows for a recipe. */
export function elementSeeds(recipe: SeedRecipe): Array<{ pageLabel: string; order: number; elementJson: string }> {
  return PAGE_LABELS.flatMap((pageLabel) => {
    const pageElements = recipe.elements.filter((element) => element.pageLabel === pageLabel);
    return pageElements.map((element, order) => ({
      pageLabel,
      order,
      elementJson: elementJson(element, order),
    }));
  });
}
