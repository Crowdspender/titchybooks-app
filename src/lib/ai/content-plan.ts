import { z } from "zod";
import { PAGE_LABELS } from "@/lib/constants";
import { PRINT_PALETTE_IDS, type PrintPaletteId } from "./print-palette";

/**
 * Structured output contract for the CONTENT stage of the autonomous pipeline.
 *
 * The LLM never emits geometry — it only produces a book brief, a page outline
 * and text for existing template slots (referenced by element id). The composer
 * turns this into `templateTextOverrides`, which mergedPages() applies at
 * render time.
 *
 * v1 (title + overrides) stays readable so jobs that were mid-flight before the
 * upgrade can still resume; every new plan is written as v2.
 */
const overrideSchema = z.object({
  templateElementId: z.string().min(1),
  // Empty text is structurally valid so a paginated repair base (where a
  // trailing page may momentarily hold no text) can round-trip; validation
  // still rejects empty overrides for required slots as `empty-text`.
  text: z.string().max(5000),
});

const outlineEntrySchema = z.object({
  pageLabel: z.enum(PAGE_LABELS),
  purpose: z.string().min(1).max(300),
});

const briefSchema = z.object({
  purpose: z.string().min(1).max(400),
  audience: z.string().min(1).max(200),
  tone: z.string().min(1).max(120),
  progression: z.string().min(1).max(800),
});

export const contentPlanV1Schema = z.object({
  version: z.literal(1).optional(),
  title: z.string().min(1).max(120),
  overrides: z.array(overrideSchema),
});

export const contentPlanV2Schema = z.object({
  version: z.literal(2),
  brief: briefSchema,
  outline: z.array(outlineEntrySchema).min(1).max(8),
  title: z.string().min(1).max(120),
  // Older plans omit this field. Unknown choices are discarded so composition
  // can select a qualified template-hue default; arbitrary colors never pass.
  palette: z.preprocess((value) => PRINT_PALETTE_IDS.includes(value as PrintPaletteId) ? value : undefined, z.enum(PRINT_PALETTE_IDS).optional()),
  overrides: z.array(overrideSchema),
});

/** Repairs carry text patches, never replacement book metadata. */
export const contentRepairSchema = z.object({
  overrides: z.array(overrideSchema).min(1),
});

export type ContentRepair = z.infer<typeof contentRepairSchema>;
export type ContentRepairResult =
  | { success: true; data: ContentRepair }
  | { success: false; error: string };

/** Validate the exact requested patch and return bounded, actionable feedback. */
export function parseContentRepair(raw: string, targets: ReadonlySet<string>): ContentRepairResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { success: false, error: 'Invalid JSON. Return one complete JSON object with an "overrides" array, double-quoted keys and strings, and no markdown or trailing commas.' };
  }
  const parsed = contentRepairSchema.superRefine((patch, ctx) => {
    const seen = new Set<string>();
    patch.overrides.forEach((entry, index) => {
      const id = entry.templateElementId;
      if (!targets.has(id)) {
        ctx.addIssue({ code: "custom", path: ["overrides", index, "templateElementId"], message: `Element "${id}" was not requested in this repair; return only listed slot ids.` });
      }
      if (seen.has(id)) {
        ctx.addIssue({ code: "custom", path: ["overrides", index, "templateElementId"], message: `Duplicate override for "${id}"; return exactly one replacement per listed slot.` });
      }
      seen.add(id);
    });
    for (const id of targets) {
      if (!seen.has(id)) {
        ctx.addIssue({ code: "custom", path: ["overrides"], message: `Missing replacement for "${id}"; return every listed slot.` });
      }
    }
  }).safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 6)
      .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
      .join("; ").slice(0, 1000);
    return { success: false, error: `Invalid repair response: ${details}` };
  }
  return { success: true, data: parsed.data };
}

export type BookBrief = z.infer<typeof briefSchema>;
export type OutlineEntry = z.infer<typeof outlineEntrySchema>;
export type ContentOverride = z.infer<typeof overrideSchema>;

/** Legacy alias kept for callers that validate the shipped v1 shape directly. */
export const contentPlanSchema = contentPlanV1Schema;

export interface ContentPlan {
  version: 1 | 2;
  title: string;
  overrides: ContentOverride[];
  brief?: BookBrief;
  outline?: OutlineEntry[];
  palette?: PrintPaletteId;
}

/** Parse and validate a raw LLM JSON string as a content plan. */
export function parseContentPlan(raw: string): ContentPlan | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeContentPlan(json);
}

/** Normalize an already-parsed (or persisted) plan value. */
export function normalizeContentPlan(value: unknown): ContentPlan | null {
  const v2 = contentPlanV2Schema.safeParse(value);
  if (v2.success) {
    return {
      version: 2,
      title: v2.data.title,
      overrides: v2.data.overrides,
      brief: v2.data.brief,
      outline: v2.data.outline,
      ...(v2.data.palette ? { palette: v2.data.palette } : {}),
    };
  }
  const v1 = contentPlanV1Schema.safeParse(value);
  if (v1.success) {
    return { version: 1, title: v1.data.title, overrides: v1.data.overrides };
  }
  return null;
}

/** True when the plan carries the full brief/outline contract. */
export function isCompletePlan(plan: ContentPlan): plan is ContentPlan & { version: 2; brief: BookBrief; outline: OutlineEntry[] } {
  return plan.version === 2 && !!plan.brief && !!plan.outline && plan.outline.length > 0;
}
