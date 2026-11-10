import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import { sanitizeAiText } from "./protocol";
import type { ContentPlan } from "./content-plan";
import { describePlaceholderText, findUnsupportedCharacters, type BookSlotRole } from "./book-contract";
import { generatedSlots, type AiTemplateManifest } from "./template-contract";

/**
 * A text slot the AI may fill. Geometry lives in the template; the pipeline
 * only ever writes replacement text keyed by element id.
 */
export interface TemplateTextSlot {
  id: string;
  pageLabel: PageLabel | string;
  role?: BookSlotRole;
  required?: boolean;
  maxChars?: number;
  minChars?: number;
  /** Template default text, shown to the model as a hint. */
  text?: string;
}

export type OverridesByPage = Record<string, Record<string, string>>;

export interface PlanIssue {
  code: string;
  message: string;
  slotId: string | null;
  pageLabel: string | null;
}

export interface PlanValidation {
  ok: boolean;
  issues: PlanIssue[];
}

export interface ValidatePlanOptions {
  /** Require a non-blank override for every required slot (autonomous path). */
  requireAllRequired?: boolean;
  /** Restrict the plan to a subset of slots (targeted repair). */
  allowedSlotIds?: ReadonlySet<string>;
}

/** Slots the composer accepts, derived from the pinned template manifest. */
export function slotsFromManifest(manifest: AiTemplateManifest): TemplateTextSlot[] {
  return generatedSlots(manifest).map((slot) => ({
    id: slot.id,
    pageLabel: slot.pageLabel,
    role: slot.role,
    required: slot.required,
    maxChars: slot.maxChars,
    minChars: slot.minChars,
    text: slot.text,
  }));
}

function issue(code: string, message: string, slot: TemplateTextSlot | null): PlanIssue {
  return { code, message, slotId: slot?.id ?? null, pageLabel: slot ? String(slot.pageLabel) : null };
}

/**
 * Server-side guard: every override must reference a known generated slot, no
 * id may appear twice, and the text must survive sanitization as real content
 * that fits the slot's character budget. Never trust the LLM to reference real
 * element ids or to respect the template.
 */
export function validatePlanAgainstSlots(
  plan: ContentPlan,
  slots: TemplateTextSlot[],
  options: ValidatePlanOptions = {},
): PlanValidation {
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const seen = new Set<string>();
  const issues: PlanIssue[] = [];

  for (const override of plan.overrides) {
    const slot = byId.get(override.templateElementId) ?? null;
    if (!slot) {
      issues.push({
        code: "unknown-slot",
        message: `Unknown template text element "${override.templateElementId}"`,
        slotId: override.templateElementId,
        pageLabel: null,
      });
      continue;
    }
    if (options.allowedSlotIds && !options.allowedSlotIds.has(slot.id)) {
      issues.push(issue("slot-not-repairable", `Element "${slot.id}" was not requested in this repair`, slot));
      continue;
    }
    if (seen.has(slot.id)) {
      issues.push(issue("duplicate-override", `Duplicate override for element "${slot.id}"`, slot));
      continue;
    }
    seen.add(slot.id);

    const text = sanitizeAiText(override.text);
    if (text.trim().length === 0) {
      issues.push(issue("empty-text", `Element "${slot.id}" is empty after sanitization`, slot));
      continue;
    }
    const placeholder = describePlaceholderText(text);
    if (placeholder) {
      issues.push(issue(`placeholder-${placeholder.code}`, `Element "${slot.id}": ${placeholder.detail}`, slot));
      continue;
    }
    const unsupported = findUnsupportedCharacters(text);
    if (unsupported.length > 0) {
      issues.push(
        issue(
          "unsupported-glyph",
          `Element "${slot.id}" contains unsupported character(s): ${unsupported.join(" ")}`,
          slot,
        ),
      );
      continue;
    }
    if (slot.maxChars !== undefined && text.trim().length > slot.maxChars) {
      issues.push(
        issue(
          "over-budget",
          `Element "${slot.id}" has ${text.trim().length} characters; the slot holds at most ${slot.maxChars}`,
          slot,
        ),
      );
      continue;
    }
    if (slot.required && slot.minChars !== undefined && text.trim().length < slot.minChars) {
      issues.push(
        issue(
          "under-budget",
          `Element "${slot.id}" needs at least ${slot.minChars} characters, found ${text.trim().length}`,
          slot,
        ),
      );
    }
  }

  if (options.requireAllRequired) {
    for (const slot of slots) {
      if (slot.required && !seen.has(slot.id)) {
        issues.push(issue("missing-required-slot", `No content was generated for "${slot.id}"`, slot));
      }
    }
    // A plan that silently skips a page can never be a complete book.
    for (const pageLabel of PAGE_LABELS) {
      const pageSlots = slots.filter((slot) => slot.pageLabel === pageLabel);
      if (pageSlots.length === 0) {
        issues.push({
          code: "missing-page-content",
          message: `Page ${pageLabel} has no generated content`,
          slotId: null,
          pageLabel,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Backwards-compatible wrapper: known/duplicate-id validation only. */
export function validatePlanAgainstTemplate(plan: ContentPlan, slots: TemplateTextSlot[]): PlanValidation {
  return validatePlanAgainstSlots(plan, slots);
}

/** Slot ids referenced by a failed validation, used to target a repair. */
export function failedSlotIds(issues: PlanIssue[]): Set<string> {
  return new Set(issues.map((i) => i.slotId).filter((id): id is string => typeof id === "string" && id.length > 0));
}

/**
 * Convert a validated content plan into per-page `templateTextOverrides`,
 * applying text sanitization. Output is grouped by pageLabel so it can be fed
 * directly to createInstanceWithOverrides().
 *
 * `base` preserves accepted overrides from an earlier plan: a targeted repair
 * only replaces the slots it was asked to fix.
 */
export function buildOverridesByPage(
  plan: ContentPlan,
  slots: TemplateTextSlot[],
  options: { onlySlotIds?: ReadonlySet<string>; base?: OverridesByPage } = {},
): OverridesByPage {
  const pageByElementId = new Map(slots.map((slot) => [slot.id, String(slot.pageLabel)]));
  const result: OverridesByPage = {};
  if (options.base) {
    for (const [pageLabel, entries] of Object.entries(options.base)) {
      result[pageLabel] = { ...entries };
    }
  }
  const replaceAll = !options.onlySlotIds;
  if (replaceAll) {
    for (const pageLabel of Object.keys(result)) delete result[pageLabel];
  }
  for (const override of plan.overrides) {
    const pageLabel = pageByElementId.get(override.templateElementId);
    if (!pageLabel) continue; // validated upstream; defensive skip
    if (options.onlySlotIds && !options.onlySlotIds.has(override.templateElementId)) continue;
    const text = sanitizeAiText(override.text);
    if (!text.trim()) continue;
    (result[pageLabel] ??= {})[override.templateElementId] = text;
  }
  return result;
}

/** Overrides grouped by page from a plan, without any base merge. */
export function overridesOfPlan(plan: ContentPlan, slots: TemplateTextSlot[]): OverridesByPage {
  return buildOverridesByPage(plan, slots);
}
