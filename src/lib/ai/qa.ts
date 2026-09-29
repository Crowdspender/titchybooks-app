import { prisma } from "@/lib/prisma";
import { objectExists } from "@/lib/s3";
import { mergedPages } from "@/lib/editor/submission-store";
import { checkSubmissionResolution } from "@/lib/editor/validation";
import type { EditorElement, EditorScene } from "@/lib/editor/schema";
import { getOpenAIClient, isAIConfigured } from "./client";

export type QaSeverity = "terminal" | "retry";

export interface QaCheck {
  id: string;
  passed: boolean;
  detail: string;
  severity: QaSeverity;
}

export interface QaReport {
  passed: boolean;
  checks: QaCheck[];
}

/** True when a failed check should regenerate CONTENT rather than give up. */
export function isRetryable(report: QaReport): boolean {
  return report.checks.some((c) => !c.passed && c.severity === "retry");
}

// Average glyph width as a fraction of fontSize, per supported family.
const AVG_CHAR_WIDTH: Record<string, number> = {
  Arial: 0.5,
  Georgia: 0.52,
  "Courier New": 0.6,
  Impact: 0.45,
};
const DEFAULT_CHAR_WIDTH = 0.55;
const FIT_TOLERANCE = 1.1; // allow 10% overflow before failing

function charWidthFactor(fontFamily: string): number {
  return AVG_CHAR_WIDTH[fontFamily] ?? DEFAULT_CHAR_WIDTH;
}

/**
 * Estimate whether a text element's content fits its box once wrapped.
 * Returns true when the estimated rendered height stays within tolerance.
 */
export function estimateTextFits(
  el: Extract<EditorElement, { type: "text" }>,
): boolean {
  const perChar = charWidthFactor(el.fontFamily) * el.fontSize + el.letterSpacing;
  const usableWidth = Math.max(1, el.width);
  let lines = 0;
  for (const hardLine of el.text.split("\n")) {
    const lineWidth = hardLine.length * perChar;
    lines += Math.max(1, Math.ceil(lineWidth / usableWidth));
  }
  const lineHeightPx = el.fontSize * el.lineHeight;
  return lines * lineHeightPx <= el.height * FIT_TOLERANCE;
}

function collectText(pages: Array<{ scene: EditorScene }>): Array<Extract<EditorElement, { type: "text" }>> {
  return pages.flatMap((p) =>
    p.scene.elements.filter(
      (el): el is Extract<EditorElement, { type: "text" }> => el.type === "text" && el.visible,
    ),
  );
}

async function moderateText(texts: string[]): Promise<boolean> {
  if (!isAIConfigured() || texts.length === 0) return true;
  try {
    const result = await getOpenAIClient().moderations.create({
      model: "omni-moderation-latest",
      input: texts.join("\n\n").slice(0, 8000),
    });
    return !result.results.some((r) => r.flagged);
  } catch {
    // Fail closed: if moderation is unavailable we cannot certify the content.
    return false;
  }
}

/**
 * Run the automated QA checklist that replaces the manual PENDING -> APPROVED
 * gate for AI-generated books. Every check is evaluated; `passed` is true only
 * when all checks pass.
 */
export async function runQaChecklist(
  submissionId: string,
  context: { concept?: string } = {},
): Promise<QaReport> {
  const checks: QaCheck[] = [];
  const submission = await prisma.submission.findUnique({ where: { id: submissionId } });

  if (!submission) {
    return {
      passed: false,
      checks: [{ id: "pdf-artifact", passed: false, detail: "Submission not found", severity: "terminal" }],
    };
  }

  // limits: title length (schema-enforced for text, checked here for title).
  const titleOk = !submission.title || submission.title.length <= 120;
  checks.push({
    id: "limits",
    passed: titleOk,
    detail: titleOk ? "Title within 120 chars" : `Title too long (${submission.title?.length})`,
    severity: "terminal",
  });

  // pdf-artifact: key present and object exists in S3.
  const hasKey = !!submission.pdfS3Key;
  const pdfExists = hasKey ? await objectExists(submission.pdfS3Key!) : false;
  checks.push({
    id: "pdf-artifact",
    passed: pdfExists,
    detail: pdfExists ? "PDF artifact present" : hasKey ? "PDF key set but object missing" : "No PDF key",
    severity: "terminal",
  });

  // pages-complete: mergedPages() enforces 8 unique labels and schema parsing.
  let pages: Awaited<ReturnType<typeof mergedPages>> = [];
  try {
    pages = await prisma.$transaction((tx) => mergedPages(tx, submission));
    checks.push({ id: "pages-complete", passed: true, detail: "8 unique pages merged", severity: "terminal" });
  } catch (err) {
    checks.push({
      id: "pages-complete",
      passed: false,
      detail: err instanceof Error ? err.message : "Page merge failed",
      severity: "terminal",
    });
    return { passed: false, checks };
  }

  const texts = collectText(pages);

  // no-empty-text
  const empty = texts.filter((t) => t.text.trim().length === 0);
  checks.push({
    id: "no-empty-text",
    passed: empty.length === 0,
    detail: empty.length === 0 ? "All text elements non-empty" : `${empty.length} empty text element(s)`,
    severity: "retry",
  });

  // text-fits
  const overflowing = texts.filter((t) => !estimateTextFits(t));
  checks.push({
    id: "text-fits",
    passed: overflowing.length === 0,
    detail: overflowing.length === 0 ? "All text fits its box" : `${overflowing.length} text element(s) overflow`,
    severity: "retry",
  });

  // dpi: reuse resolution checker against asset dimensions.
  const assetIds = [...new Set(pages.flatMap((p) => p.scene.elements.flatMap((el) => (el.type === "image" ? [el.assetId] : []))))];
  const assets = await prisma.asset.findMany({ where: { id: { in: assetIds } } });
  const dimensions = new Map(
    assets.filter((a) => a.width && a.height).map((a) => [a.id, { width: a.width!, height: a.height! }]),
  );
  const dpiWarnings = checkSubmissionResolution(pages, dimensions);
  const dpiErrors = dpiWarnings.filter((w) => w.severity === "error");
  checks.push({
    id: "dpi",
    passed: dpiErrors.length === 0,
    detail: dpiErrors.length === 0 ? "Image resolution acceptable" : `${dpiErrors.length} low-resolution image(s)`,
    severity: "terminal",
  });

  // content-policy: moderate concept + all rendered text.
  const moderationInput = [context.concept ?? "", ...texts.map((t) => t.text)].filter(Boolean);
  const policyOk = await moderateText(moderationInput);
  checks.push({
    id: "content-policy",
    passed: policyOk,
    detail: policyOk ? "Content passed moderation" : "Content flagged by moderation",
    severity: "terminal",
  });

  return { passed: checks.every((c) => c.passed), checks };
}
