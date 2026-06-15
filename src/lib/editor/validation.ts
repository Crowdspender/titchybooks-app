import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import {
  EDITOR_PAGE_WIDTH_PX,
  EDITOR_PAGE_HEIGHT_PX,
} from "./constants";
import {
  createEmptyEditorScene,
  editorSceneSchema,
  stringifyEditorScene,
  type EditorElement,
  type EditorScene,
} from "./schema";
import { PANELS } from "@/lib/pdf/layout";

export interface EmptySubmissionPageSeed {
  pageLabel: PageLabel;
  order: number;
  scene: EditorScene;
  sceneJson: string;
}

export function createEmptySubmissionPageSeeds(): EmptySubmissionPageSeed[] {
  return PAGE_LABELS.map((pageLabel, order) => {
    const scene = createEmptyEditorScene();
    return {
      pageLabel,
      order,
      scene,
      sceneJson: stringifyEditorScene(scene),
    };
  });
}

export function validateEditorScene(scene: unknown): EditorScene {
  return editorSceneSchema.parse(scene);
}

export function isKnownPageLabel(value: string): value is PageLabel {
  return PAGE_LABELS.includes(value as PageLabel);
}

// ---------------------------------------------------------------------------
// DPI / Resolution checking
// ---------------------------------------------------------------------------

/** Minimum DPI before a soft warning is shown. */
export const DPI_WARNING_THRESHOLD = 200;
/** Below this DPI a hard warning blocks submission (unless user confirms). */
export const DPI_HARD_THRESHOLD = 150;

export interface DpiWarning {
  elementId: string;
  pageLabel: string;
  dpi: number;
  severity: "warning" | "error";
}

/**
 * Calculate the effective DPI of an image element as it will appear in print.
 *
 * The element occupies `elementWidth` editor-pixels on a page that is
 * `editorPageWidthPx` wide and maps to `physicalWidthMm` in the real world.
 * The asset provides `assetNativeWidth` pixels, but crop.scaleX may zoom in,
 * reducing the effective source resolution that covers the frame.
 */
export function calculateImageElementDpi(
  elementWidth: number,
  cropScaleX: number,
  assetNativeWidth: number,
  physicalWidthMm: number,
): number {
  // Effective source pixels that cover the element frame after crop zoom.
  const effectivePx = (elementWidth * assetNativeWidth) / (elementWidth * cropScaleX);
  // Physical size of the element in inches.
  const physicalInches = (elementWidth / EDITOR_PAGE_WIDTH_PX) * (physicalWidthMm / 25.4);
  if (physicalInches <= 0) return Infinity;
  return effectivePx / physicalInches;
}

/**
 * Scan all pages of a submission and return DPI warnings for any image
 * elements that fall below the warning threshold.
 */
export function checkSubmissionResolution(
  pages: Array<{ pageLabel: string; scene: EditorScene }>,
  assetDimensions: Map<string, { width: number; height: number }>,
): DpiWarning[] {
  const warnings: DpiWarning[] = [];

  for (const { pageLabel, scene } of pages) {
    const panel = PANELS.find((p) => p.pageLabel === pageLabel);
    if (!panel) continue;

    for (const element of scene.elements) {
      if (element.type !== "image" || !element.visible) continue;

      const dims = assetDimensions.get(element.assetId);
      if (!dims || dims.width <= 0 || dims.height <= 0) continue;

      const dpiW = calculateImageElementDpi(
        element.width,
        element.crop.scaleX,
        dims.width,
        panel.width,
      );
      const dpiH = calculateImageElementDpi(
        element.height,
        element.crop.scaleY,
        dims.height,
        panel.height,
      );
      const dpi = Math.min(dpiW, dpiH);

      if (dpi < DPI_HARD_THRESHOLD) {
        warnings.push({ elementId: element.id, pageLabel, dpi: Math.round(dpi), severity: "error" });
      } else if (dpi < DPI_WARNING_THRESHOLD) {
        warnings.push({ elementId: element.id, pageLabel, dpi: Math.round(dpi), severity: "warning" });
      }
    }
  }

  return warnings;
}

/**
 * Convenience: calculate DPI for a single image element given its asset.
 */
export function getElementDpi(
  element: Extract<EditorElement, { type: "image" }>,
  assetWidth: number,
  assetHeight: number,
  physicalWidthMm: number,
  physicalHeightMm: number,
): number {
  const dpiW = calculateImageElementDpi(element.width, element.crop.scaleX, assetWidth, physicalWidthMm);
  const dpiH = calculateImageElementDpi(element.height, element.crop.scaleY, assetHeight, physicalHeightMm);
  return Math.round(Math.min(dpiW, dpiH));
}
