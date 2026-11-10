import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import { editorSceneSchema } from "@/lib/editor/schema";
import { MIN_BODY_POINT_SIZE, isSupportedFontFamily, ptToScenePx } from "@/lib/pdf/print-profile";
import {
  BOOK_PAGE_COUNT,
  PAGE_CONTENT_ROLE,
  ROLE_TEXT_BUDGET,
  brandingRegion,
  findUnsupportedCharacters,
  isBoxInsidePage,
  rectsOverlap,
} from "./book-contract";
import { buildManifestFromRows, generatedSlots, type AiTemplateManifest } from "./template-contract";

/**
 * One preflight routine shared by AI publication, the AI catalog filter, and
 * job enqueue/selection: if these three ever disagree, a book can be started
 * against a template that cannot finish.
 */
export interface PreflightIssue {
  code: string;
  message: string;
  pageLabel: PageLabel | null;
  elementId: string | null;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
}

export interface PreflightOptions {
  /** Asset ids known to exist; when provided, image references are validated. */
  knownAssetIds?: ReadonlySet<string>;
}

function issue(code: string, message: string, pageLabel: PageLabel | null = null, elementId: string | null = null): PreflightIssue {
  return { code, message, pageLabel, elementId };
}

/**
 * Validate a manifest against the book contract. Every failure names the page
 * (and element) that must be fixed, so publication errors are actionable.
 */
export function preflightManifest(manifest: AiTemplateManifest, options: PreflightOptions = {}): PreflightResult {
  const issues: PreflightIssue[] = [];

  // --- Page coverage ------------------------------------------------------
  const seenPages = new Set<PageLabel>();
  for (const page of manifest.pages) {
    if (!(PAGE_LABELS as readonly string[]).includes(page.pageLabel)) {
      issues.push(issue("unknown-page", `Unknown page label "${page.pageLabel}".`));
      continue;
    }
    if (seenPages.has(page.pageLabel)) {
      issues.push(issue("duplicate-page", `Page ${page.pageLabel} appears more than once.`, page.pageLabel));
      continue;
    }
    seenPages.add(page.pageLabel);
  }
  for (const label of PAGE_LABELS) {
    if (!seenPages.has(label)) issues.push(issue("missing-page", `Page ${label} is missing.`, label));
  }
  if (manifest.pages.length !== BOOK_PAGE_COUNT) {
    issues.push(issue("page-count", `A book needs exactly ${BOOK_PAGE_COUNT} pages, found ${manifest.pages.length}.`));
  }

  // --- Unique element ids -------------------------------------------------
  const ids = new Map<string, PageLabel>();
  for (const page of manifest.pages) {
    for (const slot of page.slots) {
      const existing = ids.get(slot.id);
      if (existing) {
        issues.push(issue("duplicate-id", `Element id "${slot.id}" is used on ${existing} and ${page.pageLabel}.`, page.pageLabel, slot.id));
      } else {
        ids.set(slot.id, page.pageLabel);
      }
    }
  }

  // --- Per-page generated content ----------------------------------------
  for (const page of manifest.pages) {
    const generated = page.slots.filter((slot) => slot.generated);
    if (generated.length === 0) {
      issues.push(
        issue(
          "no-generated-slot",
          `Page ${page.pageLabel} has no editable text slot for the ${PAGE_CONTENT_ROLE[page.pageLabel]} content.`,
          page.pageLabel,
        ),
      );
      continue;
    }
    const usable = generated.filter((slot) => slot.maxChars >= ROLE_TEXT_BUDGET[slot.role].minChars);
    if (usable.length === 0) {
      issues.push(
        issue(
          "slot-budget",
          `Page ${page.pageLabel} cannot hold the minimum ${PAGE_CONTENT_ROLE[page.pageLabel]} text budget.`,
          page.pageLabel,
        ),
      );
    }
  }

  // --- Slot geometry, typography, branding -------------------------------
  const minFontPx = ptToScenePx(MIN_BODY_POINT_SIZE);
  for (const page of manifest.pages) {
    const reserved = brandingRegion(page.pageLabel);
    for (const image of page.images) {
      if (!isBoxInsidePage(image.box)) {
        issues.push(issue("geometry", `Image "${image.id}" is outside the printable page area.`, page.pageLabel, image.id));
      }
      if (options.knownAssetIds && !options.knownAssetIds.has(image.assetId)) {
        issues.push(issue("missing-asset", `Image "${image.id}" references a missing asset.`, page.pageLabel, image.id));
      }
      if (reserved && rectsOverlap(image.box, reserved)) {
        issues.push(issue("branding-overlap", `Image "${image.id}" overlaps the reserved back-cover branding strip.`, page.pageLabel, image.id));
      }
    }
    for (const slot of page.slots) {
      if (!isBoxInsidePage(slot.box)) {
        issues.push(issue("geometry", `Element "${slot.id}" is outside the printable page area.`, page.pageLabel, slot.id));
      }
      if (!isSupportedFontFamily(slot.fontFamily)) {
        issues.push(issue("font-family", `Font "${slot.fontFamily}" is not supported for printing.`, page.pageLabel, slot.id));
      }
      const unsupported = findUnsupportedCharacters(slot.text);
      if (unsupported.length > 0) {
        issues.push(
          issue(
            "unsupported-glyph",
            `Element "${slot.id}" contains unsupported character(s): ${unsupported.join(" ")}.`,
            page.pageLabel,
            slot.id,
          ),
        );
      }
      if (slot.generated) {
        if (slot.style.fontSize < minFontPx) {
          issues.push(
            issue(
              "min-font-size",
              `Element "${slot.id}" renders below ${MIN_BODY_POINT_SIZE} pt at print scale.`,
              page.pageLabel,
              slot.id,
            ),
          );
        }
        if (reserved && rectsOverlap(slot.box, reserved)) {
          issues.push(
            issue("branding-overlap", `Element "${slot.id}" overlaps the reserved back-cover branding strip.`, page.pageLabel, slot.id),
          );
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Validate persisted TemplateElement rows (publication path). */
export function preflightTemplateRows(
  input: {
    templateId: string;
    templateVersion: number;
    rows: Array<{ pageLabel: string; elementJson: string }>;
    pageBackgrounds?: ReadonlyMap<PageLabel, string>;
  },
  options: PreflightOptions = {},
): { result: PreflightResult; manifest: AiTemplateManifest } {
  const { manifest, invalidElements } = buildManifestFromRows(input);
  const result = preflightManifest(manifest, options);
  for (const invalid of invalidElements) {
    const pageLabel = (PAGE_LABELS as readonly string[]).includes(invalid.pageLabel)
      ? (invalid.pageLabel as PageLabel)
      : null;
    result.issues.push(issue("invalid-element", invalid.reason, pageLabel));
  }
  result.ok = result.issues.length === 0;
  return { result, manifest };
}

/**
 * Page backgrounds come from the persisted scene, so publication, catalog and
 * pipeline all see the colour the editor actually saved. A page whose scene
 * cannot be parsed is simply absent; preflight reports it via the element rows.
 */
export function pageBackgroundsFromScenes(
  pages: ReadonlyArray<{ pageLabel: string; sceneJson: string }>,
): Map<PageLabel, string> {
  const backgrounds = new Map<PageLabel, string>();
  for (const page of pages) {
    if (!(PAGE_LABELS as readonly string[]).includes(page.pageLabel)) continue;
    try {
      const scene = editorSceneSchema.parse(JSON.parse(page.sceneJson));
      backgrounds.set(page.pageLabel as PageLabel, scene.page.backgroundColor);
    } catch {
      // A page whose scene cannot be parsed fails preflight on its rows.
    }
  }
  return backgrounds;
}

/** Human-readable one-liner used in publication errors and admin UI. */
export function summarizePreflight(result: PreflightResult): string {
  if (result.ok) return "Template is AI-ready.";
  const first = result.issues[0];
  const detail = first.pageLabel ? `${first.pageLabel}: ${first.message}` : first.message;
  return result.issues.length === 1 ? detail : `${detail} (+${result.issues.length - 1} more)`;
}

/**
 * Require a published template to be AI-ready. Used by the pipeline before it
 * starts writing, so an incompatible template fails once, cheaply, instead of
 * after paying for generation.
 */
export function assertPreflight(result: PreflightResult): void {
  if (result.ok) return;
  throw new Error(summarizePreflight(result));
}

/** True when every required page has at least one generated slot. */
export function hasCompleteSlotCoverage(manifest: AiTemplateManifest): boolean {
  const generatedByPage = new Map<PageLabel, number>();
  for (const slot of generatedSlots(manifest)) {
    generatedByPage.set(slot.pageLabel, (generatedByPage.get(slot.pageLabel) ?? 0) + 1);
  }
  return PAGE_LABELS.every((label) => (generatedByPage.get(label) ?? 0) > 0);
}
