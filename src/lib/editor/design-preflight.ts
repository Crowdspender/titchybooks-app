import type { EditorScene } from "./schema";
import { layoutDesignText } from "./design-text-layout";
import { PANELS, MM_TO_POINTS } from "@/lib/pdf/layout";
import { EDITOR_SAFE_MARGIN_PX, BACK_COVER_BRAND_BAND_PX } from "./constants";
import { styleOverrideSchema } from "./design-schema";
import { isProtectedDesign } from "./design";

export interface DesignIssue { elementId: string; severity: "error" | "warning"; message: string; code?: 'overflow' | 'glyphs' | 'layout' }
export function pointsPerScenePixel(scene: EditorScene, pageLabel: string, reading = false): number {
  const panel = PANELS.find(p => p.pageLabel === pageLabel);
  const width = reading ? 74 : panel?.width ?? 68.3;
  const height = reading ? 105 : panel?.height ?? 97.9;
  return Math.min(width / scene.page.widthPx, height / scene.page.heightPx) * MM_TO_POINTS;
}
function luminance(hex: string) {
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map(c => c + c).join("");
  const parts = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722;
}
export function contrastRatio(a: string, b: string) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function preflightDesign(scene: EditorScene, pageLabel: string): DesignIssue[] {
  const issues: DesignIssue[] = [];
  for (const element of scene.elements) {
    if (element.type !== "text" || !element.visible || !element.typographyVersion) continue;
    const error = (message: string, code: DesignIssue['code'] = 'layout') => issues.push({ elementId: element.id, severity: "error" as const, message, code });
    const style = { fontFamily: element.fontFamily, fontSize: element.fontSize, fontWeight: element.fontWeight, lineHeight: element.lineHeight, tracking: element.tracking, paragraphGap: element.paragraphGap, firstLineIndent: element.firstLineIndent };
    if (!styleOverrideSchema.safeParse(style).success) { error("Typography is outside guided limits."); continue; }
    try {
      const layout = layoutDesignText(element);
      if (layout.height > element.height + 0.01 || layout.maxLineWidth > element.width + 0.01 || layout.bounds.x1 < -0.01 || layout.bounds.y1 < -0.01 || layout.bounds.x2 > element.width + 0.01 || layout.bounds.y2 > element.height + 0.01) error("Text overflows its frame. Reduce spacing or edit the text.", 'overflow');
      // Transform ink corners around the same top-left origin as Konva/SVG.
      const angle = element.rotation * Math.PI / 180;
      const corners = [[layout.bounds.x1, layout.bounds.y1], [layout.bounds.x2, layout.bounds.y1], [layout.bounds.x1, layout.bounds.y2], [layout.bounds.x2, layout.bounds.y2]].map(([x, y]) => ({ x: element.x + x * Math.cos(angle) - y * Math.sin(angle), y: element.y + x * Math.sin(angle) + y * Math.cos(angle) }));
      if (corners.some(p => p.x < EDITOR_SAFE_MARGIN_PX || p.y < EDITOR_SAFE_MARGIN_PX || p.x > scene.page.widthPx - EDITOR_SAFE_MARGIN_PX || p.y > scene.page.heightPx - EDITOR_SAFE_MARGIN_PX)) error("Text crosses the printable safe margin.");
      if (pageLabel === "BACK_COVER" && !isProtectedDesign(element) && corners.some(p => p.y > scene.page.heightPx - BACK_COVER_BRAND_BAND_PX)) error("Text overlaps the reserved branding band.");
      if (!isProtectedDesign(element) && element.designRole !== "caption" && element.fontSize * Math.min(pointsPerScenePixel(scene, pageLabel), pointsPerScenePixel(scene, pageLabel, true)) < 8) error("Text is smaller than 8 pt on the folded sheet.");
      if (contrastRatio(element.color, scene.page.backgroundColor) < 4.5) issues.push({ elementId: element.id, severity: "warning", message: "Low contrast against the page color; check a printed proof." });
    } catch (cause) { error(cause instanceof Error ? cause.message : "Text could not be measured.", 'glyphs'); }
  }
  return issues;
}
