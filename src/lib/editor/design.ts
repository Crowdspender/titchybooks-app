import type { EditorElement, EditorScene } from "./schema";
import { DESIGN_FAMILIES, STYLE_PROPERTIES, SPACING_LIMITS, type SpacingProperty, styleOverrideSchema, type DesignFamily, type DesignPalette, type PresetId, type PageDesign, type StyleOverride, type StyleProperty } from "./design-schema";
import { BACK_COVER_BRAND_TEXT } from "./constants";

export const DESIGN_PRESETS: Record<PresetId, { name: string; family: DesignFamily; palette: DesignPalette; description: string }> = {
  classic: { name: "Classic Story", family: "Lora", palette: { paper: "#fdf7ee", ink: "#3f2d1d", accent: "#b45309" }, description: "Warm paper. A literary voice." },
  modern: { name: "Modern Minimal", family: "Source Sans 3", palette: { paper: "#ffffff", ink: "#202c31", accent: "#087e83" }, description: "Clear, quiet, and considered." },
  playful: { name: "Playful", family: "Nunito", palette: { paper: "#fffaf2", ink: "#233453", accent: "#c64b3b" }, description: "Rounded letters. A little joy." },
};
export function isDesignFamily(family: string): family is DesignFamily {
  return (DESIGN_FAMILIES as readonly string[]).includes(family);
}
export function isProtectedDesign(element: EditorElement): boolean {
  return element.designRole === "brand" || (element.type === "text" && element.text.includes(BACK_COVER_BRAND_TEXT));
}
export function allowedStyleProperties(element: EditorElement): readonly StyleProperty[] {
  if (element.type !== "text" || isProtectedDesign(element) || element.locked) return [];
  return element.stylePolicy?.allowed ?? STYLE_PROPERTIES;
}
export function validateStyleOverride(element: EditorElement, patch: StyleOverride) {
  styleOverrideSchema.parse(patch);
  for (const key of Object.keys(SPACING_LIMITS) as SpacingProperty[]) {
    const value = patch[key], limits = element.stylePolicy?.limits?.[key];
    if (value !== undefined && limits && (value < limits.min || value > limits.max)) throw new Error(`Spacing is outside the template limits for ${element.id}`);
  }
  const allowed = allowedStyleProperties(element);
  if (Object.keys(patch).some(key => !allowed.includes(key as StyleProperty))) throw new Error(`Formatting is protected for ${element.id}`);
  if (patch.fontSize !== undefined && (patch.fontSize < (element.stylePolicy?.minFontSize ?? 12) || patch.fontSize > (element.stylePolicy?.maxFontSize ?? 120))) throw new Error(`Font size is outside the template limits for ${element.id}`);
}
function permitted(element: EditorElement, patch: StyleOverride): StyleOverride {
  const allowed = allowedStyleProperties(element);
  const filtered = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key as StyleProperty))) as StyleOverride;
  if (filtered.fontSize !== undefined) filtered.fontSize = Math.max(element.stylePolicy?.minFontSize ?? 12, Math.min(element.stylePolicy?.maxFontSize ?? 120, filtered.fontSize));
  for (const key of Object.keys(SPACING_LIMITS) as SpacingProperty[]) {
    const value = filtered[key], limits = element.stylePolicy?.limits?.[key];
    if (value !== undefined && limits) filtered[key] = Math.max(limits.min, Math.min(limits.max, value));
  }
  return filtered;
}
export function resolveDesignElement(element: EditorElement, design?: PageDesign, override?: StyleOverride): EditorElement {
  if (override) validateStyleOverride(element, override);
  if (isProtectedDesign(element)) return element;
  const preset = design?.presetId ? DESIGN_PRESETS[design.presetId] : undefined;
  const palette = design?.palette ?? preset?.palette;
  if (element.type === "shape" && element.paletteBinding && palette) {
    return element.shape === "line" ? { ...element, stroke: palette[element.paletteBinding] } : { ...element, fill: palette[element.paletteBinding] };
  }
  if (element.type !== "text" || !allowedStyleProperties(element).length) return element;
  let patch: StyleOverride = {};
  if (preset && palette) {
    patch = { fontFamily: preset.family, color: palette.ink, lineHeight: 1.45 };
    if (element.designRole) {
      const heading = element.designRole === "heading" || element.designRole === "coverTitle";
      patch = { ...patch, fontSize: element.designRole === "coverTitle" ? 64 : element.designRole === "heading" ? 40 : element.designRole === "caption" ? 28 : 33, fontWeight: heading ? 700 : 400, lineHeight: heading ? 1.15 : 1.45, paragraphGap: heading ? 0 : 0.5, tracking: 0, firstLineIndent: 0 };
    }
  }
  if (palette) patch.color = palette.ink;
  patch = { ...patch, ...design?.roleStyles?.[element.designRole ?? "untagged"] };
  patch = { ...permitted(element, patch), ...override };
  if (!Object.keys(patch).length) return element;
  // Any new typography uses a qualified font; original element data stays intact.
  const family = patch.fontFamily ?? (isDesignFamily(element.fontFamily) ? element.fontFamily : "Lora");
  if (!allowedStyleProperties(element).includes("fontFamily") && !isDesignFamily(element.fontFamily)) {
    // Color-only policies may retain legacy typography without substitution.
    if (Object.keys(patch).every(key => key === "color")) return { ...element, ...patch };
    throw new Error(`Choose a qualified font in the template before styling ${element.id}`);
  }
  const next = { ...element, ...patch, fontFamily: family, typographyVersion: 1 as const };
  next.fontWeight = next.fontWeight >= 600 ? 700 : 400;
  return next;
}
export function validateSceneDesign(scene: EditorScene, templates: EditorElement[] = []) {
  for (const [id, patch] of Object.entries(scene.templateStyleOverrides ?? {})) {
    const element = templates.find(el => el.id === id);
    if (!element) throw new Error(`Unknown template style element ${id}`);
    validateStyleOverride(element, patch);
  }
  for (const [id, patch] of Object.entries(scene.elementStyleOverrides ?? {})) {
    const element = scene.elements.find(el => el.id === id);
    if (!element) throw new Error(`Unknown user style element ${id}`);
    validateStyleOverride(element, patch);
  }
}
export function resolveSceneDesign(scene: EditorScene, templates: EditorElement[] = [], pinnedBackground?: string): EditorScene {
  validateSceneDesign(scene, templates);
  const ids = [...templates, ...scene.elements].map(element => element.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate element IDs');
  const palette = scene.design?.palette ?? (scene.design?.presetId ? DESIGN_PRESETS[scene.design.presetId].palette : undefined);
  const backgroundColor = scene.backgroundOverride ?? scene.design?.backgroundColor ?? palette?.paper ?? pinnedBackground ?? scene.page.backgroundColor;
  return {
    version: scene.version,
    page: { ...scene.page, backgroundColor },
    elements: [
      ...templates.map(element => {
        const resolved = resolveDesignElement(element, scene.design, scene.templateStyleOverrides?.[element.id]);
        return resolved.type === "text" && scene.templateTextOverrides?.[element.id] !== undefined ? { ...resolved, text: scene.templateTextOverrides[element.id] } : resolved;
      }),
      ...scene.elements.map(el => resolveDesignElement(el, scene.design, scene.elementStyleOverrides?.[el.id])),
    ],
  };
}
export function designForPreset(presetId: PresetId): PageDesign {
  return { version: 1, presetId, presetVersion: 1 };
}
