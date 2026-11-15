import { z } from "zod";

export const DESIGN_FAMILIES = ["Lora", "Source Sans 3", "Nunito"] as const;
export const DESIGN_ROLES = ["coverTitle", "heading", "body", "caption", "brand"] as const;
export const STYLE_PROPERTIES = ["fontFamily", "fontSize", "fontWeight", "italic", "color", "align", "verticalAlign", "lineHeight", "tracking", "paragraphGap", "firstLineIndent"] as const;
export const designColorSchema = z.string().regex(/^#(?:[\da-fA-F]{3}){1,2}$/);
export const styleOverrideSchema = z.object({
  fontFamily: z.enum(DESIGN_FAMILIES).optional(),
  fontSize: z.number().finite().min(12).max(120).optional(),
  fontWeight: z.union([z.literal(400), z.literal(700)]).optional(),
  italic: z.boolean().optional(),
  color: designColorSchema.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  lineHeight: z.number().finite().min(1.1).max(1.8).optional(),
  tracking: z.number().finite().min(-0.02).max(0.12).optional(),
  paragraphGap: z.number().finite().min(0).max(1.5).optional(),
  firstLineIndent: z.number().finite().min(0).max(2).optional(),
}).strict();
export const SPACING_LIMITS = { lineHeight: [1.1, 1.8], tracking: [-0.02, 0.12], paragraphGap: [0, 1.5], firstLineIndent: [0, 2] } as const;
export type SpacingProperty = keyof typeof SPACING_LIMITS;
function rangeSchema(min: number, max: number) {
  return z.object({ min: z.number().min(min).max(max), max: z.number().min(min).max(max) }).strict().refine(value => value.min <= value.max, 'Invalid spacing range');
}
export const stylePolicySchema = z.object({
  allowed: z.array(z.enum(STYLE_PROPERTIES)).max(STYLE_PROPERTIES.length),
  minFontSize: z.number().min(12).max(120).optional(),
  maxFontSize: z.number().min(12).max(120).optional(),
  limits: z.object({
    lineHeight: rangeSchema(1.1, 1.8).optional(),
    tracking: rangeSchema(-0.02, 0.12).optional(),
    paragraphGap: rangeSchema(0, 1.5).optional(),
    firstLineIndent: rangeSchema(0, 2).optional(),
  }).strict().optional(),
}).strict().refine(p => p.minFontSize === undefined || p.maxFontSize === undefined || p.minFontSize <= p.maxFontSize, "Invalid font size range");
export const paletteSchema = z.object({ paper: designColorSchema, ink: designColorSchema, accent: designColorSchema }).strict();
export const PRESET_IDS = ["classic", "modern", "playful"] as const;
export type PresetId = typeof PRESET_IDS[number];
export const pageDesignSchema = z.object({
  version: z.literal(1),
  presetId: z.enum(PRESET_IDS).optional(),
  presetVersion: z.literal(1).optional(),
  palette: paletteSchema.optional(),
  roleStyles: z.partialRecord(z.enum([...DESIGN_ROLES, "untagged"]), styleOverrideSchema).optional(),
  backgroundColor: designColorSchema.optional(),
}).strict().refine(value => Boolean(value.presetId) === Boolean(value.presetVersion), "Preset identity and version must be specified together");
export type StyleOverride = z.infer<typeof styleOverrideSchema>;
export type StyleProperty = typeof STYLE_PROPERTIES[number];
export type DesignRole = typeof DESIGN_ROLES[number];
export type PageDesign = z.infer<typeof pageDesignSchema>;
export type DesignPalette = z.infer<typeof paletteSchema>;
export type DesignFamily = typeof DESIGN_FAMILIES[number];
