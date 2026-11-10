/**
 * Shared server-side text measurement.
 *
 * QA and PDF rendering must agree on line breaking and block height: an
 * approximate model in one place and a different one in the other would let a
 * book pass QA and still overflow in print. Both import from here.
 *
 * The measurement is a per-glyph advance estimate (no native font shaper is
 * available in the rendering path), so it is deliberately conservative: the
 * tables are derived from proportional Latin faces and round up for unknown
 * glyphs.
 */

export interface TextStyle {
  fontSize: number;
  fontWeight: number;
  letterSpacing: number;
  lineHeight: number;
}

/** Advance width of one character as a fraction of the font size. */
export function charWidthRatio(char: string): number {
  if (char === " " || char === "\t") return 0.28;
  if ("iIjl!|.,:;'".includes(char)) return 0.3;
  if ("frt()[]{}-/\\".includes(char)) return 0.37;
  if ("sz".includes(char)) return 0.48;
  if ("acegknopquvxy".includes(char)) return 0.53;
  if ("bdh".includes(char)) return 0.55;
  if ("ABCDEFGHJKLNOPQRSTUVXYZ0123456789".includes(char)) return 0.62;
  if ("mwMW".includes(char)) return 0.77;
  // Unknown glyphs (including accented Latin) get the widest common advance.
  return 0.56;
}

const BOLD_FACTOR = 1.1;

/** Approximate rendered advance width of a single line, letter spacing included. */
export function measureStringWidth(text: string, style: Pick<TextStyle, "fontSize" | "fontWeight" | "letterSpacing">): number {
  const bold = style.fontWeight >= 600 ? BOLD_FACTOR : 1;
  let width = 0;
  for (const char of text) {
    width += style.fontSize * charWidthRatio(char) * bold + style.letterSpacing;
  }
  return width;
}

/**
 * Greedy word wrap that mirrors the editor canvas (`wrap="word"`): explicit
 * newlines are preserved as paragraph breaks, each paragraph wraps to
 * `maxWidth`. Words longer than the box are broken rather than allowed to
 * overflow silently.
 */
export function wrapTextLines(rawText: string, maxWidth: number, style: Pick<TextStyle, "fontSize" | "fontWeight" | "letterSpacing">): string[] {
  const limit = Math.max(1, maxWidth);
  const result: string[] = [];
  for (const paragraph of rawText.split(/\r?\n/)) {
    const trimmed = paragraph.trimEnd();
    if (trimmed === "") {
      result.push("");
      continue;
    }
    const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
    let currentLine = "";
    for (const word of words) {
      const candidate = currentLine === "" ? word : `${currentLine} ${word}`;
      if (measureStringWidth(candidate, style) > limit && currentLine !== "") {
        result.push(currentLine);
        currentLine = word;
      } else {
        currentLine = candidate;
      }
      // Break an unbreakable token that cannot fit on a line by itself.
      while (measureStringWidth(currentLine, style) > limit && currentLine.length > 1) {
        let head = currentLine;
        while (head.length > 1 && measureStringWidth(head, style) > limit) head = head.slice(0, -1);
        result.push(head);
        currentLine = currentLine.slice(head.length);
      }
    }
    if (currentLine !== "") result.push(currentLine);
  }
  return result.length > 0 ? result : [""];
}

export interface TextBlockMetrics {
  lines: string[];
  lineCount: number;
  height: number;
  maxLineWidth: number;
}

/** Measure a wrapped text block as it would be rendered into a box. */
export function measureTextBlock(text: string, maxWidth: number, style: TextStyle): TextBlockMetrics {
  const lines = wrapTextLines(text, maxWidth, style);
  const lineStep = style.fontSize * style.lineHeight;
  return {
    lines,
    lineCount: lines.length,
    height: lines.length * lineStep,
    maxLineWidth: Math.max(0, ...lines.map((line) => measureStringWidth(line, style))),
  };
}

/** True when the wrapped text stays inside the box (no overflow tolerance). */
export function textFitsBox(text: string, width: number, height: number, style: TextStyle): boolean {
  return measureTextBlock(text, width, style).height <= height;
}

/**
 * Largest number of characters that can fit the box at the given style.
 * Used to publish a text budget to the model and to reject overlong content.
 */
export function maxCharsForBox(width: number, height: number, style: TextStyle): number {
  const lineStep = Math.max(1, style.fontSize * style.lineHeight);
  const maxLines = Math.max(1, Math.floor(height / lineStep));
  const averageAdvance = Math.max(1, style.fontSize * 0.5 + style.letterSpacing);
  return Math.max(1, Math.floor((width / averageAdvance) * maxLines));
}
