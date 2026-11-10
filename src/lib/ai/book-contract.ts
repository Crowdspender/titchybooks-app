import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import { BACK_COVER_BRAND_BAND_PX, BACK_COVER_BRAND_TEXT, EDITOR_PAGE_HEIGHT_PX, EDITOR_PAGE_WIDTH_PX, EDITOR_SAFE_MARGIN_PX } from "@/lib/editor/constants";
import { READING_ORDER } from "@/lib/pdf/print-profile";

/**
 * The shared "what counts as a finished book" contract.
 *
 * Everything that decides whether an autonomous book is complete imports from
 * here: template preflight, content generation, composition, QA, rendering and
 * the status API. Eight page rows in a database are not proof of a book; the
 * contract below is.
 */

export { READING_ORDER };

export const BOOK_PAGE_COUNT = 8;
export const MAX_TITLE_CHARS = 120;

/** Role of the content the pipeline must generate for each page. */
export type BookSlotRole = "title" | "body" | "closing";

export const PAGE_CONTENT_ROLE: Record<PageLabel, BookSlotRole> = {
  FRONT_COVER: "title",
  PAGE_2: "body",
  PAGE_3: "body",
  PAGE_4: "body",
  PAGE_5: "body",
  PAGE_6: "body",
  PAGE_7: "body",
  BACK_COVER: "closing",
};

/** Every page needs generated content; the branding band is never generated. */
export const REQUIRED_CONTENT_PAGES: readonly PageLabel[] = READING_ORDER;

/** Characters-per-slot bounds per role. Narrower per-slot budgets come from the template manifest. */
export const ROLE_TEXT_BUDGET: Record<BookSlotRole, { minChars: number; maxChars: number }> = {
  title: { minChars: 1, maxChars: MAX_TITLE_CHARS },
  body: { minChars: 40, maxChars: 1200 },
  closing: { minChars: 20, maxChars: 600 },
};

/**
 * Supported text repertoire for the initial (text-only) release: Latin basic,
 * Latin-1 supplement and Latin Extended-A, plus typographic punctuation that
 * the bundled assets are expected to cover.
 *
 * Unsupported scripts are an explicit capability boundary: content containing
 * them is rejected so no character is ever silently dropped, transliterated,
 * or replaced with a tofu box.
 */
const SUPPORTED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0020, 0x007e],
  [0x00a0, 0x00ff],
  [0x0100, 0x017f],
  [0x2013, 0x2014],
  [0x2018, 0x201f],
  [0x2026, 0x2026],
  [0x20ac, 0x20ac],
];

/** Invisible control characters that are always rejected (tab/newline are allowed). */
const ALLOWED_CONTROL = new Set(["\n", "\r", "\t"]);

export function isSupportedCharacter(char: string): boolean {
  if (ALLOWED_CONTROL.has(char)) return true;
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  if (code < 0x20) return false;
  return SUPPORTED_RANGES.some(([min, max]) => code >= min && code <= max);
}

/** Distinct unsupported characters in `text`, in first-seen order. */
export function findUnsupportedCharacters(text: string): string[] {
  const found: string[] = [];
  for (const char of text) {
    if (!isSupportedCharacter(char) && !found.includes(char)) found.push(char);
  }
  return found;
}

const PLACEHOLDER_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp; detail: string }> = [
  { code: "lorem-ipsum", pattern: /\blorem\s+ipsum\b/i, detail: "Lorem ipsum filler text" },
  { code: "todo-marker", pattern: /\b(todo|tbd|tbc|fixme)\b/i, detail: "Editorial TODO/TBD marker" },
  { code: "insert-marker", pattern: /\[(insert|add|write|your)[^\]]*\]/i, detail: "Unreplaced placeholder bracket" },
  { code: "placeholder-word", pattern: /\bplaceholder\b/i, detail: 'Literal "placeholder" text' },
  { code: "template-example", pattern: /\bexample (text|content|here)\b/i, detail: "Untouched template example text" },
  { code: "repeated-glyph", pattern: /(.)\1{7,}/u, detail: "Eight or more repeated characters" },
];

/** Why `text` is not publishable content, or null when it is fine. */
export function describePlaceholderText(text: string): { code: string; detail: string } | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { code: "empty", detail: "Empty text" };
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return { code: "no-letters", detail: "Contains no letters or digits" };
  for (const { code, pattern, detail } of PLACEHOLDER_PATTERNS) {
    if (pattern.test(trimmed)) return { code, detail };
  }
  return null;
}

/**
 * The reserved branding band at the bottom of the back cover, in editor scene
 * pixels. Generated content must not be positioned inside it.
 */
export function brandingRegion(pageLabel: PageLabel): { x: number; y: number; width: number; height: number } | null {
  if (pageLabel !== "BACK_COVER") return null;
  return {
    x: 0,
    y: EDITOR_PAGE_HEIGHT_PX - BACK_COVER_BRAND_BAND_PX,
    width: EDITOR_PAGE_WIDTH_PX,
    height: BACK_COVER_BRAND_BAND_PX,
  };
}

/** True when a text element is fixed template/branding content rather than a generated slot. */
export function isFixedContent(input: { pageLabel: PageLabel; text: string; locked: boolean }): boolean {
  if (input.locked) return true;
  return input.pageLabel === "BACK_COVER" && input.text.includes(BACK_COVER_BRAND_TEXT);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Geometry is valid when the box is inside the page and inside the safe margin. */
export function isBoxInsidePage(box: Rect): boolean {
  const minX = EDITOR_SAFE_MARGIN_PX;
  const minY = EDITOR_SAFE_MARGIN_PX;
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    box.width > 0 &&
    box.height > 0 &&
    box.x >= minX &&
    box.y >= minY &&
    box.x + box.width <= EDITOR_PAGE_WIDTH_PX - minX &&
    box.y + box.height <= EDITOR_PAGE_HEIGHT_PX - minY
  );
}

/**
 * Text-only and illustrated generation are switched independently so the
 * manual/editor flows keep working while the autonomous gates are incomplete.
 * Text generation stays enabled (it is the shipped capability); illustrated
 * generation is off until Release B qualification exists.
 */
export function aiTextGenerationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_TEXT_BOOKS_ENABLED !== "false" && env.AI_TEXT_BOOKS_ENABLED !== "0" && env.AI_TEXT_BOOKS_ENABLED !== "off";
}

export function aiIllustratedGenerationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_ILLUSTRATED_BOOKS_ENABLED === "true" || env.AI_ILLUSTRATED_BOOKS_ENABLED === "1";
}

export const BOOK_PAGE_LABELS: readonly PageLabel[] = PAGE_LABELS;
