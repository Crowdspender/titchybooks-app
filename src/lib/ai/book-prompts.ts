import { MAX_TITLE_CHARS, ROLE_TEXT_BUDGET, type BookSlotRole } from "./book-contract";
import { PAGE_DESCRIPTIONS } from "./system-prompt";
import type { AiTemplateSlot } from "./template-contract";
import { PRINT_PALETTES } from "./print-palette";
import type { FlowRepairTarget, FlowWindow } from "./flow";

/**
 * Prompt builders for autonomous book generation.
 *
 * These are deliberately separate from the editor-chat `buildSystemPrompt()`:
 * the chat contract is a conversational suggestion format that a human applies,
 * while this contract produces a complete, validated book plan with no user in
 * the loop. Sharing page-role constants is fine; sharing prompt text is not.
 */
export const AUTONOMOUS_PROMPT_VERSION = "ai-book-v8-measured-repairs";

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
  lineStep?: number;
  /** Body chunk in a continuous manuscript, not a fixed page assignment. */
  flow?: boolean;
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
    lineStep: slot.style.fontSize * slot.style.lineHeight,
  };
}

export function promptSlots(slots: AiTemplateSlot[]): PromptSlot[] {
  return slots.map(promptSlot);
}

function slotLines(slots: PromptSlot[]): string {
  return slots
    .map(
      (slot) =>
        `- id: "${slot.id}" | page: ${slot.pageLabel} | role: ${slot.role} | ${slot.flow ? "body estimate (not a limit)" : "characters"}: ${slot.minChars}-${slot.maxChars}` +
        ` | box: ${slot.boxWidth}x${slot.boxHeight}px at ${slot.fontSize}px ${slot.fontFamily}` +
        (slot.flow && slot.lineStep ? ` | about ${Math.floor(slot.boxHeight / slot.lineStep)} naturally wrapped body lines` : "") +
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
- Respect fixed-slot character ranges (cover, heading, closing). Interior flow-body ranges are estimates, not limits: their combined manuscript target takes precedence. Keep each body chunk nonempty and at most 5000 characters.
- Interior body pages are one continuous narrative in reading order. The pipeline repaginates body text so every page fills completely before the story continues on the next page, so per-page body lengths are guides only: write enough finished copy to reach the book-level character target when one is given.
- Headings are short section titles in reading order, not page breaks. The fixed heading slot is a running head; sections starting mid-page receive an inline heading. A section may continue on later pages. Keep the narrative voice and characters continuous across page boundaries.
- Write real, finished copy. Never use placeholders, TODOs, lorem ipsum, or template example text.
- Keep the same voice and characters across pages; do not repeat a paragraph on two pages.
- Use only Latin / Latin-extended letters, digits and common punctuation. Do not emit emoji, CJK, Cyrillic, or other scripts.
- Choose one listed palette id to suit the book's mood. These books are printed on home inkjet/laser printers: backgrounds, covers, accents, and branding must be light, low-saturation pastels, with dark legible text. Never request deep/saturated fills, heavy ink coverage, or arbitrary hex colors. The pipeline applies and validates the qualified palette.
${PRINT_PALETTES.map((palette) => `  - ${palette.id}: ${palette.mood}`).join("\n")}
- Write full paragraphs with natural word wrapping; use a single newline only between real paragraphs. Never add manual line wrapping, blank-line padding, or repeated copy to simulate page fill. Do not emit layout, geometry, colors, or styling beyond the palette id.`;
}

function bodyTarget(total?: FlowWindow | null): string {
  if (!total) return "";
  const target = Math.round(total.min + (total.max - total.min) * 0.8);
  return `\nBook-level interior body target: ${total.min}-${total.max} characters combined across the interior body slots. Aim for about ${target} characters of finished body copy, near the upper end rather than the lower bound. Do not count headings, cover, or back-cover text. ${total.fillAllInteriorPages ? "This is an approximate starting estimate, not an exact character requirement. Balance the six raw sections toward each slot's naturally wrapped line target so the next heading can use its existing heading box. Do not force page breaks, manually wrap lines, or pad paragraphs" : "This estimate accounts for inline section headings"}. Write enough substantive narrative to fill all six body frames; ${total.fillAllInteriorPages ? "the final interior page must also fill to its last usable line. Develop a complete ending, not a short sign-off" : "only the final page may end early"}. The pipeline repaginates to measured full-page capacity, so per-page lengths are guides only. ${total.fillAllInteriorPages ? "Measured raw-section repair targets supersede this starting estimate and any aggregate gap estimate" : "Do not stop each section at its original page boundary"}. If measured repair feedback gives a revised total, use that total instead of this initial estimate.\n`;
}

export function bookPlanUserPrompt(concept: string, slots: PromptSlot[], total?: FlowWindow | null): string {
  const window = bodyTarget(total);
  return `Book request: "${concept}"

Template slots (fill every one):
${slotLines(slots)}
${window}
Plan and write the complete booklet now.`;
}

export function bookRepairSystemPrompt(): string {
  return `You are "Titchybooks AI" repairing rejected booklet text.

Respond with raw JSON only, using this patch shape:
{ "overrides": [ { "templateElementId": string, "text": string } ] }

Rules:
- Return exactly one complete replacement for EVERY slot id listed under "slots to repair", and no other slot ids. Do not resend accepted text outside that list.
- Fix exactly what the rejection feedback describes. For a continuous-manuscript repair, all listed interior slots are revised together and repaginated.
- Do not return version, brief, outline, title, or palette fields. The server preserves accepted metadata. If the cover-title slot is listed for repair, put its new title only in that slot's text; the server synchronizes the book title from it.
- Keep the accepted voice and story progression. Never emit arbitrary colors or deep/saturated fills; all backgrounds, covers, accents, and branding use the qualified home-printer pastel palette.
- Respect fixed-slot character ranges. Interior flow-body ranges are estimates, not limits; meet the combined revised manuscript target and keep each chunk at most 5000 characters. Use no placeholders and only Latin / Latin-extended characters. Use single newlines for real paragraph breaks, never manual line wrapping or blank-line padding.
- If measured raw-section targets are provided, follow them before any aggregate character or gap estimate. Expand only short sections, condense overlong sections, and return already-full sections unchanged. Character targets are approximate: preserve complete sentences, facts, voice, and the ending; do not take a prefix or cut off copy to hit a number. Keep valid headings unchanged. The six balanced sections must each occupy their last usable body line without overflow. The paginator still validates all pages.
- "flow-underfull" means a page has measured room left, even if a heading or paragraph boundary forced a break. Without measured raw-section targets, use the following guidance: Expand or rebalance the sections BEFORE the reported gaps, not just the ending; shorten headings if needed, keeping each with its first body line. Use any stated character deficit when more copy is needed. If "flow-overflow" is also reported, rebalance into the gaps first and condense remaining excess instead of increasing total length. With overflow alone, condense without cutting facts. Interior per-slot maxima are guides, not page breaks. Never repeat a paragraph, running head, or inline heading to add length.`;
}

export interface RepairPromptInput {
  concept: string;
  slots: PromptSlot[];
  title: string;
  accepted: Array<{ templateElementId: string; text: string }>;
  feedback: Array<{ slotId: string | null; pageLabel: string | null; code: string; detail: string }>;
  total?: FlowWindow | null;
  sectionTargets?: FlowRepairTarget[];
  unchangedBodyChars?: number;
}

export function bookRepairUserPrompt(input: RepairPromptInput): string {
  const targetIds = new Set(input.slots.map((slot) => slot.id));
  const contentLines = (repair: boolean) => input.accepted
    .filter((entry) => entry.text.trim().length > 0 && targetIds.has(entry.templateElementId) === repair)
    .map((entry) => `- "${entry.templateElementId}": ${JSON.stringify(entry.text)}`)
    .join("\n");
  const feedback = input.feedback
    .map((issue) => `- ${issue.pageLabel ?? "book"} ${issue.slotId ?? ""}: ${issue.code} - ${issue.detail}`)
    .join("\n");
  const sections = (input.sectionTargets ?? []).filter((section) => targetIds.has(section.slotId));
  const measuredTargets = sections.length === 0 ? "" : `
Measured raw-section targets (take precedence over aggregate estimates):
These measure original sections, not their current paginated destinations. Rebalance each section toward its own frame; this avoids inline-heading overhead and heading-boundary gaps. Keep each valid heading and each already-full body unchanged. Return only requested slots; the server preserves all other bodies and headings. Never truncate, omit facts, repeat text, or pad lines.
${sections.map((section) => {
    const deltaMin = Math.max(0, section.action === "expand" ? section.targetMinChars - section.currentChars : section.currentChars - section.targetMaxChars);
    const deltaMax = Math.max(deltaMin, section.action === "expand" ? section.targetMaxChars - section.currentChars : section.currentChars - section.targetMinChars);
    return `- ${section.pageLabel} "${section.slotId}": ${section.currentChars} characters, ${Math.round(section.currentHeight)}/${Math.round(section.capacityHeight)}px measured; ${section.action.toUpperCase()}${section.action === "keep" ? " unchanged" : ` by roughly ${deltaMin}-${deltaMax} characters; aim for ${section.targetMinChars}-${section.targetMaxChars} characters`}. Body height must be greater than ${Math.round(section.capacityHeight - section.lineStep)}px and at most ${Math.round(section.capacityHeight)}px (about ${Math.floor(section.capacityHeight / section.lineStep)} naturally wrapped lines).`;
  }).join("\n")}
Unchanged interior bodies: ${input.unchangedBodyChars ?? 0} characters preserved by the server; do not resend them.
Combined revised body estimate: ${sections.reduce((sum, section) => sum + section.targetMinChars, input.unchangedBodyChars ?? 0)}-${sections.reduce((sum, section) => sum + section.targetMaxChars, input.unchangedBodyChars ?? 0)} characters including those unchanged bodies. This replaces the initial book-level target; it is not a hard acceptance limit.
`;
  return `Book request: "${input.concept}"
Current title: ${JSON.stringify(input.title)}

slots to repair:
${slotLines(input.slots)}
${bodyTarget(input.total)}
Rejection feedback:
${feedback || "- The generated text did not pass validation."}
${measuredTargets}
Current content to revise (return complete replacements, not appended fragments):
${contentLines(true) || "- (none yet)"}

Accepted content (keep it, do not resend):
${contentLines(false) || "- (none yet)"}

Return the corrected content for the listed slots only.`;
}

/** Character budget for a role, used when a manifest slot has no explicit budget. */
export function roleBudget(role: BookSlotRole): { minChars: number; maxChars: number } {
  return ROLE_TEXT_BUDGET[role];
}
