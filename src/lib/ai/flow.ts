import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import type { EditorElement } from "@/lib/editor/schema";
import { EDITOR_PAGE_HEIGHT_PX } from "@/lib/editor/constants";
import { loadServerDesignFonts } from "@/lib/pdf/design-fonts-server";
import { maxCharsForBox, measureTextBlock, type TextStyle } from "@/lib/pdf/text-layout";
import type { PlanIssue } from "./composer";
import type { AiTemplateManifest, AiTemplateSlot, PinnedTemplate } from "./template-contract";

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
  /** True only when the measured body has no room for another line. */
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
  return pages.sort((a, b) => PAGE_LABELS.indexOf(a.pageLabel) - PAGE_LABELS.indexOf(b.pageLabel));
}

/** Slot ids the paginator rewrites (flow bodies) and owns (flow + heading). */
export function interiorFlowSlotIds(manifest: AiTemplateManifest): { flow: string[]; interior: string[] } {
  const pages = interiorFlowPages(manifest);
  return {
    flow: pages.map((page) => page.flow.id),
    interior: pages.flatMap((page) => (page.heading ? [page.flow.id, page.heading.id] : [page.flow.id])),
  };
}

/** A private new-book layout; never apply this to stored submissions or source templates. */
export function prepareAiBookLayout(pin: PinnedTemplate): PinnedTemplate {
  if (pin.manifest.fillAllInteriorPages) return pin;
  const flows = interiorFlowPages(pin.manifest);
  loadFlowFonts(flows);
  const heights = new Map<string, number>();
  const bottomLimit = EDITOR_PAGE_HEIGHT_PX - 60;
  const clearance = 12;
  for (const page of flows) {
    const elements = pin.pages.find((entry) => entry.pageLabel === page.pageLabel)?.elements ?? [];
    const body = elements.find((element) => element.id === page.flow.id);
    // Resizing rotated or vertically centered frames changes their existing layout.
    if (!body || body.type !== "text" || body.rotation % 360 !== 0 || (body.verticalAlign ?? "top") !== "top") continue;
    let bottom = bottomLimit;
    for (const element of elements) {
      if (element.id === body.id || !element.visible || element.opacity === 0) continue;
      // A full background behind the body is not an obstacle to its text.
      if (element.type === "shape" && element.shape === "rect" && element.rotation % 360 === 0 && element.zIndex < body.zIndex &&
          element.x <= body.x && element.x + element.width >= body.x + body.width &&
          element.y <= body.y && element.y + element.height >= bottomLimit) continue;
      const angle = element.rotation * Math.PI / 180;
      // Konva/guided text rotate at the origin; legacy raster elements rotate
      // at the center. Reserve both bounds so extension is safe in either view.
      const pivots = [[0, 0], [element.width / 2, element.height / 2]];
      const corners = pivots.flatMap(([cx, cy]) =>
        [[0, 0], [element.width, 0], [0, element.height], [element.width, element.height]]
          .map(([x, y]) => ({
            x: element.x + cx + (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle),
            y: element.y + cy + (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle),
          })),
      );
      const stroke = element.type === "shape" ? (element.strokeWidth ?? (element.shape === "line" ? 2 : 0)) / 2 : 0;
      const left = Math.min(...corners.map((point) => point.x)) - stroke;
      const right = Math.max(...corners.map((point) => point.x)) + stroke;
      const top = Math.min(...corners.map((point) => point.y)) - stroke;
      const lower = Math.max(...corners.map((point) => point.y)) + stroke;
      if (right <= body.x - clearance || left >= body.x + body.width + clearance || lower <= body.y) continue;
      bottom = Math.min(bottom, top - clearance);
    }
    const height = Math.max(body.height, bottom - body.y);
    if (height > body.height + HEIGHT_EPS) heights.set(body.id, height);
  }
  return {
    ...pin,
    manifest: {
      ...pin.manifest,
      fillAllInteriorPages: true,
      pages: pin.manifest.pages.map((page) => ({ ...page, slots: page.slots.map((slot) => {
        const height = heights.get(slot.id);
        if (height === undefined) return slot;
        return { ...slot, box: { ...slot.box, height }, maxChars: maxCharsForBox(slot.box.width, height, styleOf(slot)) };
      }) })),
    },
    pages: pin.pages.map((page) => ({ ...page, elements: page.elements.map((element) => {
      const height = heights.get(element.id);
      return height === undefined ? element : { ...element, height };
    }) })),
  };
}

export interface FlowWindow { min: number; max: number; fillAllInteriorPages?: true }

/** Estimated manuscript capacity; exact pagination, including the final-page policy, decides acceptance. */
export function interiorFlowWindow(manifest: AiTemplateManifest): FlowWindow | null {
  const pages = interiorFlowPages(manifest);
  if (pages.length === 0) return null;
  loadFlowFonts(pages);
  let max = 0;
  let min = 0;
  for (const page of pages) {
    // Role-level character caps are not physical body-frame capacity.
    const capacity = maxCharsForBox(page.flow.box.width, page.flow.box.height, styleOf(page.flow));
    max += capacity;
    min += capacity;
  }
  // Balanced full-page sections put headings in the existing heading boxes.
  // Do not subtract hypothetical inline headings from EVERY section or publish
  // an exact character count: word widths and paragraph spacing vary.
  if (manifest.fillAllInteriorPages) {
    return { min: Math.max(1, Math.round(max * 0.9)), max: Math.max(1, Math.round(max)), fillAllInteriorPages: true };
  }
  // Historical manuscripts may start sections mid-page. Retain their estimate
  // and shorter-ending policy; exact measurement still decides acceptance.
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
  // Historical pins allow a shorter ending. New AI layouts require all six frames.
  if (!manifest.fillAllInteriorPages) {
    min = min - maxCharsForBox(last.flow.box.width, last.flow.box.height, styleOf(last.flow)) + last.flow.minChars;
  }
  if (min > max) min = max;
  return { min: Math.max(1, Math.round(min)), max: Math.max(1, Math.round(max)), ...(manifest.fillAllInteriorPages ? { fillAllInteriorPages: true as const } : {}) };
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

function loadFlowFonts(pages: FlowPage[]): void {
  const probes = pages.flatMap((page) => [page.flow, page.heading]
    .filter((slot): slot is AiTemplateSlot => Boolean(slot?.style.typographyVersion))
    .map(probeElement));
  if (probes.length > 0) loadServerDesignFonts(probes);
}

export interface FlowRepairTarget {
  slotId: string;
  pageLabel: PageLabel;
  currentChars: number;
  currentHeight: number;
  capacityHeight: number;
  lineStep: number;
  targetMinChars: number;
  targetMaxChars: number;
  action: "expand" | "condense" | "keep";
}

/**
 * Measure RAW sections independently to guide a balanced repair. These are
 * writing estimates, not a truncation algorithm or a second acceptance gate.
 * A full section ends at a page boundary without spending body lines on the
 * next heading. Re-measure every model response with the normal paginator.
 */
export function interiorFlowRepairTargets(input: {
  manifest: AiTemplateManifest;
  overrides: Array<{ templateElementId: string; text: string }>;
}): FlowRepairTarget[] {
  if (!input.manifest.fillAllInteriorPages) return [];
  const pages = interiorFlowPages(input.manifest);
  loadFlowFonts(pages);
  const textOf = new Map(input.overrides.map((entry) => [entry.templateElementId, entry.text]));
  return pages.map((page) => {
    const text = (textOf.get(page.flow.id) ?? "").trim().replace(/\r\n?/g, "\n");
    const style = styleOf(page.flow);
    const lineStep = style.fontSize * style.lineHeight;
    const capacityHeight = page.flow.box.height;
    const heightOf = (copy: string) => copy.trim() ? measureTextBlock(copy, page.flow.box.width, style).height : 0;
    const currentHeight = heightOf(text);
    const full = currentHeight + lineStep > capacityHeight + HEIGHT_EPS;
    const action = currentHeight > capacityHeight + HEIGHT_EPS ? "condense" : text && full ? "keep" : "expand";
    let targetMinChars = text.length;
    let targetMaxChars = text.length;
    if (action === "condense") {
      // Probe prefix lengths only to estimate the amount of rewriting required.
      // Never return or store these fragments as manuscript replacements.
      const lastPrefixAtHeight = (height: number) => {
        let low = 0;
        let high = text.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (heightOf(text.slice(0, middle)) <= height) low = middle;
          else high = middle - 1;
        }
        return low;
      };
      targetMaxChars = text.slice(0, lastPrefixAtHeight(capacityHeight + HEIGHT_EPS)).trimEnd().length;
      targetMinChars = Math.min(targetMaxChars, lastPrefixAtHeight(capacityHeight - lineStep + HEIGHT_EPS) + 1);
    } else if (action === "expand") {
      const charsPerPixel = currentHeight > 0
        ? text.length / currentHeight
        : maxCharsForBox(page.flow.box.width, capacityHeight, style) / capacityHeight;
      targetMinChars = Math.ceil(charsPerPixel * Math.max(0, capacityHeight - lineStep + HEIGHT_EPS));
      targetMaxChars = Math.ceil(charsPerPixel * capacityHeight);
    }
    return {
      slotId: page.flow.id, pageLabel: page.pageLabel, currentChars: text.length,
      currentHeight, capacityHeight, lineStep,
      targetMinChars: Math.max(1, Math.min(5000, targetMinChars)),
      targetMaxChars: Math.max(1, Math.min(5000, targetMaxChars)), action,
    };
  });
}

interface Section {
  heading: string;
  paragraphs: string[];
}

/** Map soft-wrapped lines back to source offsets without inventing newlines or spaces. */
function wrappedLineEnds(paragraph: string, slot: AiTemplateSlot): number[] {
  const lines = measureTextBlock(paragraph, slot.box.width, styleOf(slot)).lines;
  let offset = 0;
  return lines.map((line) => {
    // Both layout engines normalize whitespace but preserve all other code units,
    // including fragments of a token wider than a line. Keep its source intact.
    let remaining = line.replace(/\s/g, "").length;
    while (remaining > 0 && offset < paragraph.length) {
      if (!/\s/.test(paragraph[offset])) remaining--;
      offset++;
    }
    return offset;
  });
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

  loadFlowFonts(pages);

  if (pages.length === 0) return { overrides: [], issues: [], pages: [], flowSlotIds: ids.flow, interiorSlotIds: ids.interior };
  const sections: Section[] = pages.map((page) => ({
    heading: page.heading ? (textOf.get(page.heading.id) ?? "").trim() : "",
    paragraphs: (textOf.get(page.flow.id) ?? "").trim().replace(/\r\n?/g, "\n").split("\n"),
  })).filter((section) => section.paragraphs.some((paragraph) => paragraph.trim() !== ""));

  const fitsFlow = (page: FlowPage, paragraphs: string[]) =>
    paragraphs.length === 0 ||
    measureTextBlock(paragraphs.join("\n"), page.flow.box.width, styleOf(page.flow)).height <=
      page.flow.box.height + HEIGHT_EPS;

  /** Longest source prefix ending at a wrapped-line boundary that fits exactly as stored. */
  function maxPrefixEnd(page: FlowPage, placed: string[], paragraph: string): number {
    let end = 0;
    for (const candidate of wrappedLineEnds(paragraph, page.flow)) {
      if (!fitsFlow(page, placed.concat([paragraph.slice(0, candidate)]))) break;
      end = candidate;
    }
    return end;
  }

  const result: PaginatedPage[] = [];
  const breakReasons: string[] = [];
  let s = 0;
  let p = 0;
  let partial: string | null = null;
  let carrying = false;

  for (const page of pages) {
    const placed: string[] = [];
    let headingText = "";
    let breakReason = "the manuscript ended";
    if (carrying && page.heading) headingText = continuedHeading(sections[s].heading, page.heading);

    while (s < sections.length) {
      const section = sections[s];
      if (!carrying) {
        if (placed.length === 0) {
          headingText = page.heading ? section.heading : "";
        } else if (page.heading && section.heading) {
          // The fixed heading slot describes the top of the page only. A new
          // section below it uses an inline heading, kept with its first body
          // line. Deferring this unit preserves reading order, but does not
          // prove the preceding page is full: unused lines require a repair.
          const firstParagraph = section.paragraphs[0];
          const firstLine = firstParagraph.slice(0, wrappedLineEnds(firstParagraph, page.flow)[0]);
          const inline = ["", section.heading];
          if (!fitsFlow(page, placed.concat(inline, [firstLine]))) {
            breakReason = `heading ${JSON.stringify(section.heading)} and its first body line must stay together`;
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
        const wholeFits = fitsFlow(page, placed.concat([paragraph]));
        const end = wholeFits ? paragraph.length : maxPrefixEnd(page, placed, paragraph);
        if (!wholeFits && end === 0) {
          if (placed.length === 0) throw new Error(`Flow box on ${page.pageLabel} cannot fit a single line.`);
          breakReason = "the next paragraph and its spacing do not fit";
          break;
        }
        // Keep soft wraps soft: synthetic newlines add paragraphGap and indent
        // every line in guided typography. Measure the exact source slice, and
        // let the remaining source reflow at the next page's width and style.
        placed.push(paragraph.slice(0, end));
        if (!wholeFits && end < paragraph.length) {
          partial = paragraph.slice(end).trimStart();
          breakReason = "the next wrapped body line does not fit";
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
    const style = styleOf(page.flow);
    // A new paragraph also charges paragraphGap. Fullness means no further
    // body LINE fits, not merely that another paragraph cannot start.
    const full = flowText.trim().length > 0 && usedHeight + style.fontSize * style.lineHeight > page.flow.box.height + HEIGHT_EPS;
    result.push({ pageLabel: page.pageLabel, flowText, headingText, filled: full, usedHeight });
    breakReasons.push(breakReason);
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
      message: `The story leaves about ${remainingChars} characters after pagination reaches ${last.pageLabel}. ${input.manifest.fillAllInteriorPages
        ? "Use the measured raw-section targets to rebalance the manuscript: condense overlong sections and expand short sections before the reported boundaries. Keep already-full sections unchanged and preserve facts; do not merely cut the ending or shorten every heading."
        : result.some((page) => !page.filled)
          ? "Rebalance the section lengths and shorten headings to use the reported gaps first; condense any remaining excess without cutting facts. Do not increase the overall manuscript length while text still overflows."
          : "Condense the narrative without cutting facts or using placeholders."}`,
      slotId: last.flow.id,
      pageLabel: last.pageLabel,
    });
  }

  // A keep-with-next break is not a waiver. New AI pins also require the final
  // frame to fill; old pins retain their substantive-but-shorter ending policy.
  const requiredFullPages = input.manifest.fillAllInteriorPages ? result.length : result.length - 1;
  const firstUnfilled = result.findIndex((page, index) => !page.filled && index < requiredFullPages);
  const lastPage = result[result.length - 1];
  const lastSlot = pages[pages.length - 1].flow;
  const lastTooShort = lastPage.flowText.trim().length < lastSlot.minChars;
  if (firstUnfilled >= 0 || lastTooShort) {
    let deficit = 0;
    const gaps: string[] = [];
    for (let index = firstUnfilled >= 0 ? firstUnfilled : result.length - 1; index < requiredFullPages; index++) {
      if (result[index].filled) continue;
      const page = pages[index];
      const free = Math.max(0, page.flow.box.height - result[index].usedHeight);
      const style = styleOf(page.flow);
      const spareLines = Math.max(0, Math.floor((free + HEIGHT_EPS) / (style.fontSize * style.lineHeight)));
      deficit += maxCharsForBox(page.flow.box.width, free, style);
      gaps.push(`${page.pageLabel} has ${spareLines} unused body lines (${Math.round(result[index].usedHeight)}/${Math.round(page.flow.box.height)}px used): ${breakReasons[index]}.`);
    }
    if (lastTooShort && !input.manifest.fillAllInteriorPages) deficit += Math.max(0, lastSlot.minChars - lastPage.flowText.trim().length);
    const index = firstUnfilled >= 0 ? firstUnfilled : result.length - 1;
    const label = result[index].pageLabel;
    const currentChars = sections.reduce((sum, section) => sum + section.paragraphs.join("\n").length, 0);
    const moreChars = Math.max(1, Math.round(deficit * 1.1));
    const guidance = input.manifest.fillAllInteriorPages
      ? `The current manuscript has ${currentChars} body characters. Use the measured raw-section targets rather than adding this page-gap estimate to the whole manuscript. Expand or rebalance the sections BEFORE the reported gaps, not just the ending, and condense sections exceeding their own frames. Keep already-full sections unchanged. Balanced sections let the next heading use its fixed heading box without wasting body lines.`
      : remainingChars > 0
        ? `Rebalance content before the reported boundaries and shorten headings so their first body line can fit with them. The current manuscript has ${currentChars} body characters and still overflows; use the gaps before adding text, then condense any remaining excess.`
        : `Write roughly ${moreChars} more characters of finished copy. The current manuscript has ${currentChars} body characters; aim for about ${currentChars + moreChars} in the revised manuscript. Expand or rebalance the sections BEFORE the reported gaps, not just the ending; shorter headings may let the next section start inline.`;
    issues.push({
      code: "flow-underfull",
      message: `Body text stops filling pages at ${label}: ${input.manifest.fillAllInteriorPages ? "every interior page, including the final page, must fill completely" : "every non-final interior page must fill completely before text continues"}. ${gaps.join(" ")} ${guidance} Keep headings with their first body line. Use substantive detail, not blank lines or repeated text.`,
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
