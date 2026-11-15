import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import type { EditorElement } from "@/lib/editor/schema";
import { loadServerDesignFonts } from "@/lib/pdf/design-fonts-server";
import { maxCharsForBox, measureTextBlock, type TextStyle } from "@/lib/pdf/text-layout";
import type { PlanIssue } from "./composer";
import type { AiTemplateManifest, AiTemplateSlot } from "./template-contract";

/**
 * Deterministic page-fill pagination for autonomous books.
 *
 * The model writes one continuous manuscript (per-page body slots are only
 * length guides); this module repacks it across the interior pages with the
 * shared measurement engine so every page fills to its last possible line
 * before text overflows to the next page. Sections may start wherever the
 * previous content ends; a page that opens mid-section carries the running
 * head "<heading> (continued)" so no generated slot is ever left empty.
 *
 * Pagination never truncates, shrinks, or rewords content: it only chooses
 * line-safe split points. Fill failures (underfull/overflow) are reported as
 * plan issues so the existing repair loop can expand or condense the story.
 */

/** Floating-point tolerance for "this line still fits" comparisons. */
const HEIGHT_EPS = 0.01;

export interface FlowPage {
  pageLabel: PageLabel;
  /** The generated slot that carries the flowing body text (largest box). */
  flow: AiTemplateSlot;
  /** The page's heading slot, when the template has one. */
  heading: AiTemplateSlot | null;
}

export interface PaginatedPage {
  pageLabel: PageLabel;
  flowText: string;
  headingText: string;
  /** False when the manuscript ran out before this page filled. */
  filled: boolean;
  usedHeight: number;
}

export interface PaginationResult {
  /** Replacement text for every interior flow/heading slot, in page order. */
  overrides: Array<{ templateElementId: string; text: string }>;
  issues: PlanIssue[];
  pages: PaginatedPage[];
  flowSlotIds: string[];
  interiorSlotIds: string[];
}

function area(slot: AiTemplateSlot): number {
  return slot.box.width * slot.box.height;
}

function styleOf(slot: AiTemplateSlot): TextStyle {
  return { ...slot.style, fontFamily: slot.style.fontFamily ?? slot.fontFamily };
}

/** Interior pages in reading order with their flow/heading slot pair. */
export function interiorFlowPages(manifest: AiTemplateManifest): FlowPage[] {
  const interior = new Set<PageLabel>(
    PAGE_LABELS.filter((label) => label !== "FRONT_COVER" && label !== "BACK_COVER"),
  );
  const pages: FlowPage[] = [];
  for (const page of manifest.pages) {
    if (!interior.has(page.pageLabel)) continue;
    const generated = page.slots.filter((slot) => slot.generated);
    if (generated.length === 0) continue;
    const flow = generated.reduce((best, slot) => (area(slot) > area(best) ? slot : best));
    const heading = generated.find((slot) => slot.id !== flow.id) ?? null;
    pages.push({ pageLabel: page.pageLabel, flow, heading });
  }
  return pages;
}

/** Slot ids the paginator rewrites (flow bodies) and owns (flow + heading). */
export function interiorFlowSlotIds(manifest: AiTemplateManifest): { flow: string[]; interior: string[] } {
  const pages = interiorFlowPages(manifest);
  return {
    flow: pages.map((page) => page.flow.id),
    interior: pages.flatMap((page) => (page.heading ? [page.flow.id, page.heading.id] : [page.flow.id])),
  };
}

/**
 * Book-level interior character window published to the model: enough copy to
 * fill pages 2-6 completely plus a real final page, capped by what the boxes
 * can hold so the target is always reachable.
 */
export function interiorFlowWindow(manifest: AiTemplateManifest): { min: number; max: number } | null {
  const pages = interiorFlowPages(manifest);
  if (pages.length === 0) return null;
  let max = 0;
  let min = 0;
  for (const page of pages) {
    max += page.flow.maxChars;
    min += maxCharsForBox(page.flow.box.width, page.flow.box.height, styleOf(page.flow));
  }
  // Section headings that start mid-page live in the flow, not in the fixed
  // running-head box. Budget a separator and up to two heading lines per
  // section after the first; measurement, not this estimate, decides acceptance.
  for (let index = 1; index < pages.length; index++) {
    const page = pages[index];
    if (!page.heading) continue;
    const headingStyle = styleOf(page.heading);
    const headingLines = Math.min(2, Math.max(1, Math.floor(page.heading.box.height / (headingStyle.fontSize * headingStyle.lineHeight))));
    const flowStyle = styleOf(page.flow);
    const cost = maxCharsForBox(page.flow.box.width, flowStyle.fontSize * flowStyle.lineHeight * (1 + headingLines), flowStyle);
    max -= cost;
    if (index < pages.length - 1) min -= cost;
  }
  const last = pages[pages.length - 1];
  // The final page ends the story; require a substantive closing page rather
  // than a full sixth frame of padding.
  min = min - maxCharsForBox(last.flow.box.width, last.flow.box.height, styleOf(last.flow)) + last.flow.minChars;
  if (min > max) min = max;
  return { min: Math.max(1, Math.round(min)), max: Math.max(1, Math.round(max)) };
}

function probeElement(slot: AiTemplateSlot): EditorElement {
  return {
    id: slot.id,
    type: "text",
    x: slot.box.x,
    y: slot.box.y,
    width: slot.box.width,
    height: slot.box.height,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    zIndex: 0,
    text: " ",
    color: "#000000",
    align: "left",
    verticalAlign: "top",
    fontFamily: slot.fontFamily,
    ...slot.style,
  } as EditorElement;
}

interface Section {
  heading: string;
  paragraphs: string[];
}

function continuedHeading(heading: string, slot: AiTemplateSlot): string {
  const fits = (text: string) => measureTextBlock(text, slot.box.width, styleOf(slot)).height <= slot.box.height + HEIGHT_EPS;
  const full = `${heading.trim() || "The story"} (continued)`;
  if (fits(full)) return full;
  // Only the generated running head may be abbreviated; manuscript headings
  // and body text are never truncated. Preserve the continuation cue.
  const words = heading.trim().split(/\s+/);
  while (words.length > 1) {
    words.pop();
    const candidate = `${words.join(" ")}… (continued)`;
    if (fits(candidate)) return candidate;
  }
  return "Continued";
}

/**
 * Repack the plan's interior body text across the interior pages.
 * Deterministic: same manifest and overrides always yield the same pages.
 */
export function paginatePlan(input: {
  manifest: AiTemplateManifest;
  overrides: Array<{ templateElementId: string; text: string }>;
}): PaginationResult {
  const pages = interiorFlowPages(input.manifest);
  const ids = interiorFlowSlotIds(input.manifest);
  const textOf = new Map(input.overrides.map((entry) => [entry.templateElementId, entry.text]));

  const probes: EditorElement[] = [];
  for (const page of pages) {
    for (const slot of [page.flow, page.heading]) {
      if (slot && slot.style.typographyVersion) probes.push(probeElement(slot));
    }
  }
  if (probes.length > 0) loadServerDesignFonts(probes);

  if (pages.length === 0) return { overrides: [], issues: [], pages: [], flowSlotIds: ids.flow, interiorSlotIds: ids.interior };
  const sections: Section[] = pages.map((page) => ({
    heading: page.heading ? (textOf.get(page.heading.id) ?? "").trim() : "",
    paragraphs: (textOf.get(page.flow.id) ?? "").trim().split(/\r?\n/),
  })).filter((section) => section.paragraphs.some((paragraph) => paragraph.trim() !== ""));

  const fitsFlow = (page: FlowPage, paragraphs: string[]) =>
    paragraphs.length === 0 ||
    measureTextBlock(paragraphs.join("\n"), page.flow.box.width, styleOf(page.flow)).height <=
      page.flow.box.height + HEIGHT_EPS;

  /** Longest prefix of a paragraph's wrapped lines that still fits the page. */
  function maxPrefixLines(page: FlowPage, placed: string[], paragraph: string): number {
    const wrapped = measureTextBlock(paragraph, page.flow.box.width, styleOf(page.flow)).lines;
    let count = 0;
    while (count < wrapped.length) {
      if (!fitsFlow(page, placed.concat([wrapped.slice(0, count + 1).join("\n")]))) break;
      count++;
    }
    return count;
  }

  const result: PaginatedPage[] = [];
  let s = 0;
  let p = 0;
  let partial: string | null = null;
  let carrying = false;

  for (const page of pages) {
    const placed: string[] = [];
    let headingText = "";
    let closed = false;
    if (carrying && page.heading) headingText = continuedHeading(sections[s].heading, page.heading);

    while (s < sections.length) {
      const section = sections[s];
      if (!carrying) {
        if (placed.length === 0) {
          headingText = page.heading ? section.heading : "";
        } else if (page.heading && section.heading) {
          // The fixed heading slot describes the top of the page only. A new
          // section below it uses an inline heading, kept with its first body
          // line. Lack of room for that indivisible unit is structural fullness.
          const firstLine = measureTextBlock(section.paragraphs[0], page.flow.box.width, styleOf(page.flow)).lines[0];
          const inline = ["", section.heading];
          if (!fitsFlow(page, placed.concat(inline, [firstLine]))) {
            closed = true;
            break;
          }
          placed.push(...inline);
        }
        carrying = true;
      }

      // The cursor's partial is always the rest of ONE paragraph. Advancing
      // p only when it is exhausted prevents later paragraphs being duplicated.
      const paragraph: string = partial ?? section.paragraphs[p];
      if (!paragraph.trim() && placed.length === 0) {
        p++;
      } else {
        const wrapped: string[] = measureTextBlock(paragraph, page.flow.box.width, styleOf(page.flow)).lines;
        const wholeFits = fitsFlow(page, placed.concat([paragraph]));
        const take = wholeFits ? wrapped.length : maxPrefixLines(page, placed, paragraph);
        if (take === 0) {
          if (placed.length === 0) throw new Error(`Flow box on ${page.pageLabel} cannot fit a single line.`);
          closed = true;
          break;
        }
        // Rejoin split prefixes with newlines, never spaces: space-joined
        // chunks may re-wrap and overflow. Whole paragraphs keep their spacing.
        placed.push(wholeFits ? paragraph : wrapped.slice(0, take).join("\n"));
        if (take < wrapped.length) {
          partial = wrapped.slice(take).join("\n");
          closed = true;
          break;
        }
        partial = null;
        p++;
      }
      if (p >= section.paragraphs.length) {
        s++;
        p = 0;
        carrying = false;
      }
    }

    const flowText = placed.join("\n");
    const usedHeight = flowText ? measureTextBlock(flowText, page.flow.box.width, styleOf(page.flow)).height : 0;
    const full = flowText.trim().length > 0 && !fitsFlow(page, placed.concat(["M"]));
    result.push({ pageLabel: page.pageLabel, flowText, headingText, filled: full || closed, usedHeight });
  }

  const issues: PlanIssue[] = [];
  const remainingChars = (() => {
    let total = 0;
    let breaks = 0;
    for (let index = s; index < sections.length; index++) {
      const paragraphs = sections[index].paragraphs;
      if (index > s || !carrying) total += sections[index].heading.length;
      if (index === s && partial) {
        total += partial.length;
        total += paragraphs.slice(p + 1).reduce((sum, line) => sum + line.length, 0);
        breaks += Math.max(0, paragraphs.length - (p + 1));
        continue;
      }
      const from = index === s ? p : 0;
      total += paragraphs.slice(from).reduce((sum, line) => sum + line.length, 0);
      breaks += Math.max(0, paragraphs.length - from - (from >= paragraphs.length ? 0 : 1));
    }
    return total + breaks;
  })();

  if (remainingChars > 0) {
    const last = pages[pages.length - 1];
    issues.push({
      code: "flow-overflow",
      message: `The story leaves about ${remainingChars} characters after ${last.pageLabel} is completely full. Condense the narrative without cutting facts or placeholders.`,
      slotId: last.flow.id,
      pageLabel: last.pageLabel,
    });
  }

  // A nonempty page is not necessarily full. Reject every pre-final frame
  // with room for more text, including the tail where the manuscript ran out.
  const firstUnfilled = result.findIndex((page, index) => !page.filled && index < result.length - 1);
  const lastPage = result[result.length - 1];
  const lastSlot = pages[pages.length - 1].flow;
  const lastTooShort = lastPage.flowText.trim().length < lastSlot.minChars;
  if (firstUnfilled >= 0 || lastTooShort) {
    let deficit = 0;
    for (let index = firstUnfilled >= 0 ? firstUnfilled : result.length - 1; index < result.length - 1; index++) {
      if (result[index].filled) continue;
      const page = pages[index];
      const free = Math.max(0, page.flow.box.height - result[index].usedHeight);
      deficit += maxCharsForBox(page.flow.box.width, free, styleOf(page.flow));
    }
    if (lastTooShort) deficit += Math.max(0, lastSlot.minChars - lastPage.flowText.trim().length);
    const index = firstUnfilled >= 0 ? firstUnfilled : result.length - 1;
    const label = result[index].pageLabel;
    issues.push({
      code: "flow-underfull",
      message: `Body text stops filling pages at ${label}: every non-final interior page must fill completely before text continues. Write roughly ${Math.max(1, Math.round(deficit * 1.1))} more characters of finished copy.`,
      slotId: pages[index].flow.id,
      pageLabel: label,
    });
  }

  const overrides: Array<{ templateElementId: string; text: string }> = [];
  for (let index = 0; index < pages.length; index++) {
    overrides.push({ templateElementId: pages[index].flow.id, text: result[index].flowText });
    if (pages[index].heading) {
      overrides.push({ templateElementId: pages[index].heading!.id, text: result[index].headingText });
    }
  }

  return { overrides, issues, pages: result, flowSlotIds: ids.flow, interiorSlotIds: ids.interior };
}
