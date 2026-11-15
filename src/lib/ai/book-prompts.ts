import { MAX_TITLE_CHARS, ROLE_TEXT_BUDGET, type BookSlotRole } from "./book-contract";
import { PAGE_DESCRIPTIONS } from "./system-prompt";
import type { AiTemplateSlot } from "./template-contract";
import { PRINT_PALETTES } from "./print-palette";

/**
 * Prompt builders for autonomous book generation.
 *
 * These are deliberately separate from the editor-chat `buildSystemPrompt()`:
 * the chat contract is a conversational suggestion format that a human applies,
 * while this contract produces a complete, validated book plan with no user in
 * the loop. Sharing page-role constants is fine; sharing prompt text is not.
 */
export const AUTONOMOUS_PROMPT_VERSION = "ai-book-v3-page-fill-pastel";

export interface PromptSlot {
  id: string;
  pageLabel: string;
  role: BookSlotRole;
  purpose: string;
  minChars: number;
  maxChars: number;
  fontFamily: string;
  fontSize: number;
  boxWidth: number;
  boxHeight: number;
}

const ROLE_HINT: Record<BookSlotRole, string> = {
  title: "the book title (also used as the draft's title)",
  body: "narrative or explanatory body copy for this page",
  closing: "a closing paragraph or blurb",
};

/** Describe a manifest slot the way the model needs to see it. */
export function promptSlot(slot: AiTemplateSlot): PromptSlot {
  return {
    id: slot.id,
    pageLabel: slot.pageLabel,
    role: slot.role,
    purpose: `${PAGE_DESCRIPTIONS[slot.pageLabel]} This slot holds ${ROLE_HINT[slot.role]}.`,
    minChars: slot.minChars,
    maxChars: slot.maxChars,
    fontFamily: slot.fontFamily,
    fontSize: Math.round(slot.style.fontSize),
    boxWidth: Math.round(slot.box.width),
    boxHeight: Math.round(slot.box.height),
  };
}

export function promptSlots(slots: AiTemplateSlot[]): PromptSlot[] {
  return slots.map(promptSlot);
}

function slotLines(slots: PromptSlot[]): string {
  return slots
    .map(
      (slot) =>
        `- id: "${slot.id}" | page: ${slot.pageLabel} | role: ${slot.role} | characters: ${slot.minChars}-${slot.maxChars}` +
        ` | box: ${slot.boxWidth}x${slot.boxHeight}px at ${slot.fontSize}px ${slot.fontFamily}` +
        `\n  purpose: ${slot.purpose}`,
    )
    .join("\n");
}

export function bookPlanSystemPrompt(): string {
  return `You are "Titchybooks AI", writing a finished eight-page pocket booklet from a single prompt.

Respond with raw JSON only, matching exactly:
{
  "version": 2,
  "brief": { "purpose": string, "audience": string, "tone": string, "progression": string },
  "outline": [ { "pageLabel": "FRONT_COVER" | "PAGE_2" | ... | "BACK_COVER", "purpose": string } ],
  "title": string (<= ${MAX_TITLE_CHARS} chars),
  "palette": ${PRINT_PALETTES.map((palette) => JSON.stringify(palette.id)).join(" | ")},
  "overrides": [ { "templateElementId": string, "text": string } ]
}

Rules:
- Use only the templateElementId values listed in the request. Never invent ids.
- Provide exactly one override for every listed slot. Every page must be filled.
- The brief must name a concrete purpose, audience, tone, and how the book progresses from page to page.
- The outline must name every page (FRONT_COVER, PAGE_2..PAGE_7, BACK_COVER) with one short purpose line.
- "title" must equal the FRONT_COVER title text, trimmed.
- Respect each slot's character range: do not exceed the maximum, and meet the minimum for required slots.
- Interior body pages are one continuous narrative in reading order. The pipeline repaginates body text so every page fills completely before the story continues on the next page, so per-page body lengths are guides only: write enough finished copy to reach the book-level character target when one is given.
- Headings are short section titles in reading order, not page breaks. The fixed heading slot is a running head; sections starting mid-page receive an inline heading. A section may continue on later pages. Keep the narrative voice and characters continuous across page boundaries.
- Write real, finished copy. Never use placeholders, TODOs, lorem ipsum, or template example text.
- Keep the same voice and characters across pages; do not repeat a paragraph on two pages.
- Use only Latin / Latin-extended letters, digits and common punctuation. Do not emit emoji, CJK, Cyrillic, or other scripts.
- Choose one listed palette id to suit the book's mood. These books are printed on home inkjet/laser printers: backgrounds, covers, accents, and branding must be light, low-saturation pastels, with dark legible text. Never request deep/saturated fills, heavy ink coverage, or arbitrary hex colors. The pipeline applies and validates the qualified palette.
${PRINT_PALETTES.map((palette) => `  - ${palette.id}: ${palette.mood}`).join("\n")}
- Paragraph breaks use a single newline. Do not emit layout, geometry, colors, or styling beyond the palette id.`;
}

export function bookPlanUserPrompt(concept: string, slots: PromptSlot[], total?: { min: number; max: number } | null): string {
  const window = total
    ? `\nBook-level interior body target: ${total.min}-${total.max} characters combined across the interior body slots. Aim for about ${Math.round((total.min + total.max) / 2)} characters of finished body copy, not the lower bound. This estimate accounts for inline section headings. The body is one continuous story that the pipeline repaginates to measured full-page capacity; per-page lengths are guides only. Do not stop each section at its original page boundary.\n`
    : "";
  return `Book request: "${concept}"

Template slots (fill every one):
${slotLines(slots)}
${window}
Plan and write the complete booklet now.`;
}

export function bookRepairSystemPrompt(): string {
  return `You are "Titchybooks AI" repairing a rejected booklet page by page.

Respond with raw JSON only:
{ "version": 2, "brief": {...}, "outline": [...], "title": string, "overrides": [ { "templateElementId": string, "text": string } ] }

Rules:
- Return overrides ONLY for the slot ids listed under "slots to repair". Do not rewrite accepted pages.
- Fix exactly what the rejection feedback describes.
- Keep the accepted brief, outline, title, palette and voice unless the feedback asks for the title itself to change. Never emit arbitrary colors or deep/saturated fills; all backgrounds, covers, accents, and branding use the qualified home-printer pastel palette.
- Respect each slot's character range, use no placeholders, and use only Latin / Latin-extended characters.
- "flow-underfull" means a non-final interior page has measured room left, even if it contains text: expand the continuous manuscript by roughly the stated character deficit. "flow-overflow" means the story is longer than the book holds: condense it without cutting facts. Interior per-slot maxima are guides, not page breaks. Never repeat a paragraph, running head, or inline heading to add length.`;
}

export interface RepairPromptInput {
  concept: string;
  slots: PromptSlot[];
  title: string;
  accepted: Array<{ templateElementId: string; text: string }>;
  feedback: Array<{ slotId: string | null; pageLabel: string | null; code: string; detail: string }>;
}

export function bookRepairUserPrompt(input: RepairPromptInput): string {
  const accepted = input.accepted
    .filter((entry) => entry.text.trim().length > 0)
    .map((entry) => `- "${entry.templateElementId}": ${JSON.stringify(entry.text)}`)
    .join("\n");
  const feedback = input.feedback
    .map((issue) => `- ${issue.pageLabel ?? "book"} ${issue.slotId ?? ""}: ${issue.code} - ${issue.detail}`)
    .join("\n");
  return `Book request: "${input.concept}"
Current title: ${JSON.stringify(input.title)}

slots to repair:
${slotLines(input.slots)}

Rejection feedback:
${feedback || "- The generated text did not pass validation."}

Accepted content (keep it, do not resend unless a listed slot is wrong):
${accepted || "- (none yet)"}

Return the corrected content for the listed slots only.`;
}

/** Character budget for a role, used when a manifest slot has no explicit budget. */
export function roleBudget(role: BookSlotRole): { minChars: number; maxChars: number } {
  return ROLE_TEXT_BUDGET[role];
}
