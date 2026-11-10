import { z } from "zod";
import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import { EDITOR_DEFAULT_BACKGROUND_COLOR } from "@/lib/editor/constants";
import { editorElementSchema, type EditorElement } from "@/lib/editor/schema";
import {
  PAGE_CONTENT_ROLE,
  ROLE_TEXT_BUDGET,
  isFixedContent,
  type BookSlotRole,
  type Rect,
} from "./book-contract";
import { maxCharsForBox, type TextStyle } from "@/lib/pdf/text-layout";

/**
 * AI template manifest.
 *
 * A manifest is the only description the autonomous pipeline is allowed to
 * generate against. Slot identities are element ids inside `elementJson`, never
 * TemplateElement row ids, so the identity survives re-seeding and re-saving.
 *
 * The manifest is captured when a template is published and pinned onto every
 * book instance, so editing or unpublishing the source template cannot change
 * a book that already exists.
 */
export interface AiTemplateSlot {
  /** Element id inside the template scene. */
  id: string;
  pageLabel: PageLabel;
  role: BookSlotRole;
  /** False for locked design text and the back-cover branding strip. */
  generated: boolean;
  /** Generated slots are required unless the template can complete without them. */
  required: boolean;
  text: string;
  box: Rect;
  style: TextStyle;
  fontFamily: string;
  minChars: number;
  maxChars: number;
}

export interface AiTemplateImage {
  id: string;
  assetId: string;
  box: Rect;
}

export interface AiTemplatePage {
  pageLabel: PageLabel;
  /** Base page colour, part of the template's visual identity. */
  backgroundColor: string;
  slots: AiTemplateSlot[];
  /** Template artwork the book inherits; the model never chooses assets. */
  images: AiTemplateImage[];
}

export interface AiTemplateManifest {
  schemaVersion: 1;
  templateId: string;
  templateVersion: number;
  capturedAt: string;
  pages: AiTemplatePage[];
}

export interface TemplatePageSource {
  pageLabel: PageLabel;
  backgroundColor?: string;
  elements: EditorElement[];
}

function textStyleOf(element: Extract<EditorElement, { type: "text" }>): TextStyle {
  return {
    fontSize: element.fontSize,
    fontWeight: element.fontWeight,
    letterSpacing: element.letterSpacing,
    lineHeight: element.lineHeight,
  };
}

function toSlot(element: Extract<EditorElement, { type: "text" }>, pageLabel: PageLabel): AiTemplateSlot {
  const role = PAGE_CONTENT_ROLE[pageLabel];
  const box = { x: element.x, y: element.y, width: element.width, height: element.height };
  const style = textStyleOf(element);
  const generated = element.visible && !isFixedContent({ pageLabel, text: element.text, locked: element.locked });
  const capacity = maxCharsForBox(box.width, box.height, style);
  const roleBudget = ROLE_TEXT_BUDGET[role];
  return {
    id: element.id,
    pageLabel,
    role,
    generated,
    required: generated,
    text: element.text,
    box,
    style,
    fontFamily: element.fontFamily,
    minChars: Math.min(roleBudget.minChars, capacity),
    maxChars: Math.max(1, Math.min(roleBudget.maxChars, capacity)),
  };
}

/**
 * Build a manifest from parsed template scenes. Pages are emitted in reading
 * order and always cover all eight labels (an absent page yields an empty slot
 * list, which preflight reports).
 */
export function buildTemplateManifest(input: {
  templateId: string;
  templateVersion: number;
  pages: TemplatePageSource[];
  capturedAt?: Date;
}): AiTemplateManifest {
  const byLabel = new Map(input.pages.map((page) => [page.pageLabel, page]));
  return {
    schemaVersion: 1,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    pages: PAGE_LABELS.map((pageLabel) => ({
      pageLabel,
      backgroundColor: byLabel.get(pageLabel)?.backgroundColor ?? EDITOR_DEFAULT_BACKGROUND_COLOR,
      slots: (byLabel.get(pageLabel)?.elements ?? [])
        .filter((el): el is Extract<EditorElement, { type: "text" }> => el.type === "text")
        .map((el) => toSlot(el, pageLabel)),
      images: (byLabel.get(pageLabel)?.elements ?? [])
        .filter((el): el is Extract<EditorElement, { type: "image" }> => el.type === "image" && el.visible)
        .map((el) => ({ id: el.id, assetId: el.assetId, box: { x: el.x, y: el.y, width: el.width, height: el.height } })),
    })),
  };
}

/** Build a manifest directly from persisted TemplateElement rows. */
export function buildManifestFromRows(input: {
  templateId: string;
  templateVersion: number;
  rows: Array<{ pageLabel: string; elementJson: string }>;
  pageBackgrounds?: ReadonlyMap<PageLabel, string>;
  capturedAt?: Date;
}): { manifest: AiTemplateManifest; invalidElements: Array<{ pageLabel: string; reason: string }> } {
  const parsed = new Map<PageLabel, EditorElement[]>();
  const invalidElements: Array<{ pageLabel: string; reason: string }> = [];
  for (const row of input.rows) {
    if (!(PAGE_LABELS as readonly string[]).includes(row.pageLabel)) {
      invalidElements.push({ pageLabel: row.pageLabel, reason: "Unknown page label" });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(row.elementJson);
    } catch {
      invalidElements.push({ pageLabel: row.pageLabel, reason: "Template element is not valid JSON" });
      continue;
    }
    const result = editorElementSchema.safeParse(json);
    if (!result.success) {
      invalidElements.push({ pageLabel: row.pageLabel, reason: "Template element does not match the editor schema" });
      continue;
    }
    const pageLabel = row.pageLabel as PageLabel;
    const elements = parsed.get(pageLabel) ?? [];
    elements.push(result.data);
    parsed.set(pageLabel, elements);
  }
  const manifest = buildTemplateManifest({
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    pages: [...parsed.entries()].map(([pageLabel, elements]) => ({
      pageLabel,
      elements,
      backgroundColor: input.pageBackgrounds?.get(pageLabel),
    })),
    capturedAt: input.capturedAt,
  });
  return { manifest, invalidElements };
}

/** All slots the model may write into, in reading order. */
export function generatedSlots(manifest: AiTemplateManifest): AiTemplateSlot[] {
  return manifest.pages.flatMap((page) => page.slots.filter((slot) => slot.generated));
}

export function slotIndex(manifest: AiTemplateManifest): Map<string, AiTemplateSlot> {
  return new Map(generatedSlots(manifest).map((slot) => [slot.id, slot]));
}

/** Pinned template pages kept on an AI book so later template edits cannot alter it. */
export interface PinnedTemplate {
  schemaVersion: 1;
  templateId: string;
  templateVersion: number;
  pinnedAt: string;
  manifest: AiTemplateManifest;
  pages: Array<{ pageLabel: PageLabel; backgroundColor: string; elements: EditorElement[] }>;
}

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });
const styleSchema = z.object({ fontSize: z.number().positive(), fontWeight: z.number(), letterSpacing: z.number(), lineHeight: z.number().positive() });

const slotSchema = z.object({
  id: z.string().min(1),
  pageLabel: z.enum(PAGE_LABELS),
  role: z.enum(["title", "body", "closing"]),
  generated: z.boolean(),
  required: z.boolean(),
  text: z.string(),
  box: rectSchema,
  style: styleSchema,
  fontFamily: z.string().min(1),
  minChars: z.number().int().nonnegative(),
  maxChars: z.number().int().positive(),
});

export const aiTemplateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  templateId: z.string().min(1),
  templateVersion: z.number().int().nonnegative(),
  capturedAt: z.string().min(1),
  pages: z.array(
    z.object({
      pageLabel: z.enum(PAGE_LABELS),
      backgroundColor: z
        .string()
        .regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/)
        .default(EDITOR_DEFAULT_BACKGROUND_COLOR),
      slots: z.array(slotSchema),
      images: z.array(z.object({ id: z.string().min(1), assetId: z.string().min(1), box: rectSchema })).default([]),
    }),
  ),
});

export const pinnedTemplateSchema = z.object({
  schemaVersion: z.literal(1),
  templateId: z.string().min(1),
  templateVersion: z.number().int().nonnegative(),
  pinnedAt: z.string().min(1),
  manifest: aiTemplateManifestSchema,
  pages: z.array(
    z.object({
      pageLabel: z.enum(PAGE_LABELS),
      backgroundColor: z
        .string()
        .regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/)
        .default(EDITOR_DEFAULT_BACKGROUND_COLOR),
      elements: z.array(editorElementSchema),
    }),
  ),
});

/** Parse a persisted pinned template; null when the payload is not one. */
export function parsePinnedTemplate(value: unknown): PinnedTemplate | null {
  if (value === null || value === undefined) return null;
  const result = pinnedTemplateSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Parse a persisted manifest (e.g. Submission.aiManifest). */
export function parseAiTemplateManifest(value: unknown): AiTemplateManifest | null {
  if (value === null || value === undefined) return null;
  const result = aiTemplateManifestSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function buildPinnedTemplate(input: {
  templateId: string;
  templateVersion: number;
  manifest: AiTemplateManifest;
  pages: TemplatePageSource[];
  pinnedAt?: Date;
}): PinnedTemplate {
  return {
    schemaVersion: 1,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    pinnedAt: (input.pinnedAt ?? new Date()).toISOString(),
    manifest: input.manifest,
    // A pin must be self-contained: every page carries a concrete colour so a
    // later change to the source template cannot alter an existing book.
    pages: input.pages.map((page) => ({
      pageLabel: page.pageLabel,
      backgroundColor: page.backgroundColor ?? EDITOR_DEFAULT_BACKGROUND_COLOR,
      elements: page.elements,
    })),
  };
}
