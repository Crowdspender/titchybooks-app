import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import { EDITOR_PAGE_WIDTH_PX } from "@/lib/editor/constants";

/**
 * Versioned print profile for the AI-generated text-only book.
 *
 * Two artifacts are produced from one canonical upright page render:
 * - a folded A4-landscape imposition sheet (compatibility geometry, `PANELS`),
 * - an eight-page 74 x 105 mm reading-order PDF.
 *
 * Reading order is an explicit constant: it never depends on panel order,
 * database order, or the order elements happen to be serialized in.
 */
export const READING_ORDER: readonly PageLabel[] = [
  "FRONT_COVER",
  "PAGE_2",
  "PAGE_3",
  "PAGE_4",
  "PAGE_5",
  "PAGE_6",
  "PAGE_7",
  "BACK_COVER",
] as const;

// Sanity guard: every page label appears exactly once, nothing else is added.
if (
  READING_ORDER.length !== PAGE_LABELS.length ||
  new Set(READING_ORDER).size !== PAGE_LABELS.length ||
  PAGE_LABELS.some((label) => !READING_ORDER.includes(label))
) {
  throw new Error("READING_ORDER must list every page label exactly once");
}

export const MIN_READING_PAGE_MM = { widthMm: 74, heightMm: 105 } as const;
export const MIN_BODY_POINT_SIZE = 8;
export const PRINT_PROFILE_DPI = 300;
/** Effective DPI below which an AI book must not be auto-approved. */
export const MIN_EFFECTIVE_DPI = 200;

export interface PrintProfile {
  /** Identity persisted in render snapshots so past jobs stay reproducible. */
  id: string;
  version: number;
  description: string;
  sheet: { widthMm: number; heightMm: number };
  readingPage: { widthMm: number; heightMm: number };
  dpi: number;
  minBodyPointSize: number;
  colorSpace: "RGB";
  renderer: "raster";
  readingOrder: readonly PageLabel[];
  /** Outputs every qualified AI render must publish together. */
  outputs: readonly ("print-sheet" | "reading-pdf")[];
}

/**
 * Initial (single-sheet, home/office RGB) profile. Commercial printing needs a
 * separately proofed profile rather than an edit to this one.
 */
export const DEFAULT_PRINT_PROFILE: PrintProfile = {
  id: "titchybook-single-sheet-rgb-v2",
  version: 2,
  description:
    "A4-landscape foldable sheet plus 74 x 105 mm reading pages, RGB, 300 DPI raster",
  sheet: { widthMm: 297, heightMm: 210 },
  readingPage: MIN_READING_PAGE_MM,
  dpi: PRINT_PROFILE_DPI,
  minBodyPointSize: MIN_BODY_POINT_SIZE,
  colorSpace: "RGB",
  renderer: "raster",
  readingOrder: READING_ORDER,
  outputs: ["print-sheet", "reading-pdf"],
};

/**
 * True when a persisted snapshot targets the currently qualified profile.
 * Older profiles stay readable but are never silently re-qualified.
 */
export function isCurrentPrintProfile(id: string | null | undefined): boolean {
  return id === DEFAULT_PRINT_PROFILE.id;
}

/**
 * Font families the initial AI path will print with. A family outside this
 * list is rejected rather than silently substituted by the raster runtime.
 */
export const AI_SUPPORTED_FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Georgia",
  "Times New Roman",
  "Courier New",
] as const;

export function isSupportedFontFamily(family: string): boolean {
  const normalized = family.replace(/["']/g, "").split(",")[0].trim().toLowerCase();
  return AI_SUPPORTED_FONT_FAMILIES.some((supported) => supported.toLowerCase() === normalized);
}

/**
 * Editor scene pixels are 1/700 of the 74 mm reading page width, so one scene
 * pixel is ~0.2996 pt. Convert a physical point size into scene pixels to check
 * legibility after the final print scale.
 */
export const POINTS_PER_SCENE_PX = (MIN_READING_PAGE_MM.widthMm / EDITOR_PAGE_WIDTH_PX) * (72 / 25.4);

export function ptToScenePx(points: number): number {
  return points / POINTS_PER_SCENE_PX;
}

export function scenePxToPt(px: number): number {
  return px * POINTS_PER_SCENE_PX;
}
