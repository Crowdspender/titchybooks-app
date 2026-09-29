import { z } from "zod";

/**
 * Structured output contract for the CONTENT stage of the autonomous pipeline.
 *
 * The LLM never emits geometry — it only produces a title plus text for
 * existing template text elements (referenced by id). The composer turns this
 * into `templateTextOverrides`, which mergedPages() applies at render time.
 */
export const contentPlanSchema = z.object({
  title: z.string().min(1).max(120),
  overrides: z.array(
    z.object({
      templateElementId: z.string().min(1),
      text: z.string().min(1).max(5000),
    }),
  ),
});

export type ContentPlan = z.infer<typeof contentPlanSchema>;

/** Parse and validate a raw LLM JSON string as a content plan. */
export function parseContentPlan(raw: string): ContentPlan | null {
  try {
    return contentPlanSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
