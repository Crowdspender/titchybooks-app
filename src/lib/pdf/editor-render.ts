import sharp from "sharp";
import { getImageCropRect } from "@/lib/editor/crop";
import type { EditorElement, EditorScene } from "@/lib/editor/schema";
import type { PanelDefinition } from "./layout";
import { TARGET_DPI } from "./layout";

interface AssetSource {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

function mmToPixels(mm: number): number {
  return Math.round((mm / 25.4) * TARGET_DPI);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Estimate the rendered width of a single character at the given font size.
 * Uses a lookup table derived from average proportional-font glyph widths.
 * Not pixel-perfect for every typeface, but close enough to replicate canvas
 * word-wrap behaviour without a native font renderer on the server.
 */
function estimateCharWidth(char: string, fontSize: number, fontWeight: number): number {
  const boldFactor = fontWeight >= 600 ? 1.1 : 1.0;
  let ratio: number;

  if (char === " " || char === "\t") {
    ratio = 0.28;
  } else if ("iIjl!|".includes(char)) {
    ratio = 0.30;
  } else if ("frt".includes(char)) {
    ratio = 0.37;
  } else if ("sz".includes(char)) {
    ratio = 0.48;
  } else if ("acegknopquvxy".includes(char)) {
    ratio = 0.53;
  } else if ("bdh".includes(char)) {
    ratio = 0.55;
  } else if ("ABCDEFGHJKLNOPQRSTUVXYZ0123456789".includes(char)) {
    ratio = 0.62;
  } else if ("mwMW".includes(char)) {
    ratio = 0.77;
  } else {
    ratio = 0.54;
  }

  return fontSize * ratio * boldFactor;
}

/**
 * Measure the approximate pixel width of a string at the given font settings.
 * `letterSpacing` is already in scene-coordinate pixels (same unit as fontSize).
 */
function estimateStringWidth(
  text: string,
  fontSize: number,
  fontWeight: number,
  letterSpacing: number
): number {
  let width = 0;
  for (const char of text) {
    width += estimateCharWidth(char, fontSize, fontWeight) + letterSpacing;
  }
  return width;
}

/**
 * Word-wrap `rawText` to fit inside `maxWidth`, matching the behaviour of
 * Konva's `wrap="word"` mode. Explicit newlines in the source text are
 * preserved as paragraph breaks, then each paragraph is greedily wrapped.
 */
function wrapTextLines(
  rawText: string,
  maxWidth: number,
  fontSize: number,
  fontWeight: number,
  letterSpacing: number
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

function getImageHref(asset: AssetSource): string {
  return `data:${asset.mimeType};base64,${asset.buffer.toString("base64")}`;
}

function renderTextElement(element: Extract<EditorElement, { type: "text" }>) {
  const lines = wrapTextLines(
    element.text,
    element.width,
    element.fontSize,
    element.fontWeight,
    element.letterSpacing
  );
  const anchor =
    element.align === "center"
      ? "middle"
      : element.align === "right"
      ? "end"
      : "start";
  const x =
    element.align === "center"
      ? element.x + element.width / 2
      : element.align === "right"
      ? element.x + element.width
      : element.x;
  const baseY = element.y + element.fontSize;
  const rotationCenterX = element.x + element.width / 2;
  const rotationCenterY = element.y + element.height / 2;

  return `
    <g opacity="${element.opacity}" transform="rotate(${element.rotation} ${rotationCenterX} ${rotationCenterY})">
      <text
        x="${x}"
        y="${baseY}"
        fill="${element.color}"
        font-family="${escapeXml(element.fontFamily)}"
        font-size="${element.fontSize}"
        font-weight="${element.fontWeight}"
        text-anchor="${anchor}"
      >
        ${lines
          .map((line: string, index: number) => {
            const dy = index === 0 ? 0 : element.fontSize * element.lineHeight;
            return `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`;
          })
          .join("")}
      </text>
    </g>
  `;
}

function renderShapeElement(element: Extract<EditorElement, { type: "shape" }>) {
  const rotationCenterX = element.x + element.width / 2;
  const rotationCenterY = element.y + element.height / 2;
  const commonAttrs = `opacity="${element.opacity}" transform="rotate(${element.rotation} ${rotationCenterX} ${rotationCenterY})"`;

  if (element.shape === "circle") {
    const radius = Math.min(element.width, element.height) / 2;
    return `
      <circle
        cx="${element.x + element.width / 2}"
        cy="${element.y + element.height / 2}"
        r="${radius}"
        fill="${element.fill}"
        stroke="${element.stroke ?? "none"}"
        stroke-width="${element.strokeWidth ?? 0}"
        ${commonAttrs}
      />
    `;
  }

  if (element.shape === "line") {
    return `
      <line
        x1="${element.x}"
        y1="${element.y}"
        x2="${element.x + element.width}"
        y2="${element.y}"
        stroke="${element.stroke ?? element.fill}"
        stroke-width="${element.strokeWidth ?? 2}"
        ${commonAttrs}
      />
    `;
  }

  return `
    <rect
      x="${element.x}"
      y="${element.y}"
      width="${element.width}"
      height="${element.height}"
      fill="${element.fill}"
      stroke="${element.stroke ?? "none"}"
      stroke-width="${element.strokeWidth ?? 0}"
      ${commonAttrs}
    />
  `;
}

function renderImageElement(
  element: Extract<EditorElement, { type: "image" }>,
  asset: AssetSource
) {
  const clipId = `clip-${element.id}`;
  const rotationCenterX = element.x + element.width / 2;
  const rotationCenterY = element.y + element.height / 2;
  const cropRect = getImageCropRect({
    imageWidth: asset.width,
    imageHeight: asset.height,
    frameWidth: element.width,
    frameHeight: element.height,
    crop: element.crop,
  });
  const scale = Math.max(
    element.width / cropRect.width,
    element.height / cropRect.height
  );
  const renderedImageWidth = asset.width * scale;
  const renderedImageHeight = asset.height * scale;
  const renderedImageX = element.x - cropRect.x * scale;
  const renderedImageY = element.y - cropRect.y * scale;

  return `
    <defs>
      <clipPath id="${clipId}">
        <rect
          x="${element.x}"
          y="${element.y}"
          width="${element.width}"
          height="${element.height}"
          rx="${element.cornerRadius ?? 0}"
          ry="${element.cornerRadius ?? 0}"
        />
      </clipPath>
    </defs>
    <image
      href="${getImageHref(asset)}"
      x="${renderedImageX}"
      y="${renderedImageY}"
      width="${renderedImageWidth}"
      height="${renderedImageHeight}"
      preserveAspectRatio="none"
      opacity="${element.opacity}"
      clip-path="url(#${clipId})"
      transform="rotate(${element.rotation} ${rotationCenterX} ${rotationCenterY})"
    />
  `;
}

function renderSvgElement(element: EditorElement, assets: Map<string, AssetSource>) {
  if (!element.visible) {
    return "";
  }

  if (element.type === "image") {
    const asset = assets.get(element.assetId);
    if (!asset) {
      throw new Error(`Missing asset for image element ${element.id}`);
    }
    return renderImageElement(element, asset);
  }

  if (element.type === "text") {
    return renderTextElement(element);
  }

  return renderShapeElement(element);
}

export async function renderEditorSceneForPanel(
  scene: EditorScene,
  panel: PanelDefinition,
  assets: Map<string, AssetSource>
): Promise<Buffer> {
  const widthPx = mmToPixels(panel.width);
  const heightPx = mmToPixels(panel.height);
  const elements = scene.elements
    .slice()
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((element) => renderSvgElement(element, assets))
    .join("");

  const svg = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${widthPx}"
      height="${heightPx}"
      viewBox="0 0 ${scene.page.widthPx} ${scene.page.heightPx}"
    >
      <rect
        x="0"
        y="0"
        width="${scene.page.widthPx}"
        height="${scene.page.heightPx}"
        fill="${scene.page.backgroundColor}"
      />
      ${elements}
    </svg>
  `;

  let pipeline = sharp(Buffer.from(svg)).png();

  if (panel.rotation === 180) {
    pipeline = pipeline.rotate(180);
  }

  return pipeline.toBuffer();
}
