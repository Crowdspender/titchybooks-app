import { setTimeout as sleep } from "node:timers/promises";
import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { EDITOR_DEFAULT_BACKGROUND_COLOR } from "@/lib/editor/constants";
import { editorElementSchema, type EditorElement } from "@/lib/editor/schema";
import { createInstanceWithOverrides, rewriteInstanceOverrides, type Actor } from "@/lib/editor/submission-store";
import { enqueueRenderJob } from "@/lib/pdf/render-job";
import { MAX_TITLE_CHARS } from "./book-contract";
import {
  bookPlanSystemPrompt,
  bookPlanUserPrompt,
  bookRepairSystemPrompt,
  bookRepairUserPrompt,
  promptSlots,
  type PromptSlot,
} from "./book-prompts";
import {
  buildOverridesByPage,
  slotsFromManifest,
  validatePlanAgainstSlots,
  type PlanIssue,
  type TemplateTextSlot,
} from "./composer";
import { normalizeContentPlan, type ContentPlan } from "./content-plan";
import { getOpenAIClient, getOpenAIModel } from "./client";
import { hasTerminalFinding, isRetryable, repairFeedback, repairableSlotIds, runQaChecklist, type QaReport } from "./qa";
import {
  buildPinnedTemplate,
  generatedSlots,
  parsePinnedTemplate,
  type AiTemplateManifest,
  type AiTemplateSlot,
  type PinnedTemplate,
  type TemplatePageSource,
} from "./template-contract";
import { summarizePreflight } from "./template-preflight";
import { evaluateTemplateReadiness } from "./template-readiness";
import {
  AiBookStage,
  AiBookTerminalError,
  advanceStage,
  completeAiBook,
  continueAiBook,
  failAiBook,
  heartbeatAiBookJob,
  CONTINUE_DELAY_MS,
  HEARTBEAT_MS,
  type ClaimedAiBookJob,
  type ContinueOutcome,
} from "./ai-book-job";

/**
 * Autonomous book pipeline: CONCEPT -> CONTENT -> COMPOSE -> RENDER -> QA.
 *
 * Every stage persists enough state to be resumed by a later claim, and every
 * side effect runs inside a lease-fenced transaction. Waiting on the render
 * queue and handing a job back to the scheduler are *continuations*: they do
 * not spend the failure budget, because nothing failed. Only a real error, or
 * an abandoned lease reclaimed by another worker, consumes it.
 */

const QA_SAMPLE_RATE = Number(process.env.AI_QA_SAMPLE_RATE ?? 0.1);
/** How long one claim watches the render queue before deferring to a later claim. */
const RENDER_POLL_MS = Number(process.env.AI_RENDER_POLL_MS ?? 5_000);
const RENDER_WAIT_CAP_MS = 10 * 60 * 1000;
/** Budget kept in reserve so a claim is never frozen mid-stage by a drain. */
const YIELD_MARGIN_MS = 12_000;
/** Extra attempts inside one CONTENT claim before the failure budget is touched. */
const PLAN_ATTEMPTS = 1;
/** A moderation outage must not retry forever; the job deadline is the outer bound. */
const MAX_TRANSIENT_QA = 3;
const MAX_TEMPLATE_CANDIDATES = 20;

/** The lease was lost; another worker owns this job and will finish it. */
class LeaseLost extends Error {}

const STAGE_ORDER: AiBookStage[] = [
  AiBookStage.CONCEPT,
  AiBookStage.CONTENT,
  AiBookStage.COMPOSE,
  AiBookStage.RENDER,
  AiBookStage.QA,
];

export interface ProcessAiBookJobOptions {
  /**
   * Wall-clock deadline (epoch ms) from a serverless drain. The pipeline hands
   * the job back before the budget runs out instead of being frozen mid-lease,
   * so the next invocation resumes from the persisted stage. Omitted by the
   * long-lived worker.
   */
  deadlineMs?: number;
}

/** Stop this claim: the job is already requeued or terminally failed. */
type StageResult = "continue" | undefined;

interface TemplateBundle {
  templateId: string;
  templateVersion: number;
  title: string;
  manifest: AiTemplateManifest;
  pinned: PinnedTemplate;
}

interface PipelineState {
  templateId: string | null;
  pinned: PinnedTemplate | null;
  manifest: AiTemplateManifest | null;
  contentPlan: ContentPlan | null;
  qaReport: QaReport | null;
  qaTransient: number;
  submissionId: string | null;
  renderJobId: string | null;
}

// --- Shared helpers -------------------------------------------------------

async function chatJson(system: string, user: string): Promise<string> {
  const openai = getOpenAIClient();
  const resp = await openai.chat.completions.create({
    model: getOpenAIModel(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    reasoning_effort: "low",
    max_completion_tokens: 8000,
  });
  return resp.choices[0]?.message?.content ?? "";
}

function summarizeIssues(issues: PlanIssue[]): string {
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.pageLabel ?? "book"} ${issue.slotId ?? ""}: ${issue.message}`)
    .join("; ");
}

/** advanceStage that aborts the pipeline when the lease was lost. */
async function mustAdvance(
  job: ClaimedAiBookJob,
  stage: AiBookStage,
  outputPatch: Record<string, unknown> = {},
  data: { submissionId?: string; renderJobId?: string } = {},
  extra?: Parameters<typeof advanceStage>[4],
): Promise<void> {
  if (!(await advanceStage(job, stage, outputPatch, data, extra))) throw new LeaseLost();
}

/**
 * Turn a continuation outcome into a pipeline result. A repair that has run
 * out of budget is a terminal failure, not a wait.
 */
function continuation(
  outcome: ContinueOutcome,
  stage: AiBookStage,
  jobId: string,
): StageResult {
  if (outcome === "repair-exhausted") {
    throw new AiBookTerminalError("Automated QA rejected this book after the allowed repair attempts.");
  }
  if (outcome !== "queued") {
    console.info(JSON.stringify({ event: `ai-book-${outcome}`, jobId, stage }));
  }
  return "continue";
}

// --- CONCEPT: resolve and pin a template ---------------------------------

function parseTemplateRows(
  rows: Array<{ pageLabel: string; elementJson: string }>,
): Map<PageLabel, EditorElement[]> {
  const byPage = new Map<PageLabel, EditorElement[]>();
  for (const row of rows) {
    if (!(PAGE_LABELS as readonly string[]).includes(row.pageLabel)) continue;
    let json: unknown;
    try {
      json = JSON.parse(row.elementJson);
    } catch {
      continue; // preflight already reports unusable elements
    }
    const parsed = editorElementSchema.safeParse(json);
    if (!parsed.success) continue;
    const pageLabel = row.pageLabel as PageLabel;
    const elements = byPage.get(pageLabel) ?? [];
    elements.push(parsed.data);
    byPage.set(pageLabel, elements);
  }
  return byPage;
}

/**
 * Load a published template and freeze it into a pinned manifest.
 *
 * The pin is what the rest of the pipeline generates against, so a template
 * edit between CONCEPT and QA cannot change the book being produced.
 */
async function loadTemplateBundle(templateId: string): Promise<TemplateBundle> {
  const template = await prisma.submission.findUnique({
    where: { id: templateId },
    select: { id: true, title: true, isTemplate: true, status: true, version: true },
  });
  if (!template || !template.isTemplate || template.status !== "APPROVED") {
    throw new AiBookTerminalError("The requested template is not available.");
  }
  const [rows, pages] = await Promise.all([
    prisma.templateElement.findMany({
      where: { templateId },
      orderBy: { order: "asc" },
      select: { pageLabel: true, elementJson: true },
    }),
    prisma.submissionPage.findMany({
      where: { submissionId: templateId },
      select: { pageLabel: true, sceneJson: true },
    }),
  ]);
  // Same readiness check as publication, so a template cannot be published as
  // AI-ready and then rejected here (or the reverse).
  const { result, manifest, backgrounds } = await evaluateTemplateReadiness({
    templateId,
    templateVersion: template.version,
    elements: rows,
    pages,
  });
  if (!result.ok) {
    throw new AiBookTerminalError(`This template is not AI-ready yet: ${summarizePreflight(result)}`);
  }
  const byPage = parseTemplateRows(rows);
  const sources: TemplatePageSource[] = PAGE_LABELS.map((pageLabel) => ({
    pageLabel,
    backgroundColor: backgrounds.get(pageLabel) ?? EDITOR_DEFAULT_BACKGROUND_COLOR,
    elements: byPage.get(pageLabel) ?? [],
  }));
  return {
    templateId,
    templateVersion: template.version,
    title: template.title ?? "Untitled template",
    manifest,
    pinned: buildPinnedTemplate({
      templateId,
      templateVersion: template.version,
      manifest,
      pages: sources,
    }),
  };
}

async function chooseTemplate(concept: string, candidates: TemplateBundle[]): Promise<TemplateBundle> {
  if (candidates.length === 1) return candidates[0];
  const raw = await chatJson(
    "You select the best Titchybooks template for a user's book request. Respond with raw JSON only.",
    `Book request: "${concept}"\n\nAvailable templates:\n${candidates
      .map(
        (candidate) =>
          `- id: ${candidate.templateId} | title: "${candidate.title}" | text slots: ${generatedSlots(candidate.manifest).length}`,
      )
      .join("\n")}\n\nReturn {"templateId": "<one of the ids above>"}.`,
  );
  try {
    const parsed = JSON.parse(raw) as { templateId?: string };
    const match = candidates.find((candidate) => candidate.templateId === parsed.templateId);
    if (match) return match;
  } catch {
    // Fall through to the first AI-ready template.
  }
  return candidates[0];
}

/** CONCEPT: resolve which AI-ready template to use and pin it. */
async function runConceptStage(job: ClaimedAiBookJob, state: PipelineState): Promise<void> {
  let bundle: TemplateBundle;
  if (job.templateId) {
    bundle = await loadTemplateBundle(job.templateId);
  } else {
    const approved = await prisma.submission.findMany({
      where: { isTemplate: true, status: "APPROVED" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: MAX_TEMPLATE_CANDIDATES,
    });
    const candidates: TemplateBundle[] = [];
    for (const row of approved) {
      try {
        candidates.push(await loadTemplateBundle(row.id));
      } catch (error) {
        // A published template that is not AI-ready is simply not a candidate.
        if (!(error instanceof AiBookTerminalError)) throw error;
      }
    }
    if (candidates.length === 0) {
      throw new AiBookTerminalError("No AI-ready template is available yet. Please try again later.");
    }
    bundle = await chooseTemplate(job.concept, candidates);
  }

  state.templateId = bundle.templateId;
  state.pinned = bundle.pinned;
  state.manifest = bundle.manifest;
  await mustAdvance(job, AiBookStage.CONTENT, {
    templateId: bundle.templateId,
    pinnedTemplate: bundle.pinned,
    manifest: bundle.manifest,
  });
}

// --- CONTENT: plan, then repair only what QA rejected --------------------

interface SlotSet {
  manifestSlots: AiTemplateSlot[];
  slots: TemplateTextSlot[];
  prompts: PromptSlot[];
}

function slotSetOf(manifest: AiTemplateManifest): SlotSet {
  return {
    manifestSlots: generatedSlots(manifest),
    slots: slotsFromManifest(manifest),
    prompts: promptSlots(generatedSlots(manifest)),
  };
}

function coverTitleSlot(slots: TemplateTextSlot[]): TemplateTextSlot | null {
  return slots.find((slot) => slot.role === "title") ?? null;
}

/**
 * Keep the draft title identical to the cover title. The model is asked to do
 * this itself; enforcing it server-side means a sleepy model cannot produce a
 * book whose listing disagrees with its cover.
 */
function syncTitle(plan: ContentPlan, slots: TemplateTextSlot[]): ContentPlan {
  const slot = coverTitleSlot(slots);
  if (!slot) return plan;
  const override = plan.overrides.find((entry) => entry.templateElementId === slot.id);
  const text = override?.text.trim();
  if (!text) return plan;
  return { ...plan, title: text.slice(0, MAX_TITLE_CHARS) };
}

async function writeContent(concept: string, set: SlotSet): Promise<ContentPlan> {
  const system = bookPlanSystemPrompt();
  const user = bookPlanUserPrompt(concept, set.prompts);
  let lastError = "The AI returned an invalid content plan.";
  for (let attempt = 0; attempt <= PLAN_ATTEMPTS; attempt++) {
    const prompt =
      attempt === 0
        ? user
        : `${user}\n\nYour previous answer was rejected: ${lastError}\nReturn corrected JSON only.`;
    const plan = normalizeContentPlan(JSON.parse(await chatJson(system, prompt)) as unknown);
    if (!plan) {
      lastError = "The response was not valid JSON matching the required schema.";
      continue;
    }
    const synced = syncTitle(plan, set.slots);
    const validation = validatePlanAgainstSlots(synced, set.slots, { requireAllRequired: true });
    if (!validation.ok) {
      lastError = summarizeIssues(validation.issues);
      continue;
    }
    return synced;
  }
  throw new Error(`The AI could not write a usable book: ${lastError}`);
}

/** Merge repaired overrides onto the accepted plan without rewriting accepted pages. */
function mergeRepair(base: ContentPlan, patch: ContentPlan, targets: ReadonlySet<string>, slots: TemplateTextSlot[]): ContentPlan {
  const kept = base.overrides.filter((entry) => !targets.has(entry.templateElementId));
  const repaired = patch.overrides.filter((entry) => targets.has(entry.templateElementId));
  const titleSlot = coverTitleSlot(slots);
  const titleChanges = titleSlot ? targets.has(titleSlot.id) : false;
  return {
    version: 2,
    brief: patch.brief ?? base.brief,
    outline: patch.outline ?? base.outline,
    title: titleChanges ? patch.title : base.title,
    overrides: [...kept, ...repaired],
  };
}

async function repairContent(
  concept: string,
  set: SlotSet,
  base: ContentPlan,
  report: QaReport,
  targets: ReadonlySet<string>,
): Promise<ContentPlan> {
  const targetPrompts = set.prompts.filter((slot) => targets.has(slot.id));
  if (targetPrompts.length === 0) return writeContent(concept, set);
  const system = bookRepairSystemPrompt();
  const user = bookRepairUserPrompt({
    concept,
    slots: targetPrompts,
    title: base.title,
    accepted: base.overrides,
    feedback: repairFeedback(report),
  });
  let lastError = "The AI returned an invalid repair.";
  for (let attempt = 0; attempt <= PLAN_ATTEMPTS; attempt++) {
    const prompt =
      attempt === 0
        ? user
        : `${user}\n\nYour previous answer was rejected: ${lastError}\nReturn corrected JSON only.`;
    const patch = normalizeContentPlan(JSON.parse(await chatJson(system, prompt)) as unknown);
    if (!patch) {
      lastError = "The response was not valid JSON matching the required schema.";
      continue;
    }
    const merged = syncTitle(mergeRepair(base, patch, targets, set.slots), set.slots);
    const validation = validatePlanAgainstSlots(merged, set.slots, { requireAllRequired: true });
    if (!validation.ok) {
      lastError = summarizeIssues(validation.issues);
      continue;
    }
    return merged;
  }
  throw new Error(`The AI could not repair the rejected pages: ${lastError}`);
}

async function runContentStage(job: ClaimedAiBookJob, state: PipelineState): Promise<void> {
  if (!state.manifest) throw new AiBookTerminalError("Missing the pinned template.");
  const set = slotSetOf(state.manifest);
  const repairTargets = state.qaReport ? repairableSlotIds(state.qaReport) : new Set<string>();
  const plan =
    state.contentPlan && state.qaReport && repairTargets.size > 0
      ? await repairContent(job.concept, set, state.contentPlan, state.qaReport, repairTargets)
      : await writeContent(job.concept, set);

  state.contentPlan = plan;
  await mustAdvance(job, AiBookStage.COMPOSE, { contentPlan: plan });
}

// --- COMPOSE: one transaction writes the draft and advances the job ------

async function runComposeStage(job: ClaimedAiBookJob, state: PipelineState): Promise<void> {
  if (!state.templateId || !state.manifest || !state.contentPlan) {
    throw new AiBookTerminalError("Missing the template or content plan.");
  }
  const set = slotSetOf(state.manifest);
  const overrides = buildOverridesByPage(state.contentPlan, set.slots);
  if (Object.keys(overrides).length === 0) {
    throw new AiBookTerminalError("The content plan produced no text to compose.");
  }
  const actor: Actor = { id: job.userId, role: "USER" };
  const pinned = state.pinned ?? undefined;
  const existingId = state.submissionId;

  let submissionId = existingId;
  await mustAdvance(job, AiBookStage.RENDER, { contentPlan: state.contentPlan }, {}, async (tx) => {
    if (submissionId) {
      await rewriteInstanceOverrides(submissionId, overrides, { tx, title: state.contentPlan!.title });
      return { submissionId };
    }
    submissionId = await createInstanceWithOverrides(
      actor,
      state.templateId!,
      state.contentPlan!.title,
      overrides,
      { tx, pinnedTemplate: pinned },
    );
    return { submissionId };
  });
  if (!submissionId) throw new AiBookTerminalError("The book draft could not be created.");
  state.submissionId = submissionId;
}

// --- RENDER: treat the render queue as a dependency, not a sub-step ------

function hasPublishedArtifacts(submission: {
  status: string;
  pdfS3Key: string | null;
  readingPdfS3Key: string | null;
  artifactManifest: unknown;
}): boolean {
  return Boolean(
    submission.pdfS3Key &&
      submission.readingPdfS3Key &&
      submission.artifactManifest &&
      (submission.status === "PENDING" || submission.status === "APPROVED"),
  );
}

/**
 * Enqueue a render for the finished draft.
 *
 * AI books never force a render: a template whose artwork cannot print at the
 * qualified DPI cannot produce a "finished" book, and silently accepting it
 * would ship a file that fails at the printer.
 */
async function enqueueAiRender(job: ClaimedAiBookJob, submissionId: string): Promise<string> {
  const actor: Actor = { id: job.userId, role: "USER" };
  try {
    const result = await enqueueRenderJob(submissionId, actor, { force: false });
    return result.jobId;
  } catch (error) {
    const details = (error as { details?: { canForce?: boolean } }).details;
    if (details?.canForce) {
      throw new AiBookTerminalError(
        "This template's images print below the minimum resolution, so the book cannot be finished automatically.",
      );
    }
    throw error;
  }
}

async function deferToRender(job: ClaimedAiBookJob, renderJobId: string): Promise<StageResult> {
  const outcome = await continueAiBook(job, {
    stage: AiBookStage.RENDER,
    data: { renderJobId },
    patch: { renderJobId },
    notBeforeMs: RENDER_POLL_MS,
  });
  return continuation(outcome, AiBookStage.RENDER, job.id);
}

async function runRenderStage(
  job: ClaimedAiBookJob,
  state: PipelineState,
  lostLease: () => boolean,
  deadlineMs: number | undefined,
): Promise<StageResult> {
  const submissionId = state.submissionId;
  if (!submissionId) throw new AiBookTerminalError("Missing the draft to render.");

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      status: true,
      pdfS3Key: true,
      readingPdfS3Key: true,
      artifactManifest: true,
    },
  });
  if (!submission) throw new AiBookTerminalError("The book draft no longer exists.");

  if (hasPublishedArtifacts(submission)) {
    const renderJobId = state.renderJobId;
    await mustAdvance(job, AiBookStage.QA, {}, renderJobId ? { renderJobId } : {});
    return;
  }

  const latest = await prisma.renderJob.findFirst({
    where: { submissionId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, errorMessage: true },
  });
  if (latest?.status === "FAILED") {
    // The dependency failed. Spending one failure here (rather than deferring
    // again) is what bounds a permanently failing render.
    throw new Error(latest.errorMessage ?? "Rendering failed.");
  }

  let renderJobId = latest && (latest.status === "QUEUED" || latest.status === "PROCESSING") ? latest.id : null;
  if (!renderJobId) renderJobId = await enqueueAiRender(job, submissionId);
  state.renderJobId = renderJobId;

  const ownDeadline = job.deadlineAt?.getTime();
  const waitUntil = Math.min(
    Date.now() + RENDER_WAIT_CAP_MS,
    deadlineMs ?? Number.POSITIVE_INFINITY,
    ownDeadline ?? Number.POSITIVE_INFINITY,
  );

  while (Date.now() + RENDER_POLL_MS + YIELD_MARGIN_MS < waitUntil) {
    if (lostLease()) return "continue";
    const current = await prisma.renderJob.findUnique({
      where: { id: renderJobId },
      select: { status: true, errorMessage: true, pdfS3Key: true, readingPdfS3Key: true, artifactManifest: true },
    });
    if (!current) throw new AiBookTerminalError("The render job disappeared.");
    if (current.status === "COMPLETED") {
      await mustAdvance(job, AiBookStage.QA, {}, { renderJobId });
      return;
    }
    if (current.status === "FAILED") {
      throw new Error(current.errorMessage ?? "Rendering failed.");
    }
    await sleep(RENDER_POLL_MS);
  }

  return deferToRender(job, renderJobId);
}

// --- QA: artifact-bound approval with a bounded repair budget ------------

function transientOnly(report: QaReport): boolean {
  const findings = report.findings ?? [];
  return findings.length > 0 && findings.every((finding) => finding.severity === "transient");
}

async function runQaStage(job: ClaimedAiBookJob, state: PipelineState): Promise<StageResult> {
  const submissionId = state.submissionId;
  if (!submissionId) throw new AiBookTerminalError("Missing the draft for QA.");

  const report = await runQaChecklist(submissionId, {
    concept: job.concept,
    renderJobId: state.renderJobId,
  });
  state.qaReport = report;

  if (report.passed) {
    const sampled = Math.random() < QA_SAMPLE_RATE;
    const revision = report.artifact?.submissionRevision;
    const completed = await completeAiBook(job, { qaReport: report, qaSampled: sampled }, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Submission" WHERE "id" = ${submissionId} FOR UPDATE`;
      const current = await tx.submission.findUnique({
        where: { id: submissionId },
        select: { revision: true, status: true },
      });
      if (!current) throw new AiBookTerminalError("The book draft no longer exists.");
      // Approval is bound to the exact artifacts that were inspected: if the
      // draft moved on, those PDFs no longer describe this book.
      if (revision !== undefined && revision !== current.revision) {
        throw new AiBookTerminalError("The book changed while it was being checked. Please create it again.");
      }
      if (current.status === "APPROVED") return;
      await tx.submission.update({
        where: { id: submissionId },
        data: { status: "APPROVED", qaSampled: sampled },
      });
    });
    if (!completed) throw new LeaseLost();
    return;
  }

  if (hasTerminalFinding(report)) {
    const first = (report.findings ?? []).find((finding) => finding.severity === "terminal");
    throw new AiBookTerminalError(first?.detail ?? "Automated QA rejected this book.");
  }
  if (!isRetryable(report)) {
    throw new AiBookTerminalError("Automated QA rejected this book. It has been left for manual review.");
  }

  // A provider outage is not the book's fault: retry QA without rewriting text.
  if (transientOnly(report)) {
    if (state.qaTransient >= MAX_TRANSIENT_QA) {
      throw new AiBookTerminalError("Automated QA is temporarily unavailable and this book could not be verified.");
    }
    const outcome = await continueAiBook(job, {
      stage: AiBookStage.QA,
      patch: { qaReport: report, qaTransient: state.qaTransient + 1 },
      notBeforeMs: CONTINUE_DELAY_MS,
    });
    return continuation(outcome, AiBookStage.QA, job.id);
  }

  // Content was rejected: spend one repair cycle on the rejected slots only.
  const outcome = await continueAiBook(job, {
    stage: AiBookStage.CONTENT,
    patch: { qaReport: report, qaTransient: 0 },
    repair: true,
  });
  return continuation(outcome, AiBookStage.CONTENT, job.id);
}

// --- Entry point ---------------------------------------------------------

function stageIndex(stage: string): number {
  const index = STAGE_ORDER.indexOf(stage as AiBookStage);
  return index < 0 ? 0 : index;
}

/** Restore the persisted QA report so a resumed repair targets the same slots. */
function restoreQaReport(value: unknown): QaReport | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<QaReport>;
  if (typeof candidate.passed !== "boolean" || !Array.isArray(candidate.checks)) return null;
  return {
    passed: candidate.passed,
    checks: candidate.checks,
    findings: Array.isArray(candidate.findings) ? candidate.findings : undefined,
    artifact: candidate.artifact ?? null,
  };
}

function initialState(job: ClaimedAiBookJob): PipelineState {
  const output = (job.stageOutput ?? {}) as Record<string, unknown>;
  const pinned = parsePinnedTemplate(output.pinnedTemplate);
  return {
    templateId: job.templateId ?? (output.templateId as string | undefined) ?? null,
    pinned,
    manifest: pinned?.manifest ?? null,
    contentPlan: normalizeContentPlan(output.contentPlan),
    qaReport: restoreQaReport(output.qaReport),
    qaTransient: Number(output.qaTransient ?? 0) || 0,
    submissionId: job.submissionId ?? (output.submissionId as string | undefined) ?? null,
    renderJobId: job.renderJobId ?? (output.renderJobId as string | undefined) ?? null,
  };
}

/**
 * Execute the autonomous pipeline for a claimed job. Resumes from the
 * persisted stage, keeps the lease alive with a heartbeat, and stops quietly
 * when the lease is lost.
 *
 * Returns "yielded" when the job was handed back to the scheduler (waiting on
 * a render, or out of drain budget): it is already requeued at its persisted
 * stage and must not be failed. Resolves otherwise (completed, failed, or
 * lease lost).
 */
export async function processAiBookJob(
  job: ClaimedAiBookJob,
  options: ProcessAiBookJobOptions = {},
): Promise<"yielded" | undefined> {
  let lostLease = false;
  let currentStage: string = job.stage;
  const timer = setInterval(() => {
    void heartbeatAiBookJob(job)
      .then((ok) => {
        if (!ok) lostLease = true;
      })
      .catch(() => {
        lostLease = true;
      });
  }, HEARTBEAT_MS);

  try {
    if (job.exhausted) {
      await failAiBook(job, true, "This AI book could not be completed after several attempts.");
      return;
    }
    if (job.deadlineExpired) {
      await failAiBook(job, true, "This AI book exceeded its generation time limit.");
      return;
    }

    const state = initialState(job);

    // Jobs queued before templates were pinned cannot be resumed safely: their
    // content was written against live template rows. Restart them from
    // CONCEPT so they generate against a pin like every other book.
    let index = stageIndex(job.stage);
    if (index > 0 && !state.pinned) {
      console.info(JSON.stringify({ event: "ai-book-repin", jobId: job.id, from: job.stage }));
      index = 0;
    }

    for (; index < STAGE_ORDER.length; index++) {
      if (lostLease) return;
      const stage = STAGE_ORDER[index];
      currentStage = stage;

      let result: StageResult = undefined;
      if (stage === AiBookStage.CONCEPT) {
        await runConceptStage(job, state);
      } else if (stage === AiBookStage.CONTENT) {
        await runContentStage(job, state);
      } else if (stage === AiBookStage.COMPOSE) {
        await runComposeStage(job, state);
      } else if (stage === AiBookStage.RENDER) {
        result = await runRenderStage(job, state, () => lostLease, options.deadlineMs);
      } else {
        result = await runQaStage(job, state);
      }

      if (result === "continue") return "yielded";
      console.info(JSON.stringify({ event: "ai-book-stage-finished", jobId: job.id, stage }));
    }
  } catch (error) {
    if (error instanceof LeaseLost) {
      console.warn(JSON.stringify({ event: "ai-book-lease-lost", jobId: job.id, stage: currentStage }));
      return;
    }
    const terminal = error instanceof AiBookTerminalError;
    const message = error instanceof Error ? error.message : undefined;
    console.error(
      JSON.stringify({
        event: "ai-book-failed",
        jobId: job.id,
        stage: currentStage,
        terminal,
        message,
      }),
    );
    if (!lostLease) await failAiBook(job, terminal, message);
  } finally {
    clearInterval(timer);
  }
}
