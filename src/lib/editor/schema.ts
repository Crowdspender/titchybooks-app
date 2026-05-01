import { z } from "zod";
import { PAGE_LABELS } from "@/lib/constants";
import {
  EDITOR_DEFAULT_BACKGROUND_COLOR,
  EDITOR_MAX_ELEMENTS_PER_PAGE,
  EDITOR_PAGE_HEIGHT_PX,
  EDITOR_PAGE_WIDTH_PX,
  EDITOR_SCENE_VERSION,
} from "./constants";

const colorSchema = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/);

const colorOrTransparentSchema = z.union([
  colorSchema,
  z.literal("transparent"),
]);

const baseElementSchema = z.object({
  id: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
  rotation: z.number().finite(),
  opacity: z.number().min(0).max(1),
  locked: z.boolean(),
  visible: z.boolean(),
  zIndex: z.number().int().min(0),
});

const imageElementSchema = baseElementSchema.extend({
  type: z.literal("image"),
  assetId: z.string().min(1),
  crop: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    scaleX: z.number().positive(),
    scaleY: z.number().positive(),
  }),
  cornerRadius: z.number().min(0).optional(),
});

const textElementSchema = baseElementSchema.extend({
  type: z.literal("text"),
  text: z.string().max(5000),
  fontFamily: z.string().min(1).max(100),
  fontSize: z.number().positive().max(400),
  fontWeight: z.number().int().min(100).max(900),
  lineHeight: z.number().positive().max(10),
  letterSpacing: z.number().min(-20).max(200),
  color: colorSchema,
  align: z.enum(["left", "center", "right"]),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
});

const shapeElementSchema = baseElementSchema.extend({
  type: z.literal("shape"),
  shape: z.enum(["rect", "circle", "line"]),
  fill: colorOrTransparentSchema,
  stroke: colorOrTransparentSchema.optional(),
  strokeWidth: z.number().min(0).max(100).optional(),
});

export const editorElementSchema = z.discriminatedUnion("type", [
  imageElementSchema,
  textElementSchema,
  shapeElementSchema,
]);

export const editorSceneSchema = z.object({
  version: z.literal(EDITOR_SCENE_VERSION),
  page: z.object({
    widthPx: z.number().positive(),
    heightPx: z.number().positive(),
    backgroundColor: colorSchema,
  }),
  elements: z.array(editorElementSchema).max(EDITOR_MAX_ELEMENTS_PER_PAGE),
  // Instance-only: per-element text overrides for template text elements.
  // Keys are TemplateElement IDs (must reference a template element of type
  // "text"); values are the user's edited text content. Position, size,
  // styling, and other template-element properties remain fixed.
  templateTextOverrides: z
    .record(z.string().min(1), z.string().max(5000))
    .optional(),
});

export const editorPageLabelSchema = z.enum(PAGE_LABELS);

export type EditorElement = z.infer<typeof editorElementSchema>;
export type EditorScene = z.infer<typeof editorSceneSchema>;
export type EditorPageLabel = z.infer<typeof editorPageLabelSchema>;

export function createEmptyEditorScene(): EditorScene {
  return {
    version: EDITOR_SCENE_VERSION,
    page: {
      widthPx: EDITOR_PAGE_WIDTH_PX,
      heightPx: EDITOR_PAGE_HEIGHT_PX,
      backgroundColor: EDITOR_DEFAULT_BACKGROUND_COLOR,
    },
    elements: [],
  };
}

export function stringifyEditorScene(scene: EditorScene): string {
  return JSON.stringify(scene);
}

export function parseEditorScene(sceneJson: string): EditorScene {
  const parsed = JSON.parse(sceneJson) as unknown;
  return editorSceneSchema.parse(parsed);
}
