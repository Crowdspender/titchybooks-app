import { sanitizeAiText } from "./protocol";
import type { ContentPlan } from "./content-plan";

/**
 * A text slot in the chosen template that the AI may fill. Geometry lives in
 * the template; the pipeline only ever writes replacement text keyed by id.
 */
export interface TemplateTextSlot {
  id: string;
  pageLabel: string;
}

export type OverridesByPage = Record<string, Record<string, string>>;

export type PlanValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Server-side guard: every override in the plan must reference a known text
 * slot of the chosen template, and no unknown ids may appear. Never trust the
 * LLM to reference real element ids.
 */
export function validatePlanAgainstTemplate(
  plan: ContentPlan,
  slots: TemplateTextSlot[],
): PlanValidation {
  const slotIds = new Set(slots.map((s) => s.id));
  const seen = new Set<string>();
  for (const override of plan.overrides) {
    if (!slotIds.has(override.templateElementId)) {
      return {
        ok: false,
        error: `Unknown template text element "${override.templateElementId}"`,
      };
    }
    if (seen.has(override.templateElementId)) {
      return {
        ok: false,
        error: `Duplicate override for element "${override.templateElementId}"`,
      };
    }
    seen.add(override.templateElementId);
  }
  return { ok: true };
}

/**
 * Convert a validated content plan into per-page `templateTextOverrides`,
 * applying text sanitization. Output is grouped by pageLabel so it can be fed
 * directly to createInstanceWithOverrides().
 */
export function buildOverridesByPage(
  plan: ContentPlan,
  slots: TemplateTextSlot[],
): OverridesByPage {
  const pageByElementId = new Map(slots.map((s) => [s.id, s.pageLabel]));
  const result: OverridesByPage = {};
  for (const override of plan.overrides) {
    const pageLabel = pageByElementId.get(override.templateElementId);
    if (!pageLabel) continue; // validated upstream; defensive skip
    const text = sanitizeAiText(override.text);
    if (!text) continue;
    (result[pageLabel] ??= {})[override.templateElementId] = text;
  }
  return result;
}
