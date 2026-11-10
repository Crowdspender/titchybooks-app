import { z } from "zod";
import { PAGE_LABELS } from "@/lib/constants";

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
  text: z.string().min(1).max(5000),
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
  overrides: z.array(overrideSchema),
});

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
