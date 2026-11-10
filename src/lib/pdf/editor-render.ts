import sharp from "sharp";
import { getImageCropRect } from "@/lib/editor/crop";
import type { EditorElement, EditorScene } from "@/lib/editor/schema";
import type { PanelDefinition } from "./layout";
import { TARGET_DPI } from "./layout";
import { wrapTextLines } from "./text-layout";
import { MIN_READING_PAGE_MM, PRINT_PROFILE_DPI } from "./print-profile";

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

/** Reading-page pixels at the qualified print DPI (74 x 105 mm). */
export const READING_PAGE_WIDTH_PX = Math.round((MIN_READING_PAGE_MM.widthMm / 25.4) * PRINT_PROFILE_DPI);
export const READING_PAGE_HEIGHT_PX = Math.round((MIN_READING_PAGE_MM.heightMm / 25.4) * PRINT_PROFILE_DPI);

function getImageHref(asset: AssetSource): string {
  return `data:${asset.mimeType};base64,${asset.buffer.toString("base64")}`;
}

function renderTextElement(element: Extract<EditorElement, { type: "text" }>) {
  // Same measurement as QA: a book that passes QA must wrap identically in print.
  const lines = wrapTextLines(element.text, element.width, {
    fontSize: element.fontSize,
    fontWeight: element.fontWeight,
    letterSpacing: element.letterSpacing,
  });
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
  const lineStep = element.fontSize * element.lineHeight;
  const blockHeight = Math.max(lineStep, lines.length * lineStep);
  const topY =
    element.verticalAlign === "middle"
      ? element.y + (element.height - blockHeight) / 2
      : element.verticalAlign === "bottom"
      ? element.y + element.height - blockHeight
      : element.y;
  const baseY = topY + element.fontSize;
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
            const dy = index === 0 ? 0 : lineStep;
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

/**
 * Render one canonical, upright page at an exact pixel size.
 *
 * The scene keeps its aspect ratio (aspect-preserving containment) and is
 * centred inside the requested box; the surrounding area is filled with the
 * page background. Both the reading PDF and the imposition sheet use this one
 * function, so the two outputs can never disagree about the book's content.
 */
export async function renderSceneTile(
  scene: EditorScene,
  targetWidthPx: number,
  targetHeightPx: number,
  assets: Map<string, AssetSource>
): Promise<Buffer> {
  const scale = Math.min(
    targetWidthPx / scene.page.widthPx,
    targetHeightPx / scene.page.heightPx
  );
  const drawWidth = scene.page.widthPx * scale;
  const drawHeight = scene.page.heightPx * scale;
  const offsetX = (targetWidthPx - drawWidth) / 2;
  const offsetY = (targetHeightPx - drawHeight) / 2;
  const elements = scene.elements
    .slice()
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((element) => renderSvgElement(element, assets))
    .join("");

  const svg = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${targetWidthPx}"
      height="${targetHeightPx}"
      viewBox="0 0 ${targetWidthPx} ${targetHeightPx}"
    >
      <rect x="0" y="0" width="${targetWidthPx}" height="${targetHeightPx}" fill="${scene.page.backgroundColor}" />
      <g transform="translate(${offsetX} ${offsetY}) scale(${scale})">
        <rect
          x="0"
          y="0"
          width="${scene.page.widthPx}"
          height="${scene.page.heightPx}"
          fill="${scene.page.backgroundColor}"
        />
        ${elements}
      </g>
    </svg>
  `;

  return sharp(Buffer.from(svg))
    .flatten({ background: scene.page.backgroundColor })
    .png()
    .toBuffer();
}

/**
 * Canonical upright page render for the 74 x 105 mm reading PDF. No rotation
 * happens here; rotation belongs to the A4 imposition step.
 */
export async function renderEditorSceneForReading(
  scene: EditorScene,
  assets: Map<string, AssetSource>
): Promise<Buffer> {
  return renderSceneTile(scene, READING_PAGE_WIDTH_PX, READING_PAGE_HEIGHT_PX, assets);
}

/**
 * Panel-sized render for the foldable A4 sheet. The page is rendered upright
 * first (same canonical content) and only then rotated 180 degrees for the
 * bottom row, which is what the fold/cut sequence requires.
 */
export async function renderEditorSceneForPanel(
  scene: EditorScene,
  panel: PanelDefinition,
  assets: Map<string, AssetSource>
): Promise<Buffer> {
  const upright = await renderSceneTile(scene, mmToPixels(panel.width), mmToPixels(panel.height), assets);
  if (panel.rotation === 180) {
    return sharp(upright).rotate(180).png().toBuffer();
  }
  return upright;
}
