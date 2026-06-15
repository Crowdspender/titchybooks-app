import {
  PDFDocument,
  PDFPage,
  StandardFonts,
  PDFFont,
  rgb,
  degrees,
} from "pdf-lib";
import { getImageCropRect } from "@/lib/editor/crop";
import type { EditorElement, EditorScene } from "@/lib/editor/schema";

// ---------------------------------------------------------------------------
// Font mapping: CSS font families → pdf-lib StandardFonts
// ---------------------------------------------------------------------------

const FONT_MAP: Record<string, keyof typeof StandardFonts> = {
  // Serif
  "serif": "TimesRoman",
  "times new roman": "TimesRoman",
  "times": "TimesRoman",
  "georgia": "TimesRoman",
  // Sans-serif
  "sans-serif": "Helvetica",
  "arial": "Helvetica",
  "helvetica": "Helvetica",
  "verdana": "Helvetica",
  "system-ui": "Helvetica",
  "inter": "Helvetica",
  // Monospace
  "monospace": "Courier",
  "courier": "Courier",
  "courier new": "Courier",
  // Cursive → italic
  "cursive": "TimesRoman",
};

interface FontCache {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

/**
 * Resolve a CSS font-family string to a pdf-lib StandardFonts key.
 */
function resolveFontKey(fontFamily: string): keyof typeof StandardFonts {
  const cleaned = fontFamily
    .replace(/['"]/g, "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return FONT_MAP[cleaned] ?? "Helvetica";
}

function getFontNames(
  fontFamily: string,
  fontWeight: number,
): { regular: keyof typeof StandardFonts; bold: keyof typeof StandardFonts } {
  const base = resolveFontKey(fontFamily);
  // For StandardFonts, bold variants exist for Helvetica, Courier, TimesRoman
  const boldMap: Record<string, keyof typeof StandardFonts> = {
    Helvetica: "HelveticaBold",
    HelveticaBold: "HelveticaBold",
    HelveticaOblique: "HelveticaBoldOblique",
    TimesRoman: "TimesRomanBold",
    TimesRomanBold: "TimesRomanBold",
    Courier: "CourierBold",
    CourierBold: "CourierBold",
  };
  return {
    regular: base,
    bold: fontWeight >= 600 ? (boldMap[base] ?? "HelveticaBold") : base,
  };
}

async function loadFonts(
  pdfDoc: PDFDocument,
  fontFamily: string,
  fontWeight: number,
): Promise<{ font: PDFFont }> {
  const { regular, bold } = getFontNames(fontFamily, fontWeight);
  const font = await pdfDoc.embedFont(StandardFonts[fontWeight >= 600 ? bold : regular]);
  return { font };
}

// ---------------------------------------------------------------------------
// Text wrapping (same algorithm as editor-render.ts SVG renderer)
// ---------------------------------------------------------------------------

function estimateCharWidth(char: string, fontSize: number, fontWeight: number): number {
  const boldFactor = fontWeight >= 600 ? 1.1 : 1.0;
  let ratio: number;
  if (char === " " || char === "\t") ratio = 0.28;
  else if ("iIjl!|".includes(char)) ratio = 0.30;
  else if ("frt".includes(char)) ratio = 0.37;
  else if ("sz".includes(char)) ratio = 0.48;
  else if ("acegknopquvxy".includes(char)) ratio = 0.53;
  else if ("bdh".includes(char)) ratio = 0.55;
  else if ("ABCDEFGHJKLNOPQRSTUVXYZ0123456789".includes(char)) ratio = 0.62;
  else if ("mwMW".includes(char)) ratio = 0.77;
  else ratio = 0.54;
  return fontSize * ratio * boldFactor;
}

function estimateStringWidth(
  text: string,
  fontSize: number,
  fontWeight: number,
  letterSpacing: number,
): number {
  let width = 0;
  for (const char of text) {
    width += estimateCharWidth(char, fontSize, fontWeight) + letterSpacing;
  }
  return width;
}

function wrapTextLines(
  rawText: string,
  maxWidth: number,
  fontSize: number,
  fontWeight: number,
  letterSpacing: number,
): string[] {
  const result: string[] = [];
  for (const paragraph of rawText.split(/\r?\n/)) {
    const trimmed = paragraph.trimEnd();
    if (trimmed === "") {
      result.push("");
      continue;
    }
    const words = trimmed.split(" ");
    let currentLine = "";
    for (const word of words) {
      const candidate = currentLine === "" ? word : `${currentLine} ${word}`;
      const candidateWidth = estimateStringWidth(candidate, fontSize, fontWeight, letterSpacing);
      if (candidateWidth > maxWidth && currentLine !== "") {
        result.push(currentLine);
        currentLine = word;
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine !== "") {
      result.push(currentLine);
    }
  }
  return result.length > 0 ? result : [""];
}

// ---------------------------------------------------------------------------
// Color parsing
// ---------------------------------------------------------------------------

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  let cleaned = hex.replace("#", "");
  if (cleaned.length === 3) {
    cleaned = cleaned
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = parseInt(cleaned, 16);
  return {
    r: ((num >> 16) & 0xff) / 255,
    g: ((num >> 8) & 0xff) / 255,
    b: (num & 0xff) / 255,
  };
}

// ---------------------------------------------------------------------------
// Coordinate mapping: editor scene px → PDF points
// ---------------------------------------------------------------------------

interface PageTransform {
  scaleX: number;
  scaleY: number;
  pageHeightPts: number;
}

function createPageTransform(
  sceneWidthPx: number,
  sceneHeightPx: number,
  targetWidthPts: number,
  targetHeightPts: number,
): PageTransform {
  return {
    scaleX: targetWidthPts / sceneWidthPx,
    scaleY: targetHeightPts / sceneHeightPx,
    pageHeightPts: targetHeightPts,
  };
}

/** Convert scene Y to PDF Y (PDF origin is bottom-left). */
function toPdfY(sceneY: number, heightPx: number, t: PageTransform): number {
  return t.pageHeightPts - (sceneY + heightPx) * t.scaleY;
}

function toPdfX(sceneX: number, t: PageTransform): number {
  return sceneX * t.scaleX;
}

// ---------------------------------------------------------------------------
// Element renderers
// ---------------------------------------------------------------------------

interface AssetSource {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

async function drawTextElement(
  page: PDFPage,
  pdfDoc: PDFDocument,
  element: Extract<EditorElement, { type: "text" }>,
  t: PageTransform,
): Promise<void> {
  if (!element.visible) return;

  const { font } = await loadFonts(pdfDoc, element.fontFamily, element.fontWeight);
  const fontSizePts = element.fontSize * t.scaleY;
  const lineHeightPts = fontSizePts * element.lineHeight;
  const letterSpacingPts = element.letterSpacing * t.scaleX;
  const maxWidthPts = element.width * t.scaleX;

  const lines = wrapTextLines(
    element.text,
    element.width,
    element.fontSize,
    element.fontWeight,
    element.letterSpacing,
  );

  const color = parseHexColor(element.color);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let lineWidthPts = 0;
    for (const char of line) {
      lineWidthPts += estimateCharWidth(char, fontSizePts, element.fontWeight) + letterSpacingPts;
    }

    let xPts: number;
    if (element.align === "center") {
      xPts = toPdfX(element.x + (element.width / 2), t) - lineWidthPts / 2;
    } else if (element.align === "right") {
      xPts = toPdfX(element.x + element.width, t) - lineWidthPts;
    } else {
      xPts = toPdfX(element.x, t);
    }

    // Y: top of element + font ascent + line offset
    const yPts =
      t.pageHeightPts -
      (element.y + element.fontSize + i * element.fontSize * element.lineHeight) * t.scaleY;

    page.drawText(line, {
      x: xPts,
      y: yPts,
      size: fontSizePts,
      font,
      color: rgb(color.r, color.g, color.b),
      opacity: element.opacity,
      rotate: element.rotation !== 0 ? degrees(-element.rotation) : undefined,
    });
  }
}

function drawShapeElement(
  page: PDFPage,
  element: Extract<EditorElement, { type: "shape" }>,
  t: PageTransform,
): void {
  if (!element.visible) return;

  const x = toPdfX(element.x, t);
  const y = toPdfY(element.y, element.height, t);
  const w = element.width * t.scaleX;
  const h = element.height * t.scaleY;
  const fill = element.fill !== "transparent" ? parseHexColor(element.fill) : null;
  const stroke = element.stroke && element.stroke !== "transparent" ? parseHexColor(element.stroke) : null;

  if (element.shape === "circle") {
    page.drawEllipse({
      x: x + w / 2,
      y: y + h / 2,
      xScale: w / 2,
      yScale: h / 2,
      color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
      borderColor: stroke ? rgb(stroke.r, stroke.g, stroke.b) : undefined,
      borderWidth: element.strokeWidth ?? 0,
      opacity: element.opacity,
    });
  } else if (element.shape === "line") {
    page.drawLine({
      start: { x, y: y + h },
      end: { x: x + w, y: y + h },
      thickness: element.strokeWidth ?? 2,
      color: stroke ? rgb(stroke.r, stroke.g, stroke.b) : fill ? rgb(fill.r, fill.g, fill.b) : rgb(0, 0, 0),
      opacity: element.opacity,
    });
  } else {
    // rect
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
      borderColor: stroke ? rgb(stroke.r, stroke.g, stroke.b) : undefined,
      borderWidth: element.strokeWidth ?? 0,
      opacity: element.opacity,
      rotate: element.rotation !== 0 ? degrees(-element.rotation) : undefined,
    });
  }
}

async function drawImageElement(
  page: PDFPage,
  pdfDoc: PDFDocument,
  element: Extract<EditorElement, { type: "image" }>,
  asset: AssetSource,
  t: PageTransform,
): Promise<void> {
  if (!element.visible) return;

  const cropRect = getImageCropRect({
    imageWidth: asset.width,
    imageHeight: asset.height,
    frameWidth: element.width,
    frameHeight: element.height,
    crop: element.crop,
  });

  // For the vector renderer, we need to render the cropped portion of the image.
  // pdf-lib can't do arbitrary clipping easily, so we pre-crop with sharp
  // and embed the result. This is a pragmatic middle ground.
  const sharp = (await import("sharp")).default;

  const scale = Math.max(
    element.width / cropRect.width,
    element.height / cropRect.height,
  );
  const renderedWidth = Math.round(asset.width * scale);
  const renderedHeight = Math.round(asset.height * scale);
  const extractLeft = Math.round(cropRect.x);
  const extractTop = Math.round(cropRect.y);
  const extractWidth = Math.round(cropRect.width);
  const extractHeight = Math.round(cropRect.height);

  let imagePipeline = sharp(asset.buffer)
    .extract({
      left: extractLeft,
      top: extractTop,
      width: extractWidth,
      height: extractHeight,
    })
    .resize(Math.round(element.width), Math.round(element.height), {
      fit: "cover",
    });

  if (element.rotation === 180) {
    imagePipeline = imagePipeline.rotate(180);
  }

  const croppedBuffer = await imagePipeline.png().toBuffer();

  const pdfImage = await pdfDoc.embedPng(croppedBuffer);

  const x = toPdfX(element.x, t);
  const y = toPdfY(element.y, element.height, t);
  const w = element.width * t.scaleX;
  const h = element.height * t.scaleY;

  page.drawImage(pdfImage, {
    x,
    y,
    width: w,
    height: h,
    opacity: element.opacity,
    rotate: element.rotation !== 0 && element.rotation !== 180
      ? degrees(-element.rotation)
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Render an EditorScene directly onto a pdf-lib PDFPage using vector drawing
 * APIs. Text remains sharp at any zoom level. Images are pre-cropped via
 * sharp then embedded as PNG.
 *
 * @returns The PDFDocument (caller is responsible for saving).
 */
export async function renderSceneToPdfPage(
  scene: EditorScene,
  targetWidthPts: number,
  targetHeightPts: number,
  assets: Map<string, AssetSource>,
  rotation?: number,
): Promise<{ pdfDoc: PDFDocument; page: PDFPage }> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([targetWidthPts, targetHeightPts]);

  const t = createPageTransform(
    scene.page.widthPx,
    scene.page.heightPx,
    targetWidthPts,
    targetHeightPts,
  );

  // Background
  const bg = parseHexColor(scene.page.backgroundColor);
  page.drawRectangle({
    x: 0,
    y: 0,
    width: targetWidthPts,
    height: targetHeightPts,
    color: rgb(bg.r, bg.g, bg.b),
  });

  // Sort elements by zIndex
  const sorted = scene.elements.slice().sort((a, b) => a.zIndex - b.zIndex);

  for (const element of sorted) {
    if (!element.visible) continue;

    try {
      if (element.type === "shape") {
        drawShapeElement(page, element, t);
      } else if (element.type === "text") {
        await drawTextElement(page, pdfDoc, element, t);
      } else if (element.type === "image") {
        const asset = assets.get(element.assetId);
        if (asset) {
          await drawImageElement(page, pdfDoc, element, asset, t);
        }
      }
    } catch (err) {
      console.error(`Failed to render element ${element.id}:`, err);
    }
  }

  // If the panel requires 180° rotation (bottom row of the imposed sheet),
  // we render normally then rotate the page. Since pdf-lib page rotation
  // happens at the page level, we instead render into a separate doc and
  // let the caller handle rotation by re-rendering with rotated coordinates.
  // For simplicity, the caller should handle panel rotation separately.

  return { pdfDoc, page };
}
