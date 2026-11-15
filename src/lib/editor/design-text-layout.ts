import type { Font, Glyph, Path } from "opentype.js";
import { faceId, getDesignFont, type DesignText } from "./design-fonts";

export interface DesignLine { text: string; x: number; baseline: number; width: number }
export interface DesignGlyph { glyphIndex: number; subset: number; x: number; baseline: number; advance: number; line: number }
export interface DesignLayout {
  lines: DesignLine[];
  glyphs: DesignGlyph[];
  path: string;
  height: number;
  maxLineWidth: number;
  bounds: { x1: number; y1: number; x2: number; y2: number };
}
interface PositionedGlyph { font: Font; glyph: Glyph; x: number }

// OpenType 2's string-exponent rounding can produce NaN near integral values.
// Serialize the outline commands directly with finite, fixed-precision numbers.
function outlineData(path: Path): string {
  const number = (value: number) => {
    if (!Number.isFinite(value)) throw new Error('Invalid glyph outline coordinate');
    return String(Number(value.toFixed(3)));
  };
  return path.commands.map(command => {
    switch (command.type) {
      case 'M': case 'L': return `${command.type}${number(command.x)} ${number(command.y)}`;
      case 'Q': return `Q${number(command.x1)} ${number(command.y1)} ${number(command.x)} ${number(command.y)}`;
      case 'C': return `C${number(command.x1)} ${number(command.y1)} ${number(command.x2)} ${number(command.y2)} ${number(command.x)} ${number(command.y)}`;
      case 'Z': return 'Z';
    }
  }).join(' ');
}

/** Immutable v1 layout: glyph outlines are shared by canvas, thumbnails, PDF and QA. */
export function layoutDesignText(element: DesignText): DesignLayout {
  const faces = getDesignFont(faceId(element));
  const size = element.fontSize;
  const tracking = element.tracking !== undefined ? element.tracking * size : element.letterSpacing;
  const ascent = Math.max(...faces.map(font => font.ascender / font.unitsPerEm)) * size;
  const descent = Math.max(...faces.map(font => -font.descender / font.unitsPerEm)) * size;
  const lineStep = size * element.lineHeight;
  function shape(text: string) {
    let x = 0;
    let previous: PositionedGlyph | undefined;
    const glyphs: PositionedGlyph[] = [];
    let minX = 0, maxInk = 0;
    for (const char of text) {
      const font = faces.find(face => face.charToGlyphIndex(char) !== 0);
      if (!font) {
        const code = char.codePointAt(0)!;
        const suggestion = code >= 0x0100 && code <= 0x017f ? ' Choose Source Sans 3 for this whole text box.' : '';
        throw new Error(`The selected font does not contain “${char}”.${suggestion}`);
      }
      const glyph = font.charToGlyph(char);
      const scale = size / font.unitsPerEm;
      if (previous) x += tracking + (previous.font === font ? font.getKerningValue(previous.glyph, glyph) * scale : 0);
      glyphs.push({ font, glyph, x });
      const box = glyph.getBoundingBox();
      minX = Math.min(minX, x + box.x1 * scale);
      maxInk = Math.max(maxInk, x + box.x2 * scale);
      x += (glyph.advanceWidth ?? font.unitsPerEm) * scale;
      previous = glyphs[glyphs.length - 1];
    }
    return { glyphs, leftBearing: -minX, width: Math.max(x, maxInk) - minX };
  }
  const rawLines: Array<{ text: string; indent: number; baseline: number }> = [];
  let baseline = ascent;
  const paragraphs = element.text.replace(/\r\n?/g, "\n").split("\n");
  for (let p = 0; p < paragraphs.length; p++) {
    let current = "";
    let first = true;
    const indent = () => first ? (element.firstLineIndent ?? 0) * size : 0;
    const emit = () => {
      rawLines.push({ text: current, indent: indent(), baseline });
      baseline += lineStep;
      current = "";
      first = false;
    };
    for (const word of paragraphs[p].replace(/\t/g, " ").split(/\s+/).filter(Boolean)) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && shape(candidate).width > element.width - indent()) emit();
      const chars = Array.from(word);
      if (shape(word).width > element.width - indent()) {
        for (const char of chars) {
          if (current && shape(current + char).width > element.width - indent()) emit();
          current += char;
        }
      } else current = current ? `${current} ${word}` : word;
    }
    emit();
    if (p < paragraphs.length - 1) baseline += (element.paragraphGap ?? 0) * size;
  }
  const height = Math.max(0, (rawLines.at(-1)?.baseline ?? ascent) + descent);
  const offsetY = element.verticalAlign === "middle" ? (element.height - height) / 2 : element.verticalAlign === "bottom" ? element.height - height : 0;
  const lines: DesignLine[] = [];
  const glyphs: DesignGlyph[] = [];
  const paths: string[] = [];
  const bounds = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const line of rawLines) {
    const shaped = shape(line.text);
    const room = element.width - line.indent;
    const x = line.indent + (element.align === "center" ? (room - shaped.width) / 2 : element.align === "right" ? room - shaped.width : 0);
    lines.push({ text: line.text, x, baseline: line.baseline + offsetY, width: shaped.width + line.indent });
    for (const item of shaped.glyphs) {
      const position = { glyphIndex: item.glyph.index, subset: faces.indexOf(item.font), x: x + item.x + shaped.leftBearing, baseline: line.baseline + offsetY, advance: (item.glyph.advanceWidth ?? item.font.unitsPerEm) * size / item.font.unitsPerEm, line: lines.length - 1 };
      glyphs.push(position);
      const path = item.glyph.getPath(position.x, position.baseline, size);
      if (!path.commands.length) continue;
      const box = path.getBoundingBox();
      bounds.x1 = Math.min(bounds.x1, box.x1); bounds.y1 = Math.min(bounds.y1, box.y1);
      bounds.x2 = Math.max(bounds.x2, box.x2); bounds.y2 = Math.max(bounds.y2, box.y2);
      paths.push(outlineData(path));
    }
  }
  if (!Number.isFinite(bounds.x1)) Object.assign(bounds, { x1: 0, y1: 0, x2: 0, y2: 0 });
  return { lines, glyphs, path: paths.join(" "), height, maxLineWidth: Math.max(0, ...lines.map(line => line.width)), bounds };
}

export function designTextCapacity(element: DesignText): number {
  // Budget with actual face advances; exact content still passes the fit gate.
  const sample = "The quick brown fox jumps over the lazy dog. ";
  const probe = layoutDesignText({ ...element, text: sample, width: 100000, height: 100000, align: "left", verticalAlign: "top", firstLineIndent: 0 });
  const average = probe.maxLineWidth / sample.trimEnd().length;
  const firstRowHeight = probe.height;
  // Reserve one paragraph boundary and indent every four rows. Exact generated
  // content is checked separately; this budget is deliberately conservative.
  const rowCost = element.fontSize * (element.lineHeight + (element.paragraphGap ?? 0) / 4);
  const rows = Math.max(0, 1 + Math.floor((element.height - firstRowHeight) / rowCost));
  const usableWidth = Math.max(0, element.width - (element.firstLineIndent ?? 0) * element.fontSize / 4);
  return Math.max(1, Math.floor(usableWidth / Math.max(1, average) * rows * 0.9));
}
