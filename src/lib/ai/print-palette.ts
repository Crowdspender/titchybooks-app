import { EDITOR_PAGE_HEIGHT_PX, EDITOR_PAGE_WIDTH_PX } from "@/lib/editor/constants";
import type { EditorElement } from "@/lib/editor/schema";
import type { PinnedTemplate } from "./template-contract";

/** Autonomous books choose a qualified palette, never arbitrary model colors. */
export const PRINT_PALETTE_IDS = ["mist", "sage", "peach", "lavender", "cream"] as const;
export type PrintPaletteId = typeof PRINT_PALETTE_IDS[number];
export interface PrintPalette {
  id: PrintPaletteId;
  mood: string;
  cover: string;
  paper: string;
  accent: string;
  ink: string;
  accentInk: string;
}
export const PRINT_PALETTES: readonly PrintPalette[] = [
  { id: "mist", mood: "airy blue; clear, practical, calm", cover: "#edf2f7", paper: "#ffffff", accent: "#b7c9db", ink: "#2f3b46", accentInk: "#506373" },
  { id: "sage", mood: "soft green; nature, community, reassuring", cover: "#eef5ee", paper: "#ffffff", accent: "#b9cec0", ink: "#303e35", accentInk: "#526658" },
  { id: "peach", mood: "pale peach; friendly, warm, welcoming", cover: "#faf0e8", paper: "#ffffff", accent: "#d8c2b5", ink: "#453831", accentInk: "#715c50" },
  { id: "lavender", mood: "pale lavender; reflective, imaginative, gentle", cover: "#f3eef8", paper: "#ffffff", accent: "#c9bfda", ink: "#3e3749", accentInk: "#655970" },
  { id: "cream", mood: "light cream; timeless, sunny, understated", cover: "#f8f4e4", paper: "#ffffff", accent: "#d9cfaa", ink: "#403c2e", accentInk: "#68614a" },
];

function rgb(hex: string): number[] {
  if (!/^#(?:[0-9a-f]{3}){1,2}$/i.test(hex)) return [NaN, NaN, NaN];
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
}
export function printColorMetrics(hex: string): { luminance: number; chroma: number } {
  const parts = rgb(hex);
  const linear = parts.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return { luminance: linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722, chroma: Math.max(...parts) - Math.min(...parts) };
}
export function isPrintSafeColor(hex: string, large = true): boolean {
  const { luminance, chroma } = printColorMetrics(hex);
  return luminance >= (large ? 0.70 : 0.35) && chroma <= (large ? 0.30 : 0.45);
}
function contrast(a: string, b: string): number {
  const x = printColorMetrics(a).luminance, y = printColorMetrics(b).luminance;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function largeFill(element: EditorElement): boolean {
  return element.width * element.height >= EDITOR_PAGE_WIDTH_PX * EDITOR_PAGE_HEIGHT_PX * 0.10;
}
function textBackgrounds(text: EditorElement, elements: EditorElement[], background: string): string[] {
  // Conservatively include intersecting filled shapes, so text on an accent
  // panel is readable too. Images remain original template artwork.
  return [background, ...elements.filter((el) => el.type === "shape" && el.visible && el.opacity > 0 && el.fill !== "transparent" && el.zIndex <= text.zIndex &&
    el.x < text.x + text.width && el.x + el.width > text.x && el.y < text.y + text.height && el.y + el.height > text.y)
    .map((el) => el.type === "shape" ? el.fill : background)];
}

/** Missing/unknown model choices use a deterministic default from template hue. */
export function selectPrintPalette(id: unknown, pinned: PinnedTemplate): PrintPalette {
  const requested = PRINT_PALETTES.find((palette) => palette.id === id);
  if (requested) return requested;
  const [r, g, b] = rgb(pinned.pages.find((page) => page.pageLabel === "FRONT_COVER")?.backgroundColor ?? "#ffffff");
  const fallback: PrintPaletteId = b > r && b > g ? "mist" : g > r && g > b ? "sage" : r > b && r > g ? "peach" : "cream";
  return PRINT_PALETTES.find((palette) => palette.id === fallback)!;
}

/** Copy-on-write: never mutate the template, geometry, or an existing book pin. */
export function applyPrintPalette(pinned: PinnedTemplate, palette: PrintPalette): PinnedTemplate {
  const pages = pinned.pages.map((page) => {
    const cover = page.pageLabel === "FRONT_COVER" || page.pageLabel === "BACK_COVER";
    const backgroundColor = cover ? palette.cover : isPrintSafeColor(page.backgroundColor) ? page.backgroundColor : palette.paper;
    const generated = new Set(pinned.manifest.pages.find((entry) => entry.pageLabel === page.pageLabel)?.slots.filter((slot) => slot.generated).map((slot) => slot.id));
    const shapes = page.elements.map((element): EditorElement => element.type !== "shape" ? element : {
      ...element,
      fill: element.fill === "transparent" ? "transparent" : largeFill(element) ? (cover ? palette.cover : palette.paper) : palette.accent,
      ...(element.stroke && element.stroke !== "transparent" ? { stroke: palette.accent } : {}),
    });
    const elements = shapes.map((element): EditorElement => {
      if (element.type !== "text") return element;
      const preferred = generated.has(element.id) ? palette.ink : palette.accentInk;
      const color = textBackgrounds(element, shapes, backgroundColor).every((bg) => contrast(preferred, bg) >= 4.5) ? preferred : palette.ink;
      return { ...element, color };
    });
    return { ...page, backgroundColor, elements };
  });
  const backgrounds = new Map(pages.map((page) => [page.pageLabel, page.backgroundColor]));
  return {
    ...pinned, pages,
    manifest: { ...pinned.manifest, pages: pinned.manifest.pages.map((page) => ({ ...page, backgroundColor: backgrounds.get(page.pageLabel) ?? page.backgroundColor })) },
  };
}

/** Composition guard: large areas stay light, accents soft, and text legible. */
export function printSafetyIssues(pinned: PinnedTemplate): string[] {
  const issues: string[] = [];
  for (const page of pinned.pages) {
    if (!isPrintSafeColor(page.backgroundColor)) issues.push(`${page.pageLabel}: background is not print-safe`);
    for (const element of page.elements) {
      if (!element.visible || element.opacity === 0) continue;
      if (element.type === "shape") {
        if (element.fill !== "transparent" && !isPrintSafeColor(element.fill, largeFill(element))) issues.push(`${page.pageLabel} ${element.id}: fill is not print-safe`);
        if (element.stroke && element.stroke !== "transparent" && !isPrintSafeColor(element.stroke, false)) issues.push(`${page.pageLabel} ${element.id}: stroke is not print-safe`);
      } else if (element.type === "text" && !textBackgrounds(element, page.elements, page.backgroundColor).every((bg) => contrast(element.color, bg) >= 4.5)) {
        issues.push(`${page.pageLabel} ${element.id}: text contrast is below 4.5:1`);
      }
    }
  }
  return issues;
}
