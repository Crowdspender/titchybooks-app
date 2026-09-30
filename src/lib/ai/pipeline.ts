import { setTimeout as sleep } from "node:timers/promises";
import { prisma } from "@/lib/prisma";
import { editorElementSchema } from "@/lib/editor/schema";
import {
  createInstanceWithOverrides,
  rewriteInstanceOverrides,
  type Actor,
} from "@/lib/editor/submission-store";
import { enqueueRenderJob } from "@/lib/pdf/render-job";
import { getOpenAIClient, getOpenAIModel } from "./client";
import { PAGE_DESCRIPTIONS } from "./system-prompt";
import { parseContentPlan, type ContentPlan } from "./content-plan";
import {
  buildOverridesByPage,
  validatePlanAgainstTemplate,
  type OverridesByPage,
  type TemplateTextSlot,
} from "./composer";
import { runQaChecklist, isRetryable, type QaReport } from "./qa";
import {
  AiBookStage,
  AiBookTerminalError,
  advanceStage,
  completeAiBook,
  failAiBook,
  heartbeatAiBookJob,
  HEARTBEAT_MS,
  type ClaimedAiBookJob,
} from "./ai-book-job";

const QA_SAMPLE_RATE = Number(process.env.AI_QA_SAMPLE_RATE ?? 0.1);
const RENDER_POLL_MS = 5_000;
const RENDER_WAIT_CAP_MS = 5 * 60 * 1000;
const CONTENT_MAX_ATTEMPTS = 2;

/** A failure that should not be retried (job is marked FAILED). */
class TerminalError extends Error {}
/** A failure that should re-run from an earlier stage until attempts exhaust. */
class RetryableError extends Error {}
/** The lease was lost mid-stage; stop work and let another worker reclaim. */
class LeaseLostError extends Error {}

/** A fillable text slot in a template, keyed by the element id used for overrides. */
interface TextSlotInfo {
  id: string;
  pageLabel: string;
  currentText: string;
}

const STAGE_ORDER = [
  AiBookStage.CONCEPT,
  AiBookStage.CONTENT,
  AiBookStage.COMPOSE,
  AiBookStage.RENDER,
  AiBookStage.QA,
];

async function chatJson(system: string, user: string): Promise<string> {
  const openai = getOpenAIClient();
  const resp = await openai.chat.completions.create({
    model: getOpenAIModel(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.8,
    max_tokens: 2000,
  });
  return resp.choices[0]?.message?.content ?? "";
}

async function loadTextSlots(templateId: string): Promise<TextSlotInfo[]> {
  const rows = await prisma.templateElement.findMany({
    where: { templateId },
    orderBy: { order: "asc" },
  });
  const slots: TextSlotInfo[] = [];
  for (const row of rows) {
    const parsed = editorElementSchema.safeParse(JSON.parse(row.elementJson));
    if (parsed.success && parsed.data.type === "text") {
      slots.push({ id: parsed.data.id, pageLabel: row.pageLabel, currentText: parsed.data.text });
    }
  }
  return slots;
}

/** CONCEPT: resolve which approved template to use (user-chosen or AI-selected). */
async function resolveTemplate(concept: string, requestedId: string | null): Promise<string> {
  if (requestedId) {
    const t = await prisma.submission.findUnique({ where: { id: requestedId } });
    if (!t || !t.isTemplate || t.status !== "APPROVED") {
      throw new TerminalError("The requested template is not available.");
    }
    const slots = await loadTextSlots(requestedId);
    if (slots.length === 0) throw new TerminalError("The requested template has no editable text.");
    return requestedId;
  }

  const templates = await prisma.submission.findMany({
    where: { isTemplate: true, status: "APPROVED" },
    select: { id: true, title: true },
  });
  const candidates: Array<{ id: string; title: string; slotCount: number; pages: string[] }> = [];
  for (const t of templates) {
    const slots = await loadTextSlots(t.id);
    if (slots.length === 0) continue;
    candidates.push({
      id: t.id,
      title: t.title ?? "Untitled template",
      slotCount: slots.length,
      pages: [...new Set(slots.map((s) => s.pageLabel))],
    });
  }
  if (candidates.length === 0) {
    throw new TerminalError("No published template with editable text is available yet.");
  }
  if (candidates.length === 1) return candidates[0].id;

  const raw = await chatJson(
    "You select the best Titchybooks template for a user's concept. Respond with raw JSON only.",
    `Concept: "${concept}"\n\nAvailable templates:\n${candidates
      .map((c) => `- id: ${c.id} | title: "${c.title}" | text slots: ${c.slotCount} | pages: ${c.pages.join(", ")}`)
      .join("\n")}\n\nReturn {"templateId": "<one of the ids above>"}.`,
  );
  let chosen: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { templateId?: string };
    if (parsed.templateId && candidates.some((c) => c.id === parsed.templateId)) chosen = parsed.templateId;
  } catch {
    chosen = null;
  }
  return chosen ?? candidates[0].id;
}

/** CONTENT: generate a validated content plan for the chosen template's slots. */
async function generateContent(concept: string, slots: TextSlotInfo[]): Promise<ContentPlan> {
  const slotLines = slots
    .map((s) => {
      const desc = PAGE_DESCRIPTIONS[s.pageLabel as keyof typeof PAGE_DESCRIPTIONS] ?? s.pageLabel;
      return `- id: "${s.id}" | page: ${s.pageLabel} (${desc}) | example of what goes here: "${s.currentText.slice(0, 80)}"`;
    })
    .join("\n");

  const system = `You are "Titchybooks AI". You write text for a small 8-page A7 booklet by filling a template's text slots.
Respond with raw JSON only, matching exactly:
{"title": string (<=120 chars), "overrides": [{"templateElementId": string, "text": string}]}
Rules:
- Only use templateElementId values from the provided list.
- Provide one override per slot you want to fill; keep each text concise and print-friendly.
- Do NOT invent ids. Do NOT emit any layout, geometry, or styling.`;

  const user = `Book concept: "${concept}"\n\nTemplate text slots:\n${slotLines}\n\nWrite the booklet content now.`;

  let lastError = "The AI returned an invalid content plan.";
  for (let attempt = 0; attempt <= CONTENT_MAX_ATTEMPTS; attempt++) {
    const prompt = attempt === 0 ? user : `${user}\n\nYour previous answer was rejected: ${lastError}. Fix it and return valid JSON only.`;
    const raw = await chatJson(system, prompt);
    const plan = parseContentPlan(raw);
    if (!plan) {
      lastError = "Response was not valid JSON matching the required schema.";
      continue;
    }
    const templateSlots: TemplateTextSlot[] = slots.map(({ id, pageLabel }) => ({ id, pageLabel }));
    const validation = validatePlanAgainstTemplate(plan, templateSlots);
    if (!validation.ok) {
      lastError = validation.error;
      continue;
    }
    if (plan.overrides.length === 0) {
      lastError = "The plan contained no text overrides.";
      continue;
    }
    return plan;
  }
  throw new RetryableError(lastError);
}

async function runConceptStage(job: ClaimedAiBookJob, state: PipelineState): Promise<void> {
  state.templateId = await resolveTemplate(job.concept, job.templateId ?? null);
  state.slots = await loadTextSlots(state.templateId);
  await mustAdvance(job, AiBookStage.CONTENT, { templateId: state.templateId });
}

async function runContentStage(job: ClaimedAiBookJob, state: PipelineState): Promise<void> {
  if (!state.templateId) throw new TerminalError("Missing template selection.");
  if (!state.slots) state.slots = await loadTextSlots(state.templateId);
  state.contentPlan = await generateContent(job.concept, state.slots);
  await mustAdvance(job, AiBookStage.COMPOSE, { contentPlan: state.contentPlan });
}

async function runComposeStage(job: ClaimedAiBookJob, state: PipelineState): Promise<void> {
  if (!state.templateId || !state.contentPlan) {
    throw new TerminalError("Missing template or content plan.");
  }
  if (!state.slots) state.slots = await loadTextSlots(state.templateId);
  if (state.slots.length === 0) {
    throw new TerminalError("The selected template has no editable text.");
  }
  const templateSlots: TemplateTextSlot[] = state.slots.map(({ id, pageLabel }) => ({ id, pageLabel }));
  const overrides: OverridesByPage = buildOverridesByPage(state.contentPlan, templateSlots);
  const actor: Actor = { id: job.userId, role: "USER" };

  if (state.submissionId) {
    await rewriteInstanceOverrides(state.submissionId, overrides);
  } else {
    state.submissionId = await createInstanceWithOverrides(
      actor,
      state.templateId,
      state.contentPlan.title,
      overrides,
    );
  }
  await mustAdvance(job, AiBookStage.RENDER, { contentPlan: state.contentPlan }, { submissionId: state.submissionId });
}

/** advanceStage that aborts the pipeline when the lease was lost. */
async function mustAdvance(
  job: ClaimedAiBookJob,
  stage: AiBookStage,
  outputPatch: Record<string, unknown> = {},
  data: { submissionId?: string; renderJobId?: string } = {},
): Promise<void> {
  if (!(await advanceStage(job, stage, outputPatch, data))) throw new LeaseLostError();
}

async function runRenderStage(job: ClaimedAiBookJob, state: PipelineState, lostLease: () => boolean): Promise<void> {
  if (!state.submissionId) throw new TerminalError("Missing submission to render.");
  const actor: Actor = { id: job.userId, role: "USER" };

  const submission = await prisma.submission.findUnique({ where: { id: state.submissionId } });
  // Resume guard: already rendered and awaiting review -> skip straight to QA.
  if (submission?.pdfS3Key && (submission.status === "PENDING" || submission.status === "APPROVED")) {
    await mustAdvance(job, AiBookStage.QA, {});
    return;
  }

  let renderJobId: string;
  try {
    const result = await enqueueRenderJob(state.submissionId, actor, { force: false });
    renderJobId = result.jobId;
  } catch (err) {
    // Low-resolution template assets: re-enqueue once with force and record it.
    if (err && typeof err === "object" && "details" in err && (err as { details?: { canForce?: boolean } }).details?.canForce) {
      const result = await enqueueRenderJob(state.submissionId, actor, { force: true });
      renderJobId = result.jobId;
      await mustAdvance(job, AiBookStage.RENDER, { dpiForced: true });
    } else {
      throw err;
    }
  }
  state.renderJobId = renderJobId;
  await mustAdvance(job, AiBookStage.RENDER, { renderJobId }, { renderJobId });

  const deadline = Date.now() + RENDER_WAIT_CAP_MS;
  while (Date.now() < deadline) {
    if (lostLease()) return; // another worker will reclaim
    await sleep(RENDER_POLL_MS);
    const renderJob = await prisma.renderJob.findUnique({ where: { id: renderJobId } });
    if (!renderJob) throw new TerminalError("Render job disappeared.");
    if (renderJob.status === "COMPLETED") {
      await mustAdvance(job, AiBookStage.QA, {});
      return;
    }
    if (renderJob.status === "FAILED") {
      throw new TerminalError("Rendering failed and could not be retried.");
    }
  }
  throw new RetryableError("Rendering timed out.");
}

async function runQaStage(job: ClaimedAiBookJob, state: PipelineState): Promise<void> {
  if (!state.submissionId) throw new TerminalError("Missing submission for QA.");
  const report: QaReport = await runQaChecklist(state.submissionId, { concept: job.concept });

  if (report.passed) {
    const sampled = Math.random() < QA_SAMPLE_RATE;
    // Approve inside the lease-fenced completion transaction so a stale
    // worker whose lease expired cannot approve the submission.
    const completed = await completeAiBook(
      job,
      { qaReport: report, qaSampled: sampled },
      async (tx) => {
        await tx.submission.update({
          where: { id: state.submissionId! },
          data: { status: "APPROVED", qaSampled: sampled },
        });
      },
    );
    if (!completed) throw new LeaseLostError();
    return;
  }

  // QA failed: persist report, then retry from CONTENT (fresh text) if retryable.
  if (isRetryable(report)) {
    await mustAdvance(job, AiBookStage.CONTENT, { qaReport: report });
    throw new RetryableError("Automated QA rejected the content; regenerating.");
  }
  await mustAdvance(job, AiBookStage.QA, { qaReport: report });
  throw new TerminalError("Automated QA rejected this book. It has been left for manual review.");
}

interface PipelineState {
  templateId: string | null;
  slots: TextSlotInfo[] | null;
  contentPlan: ContentPlan | null;
  submissionId: string | null;
  renderJobId: string | null;
}

/**
 * Execute the autonomous pipeline for a claimed job: CONCEPT -> CONTENT ->
 * COMPOSE -> RENDER -> QA. Resumes from the persisted stage on retry. A
 * heartbeat keeps the lease alive; if it is lost we stop and let another
 * worker reclaim the job.
 */
export async function processAiBookJob(job: ClaimedAiBookJob): Promise<void> {
  let lostLease = false;
  let currentStage: string = job.stage;
  const timer = setInterval(() => {
    void heartbeatAiBookJob(job).then((ok) => {
      if (!ok) lostLease = true;
    }).catch(() => {
      lostLease = true;
    });
  }, HEARTBEAT_MS);

  try {
    if (job.exhausted) {
      await failAiBook(job, true, "This AI book could not be completed after several attempts.");
      return;
    }

    const output = (job.stageOutput ?? {}) as Record<string, unknown>;
    const state: PipelineState = {
      templateId: (output.templateId as string) ?? job.templateId ?? null,
      slots: null,
      contentPlan: (output.contentPlan as ContentPlan) ?? null,
      submissionId: job.submissionId ?? (output.submissionId as string) ?? null,
      renderJobId: job.renderJobId ?? (output.renderJobId as string) ?? null,
    };

    let idx = STAGE_ORDER.indexOf(job.stage as AiBookStage);
    if (idx < 0) idx = 0;

    for (; idx < STAGE_ORDER.length; idx++) {
      if (lostLease) return;
      const stage = STAGE_ORDER[idx];
      currentStage = stage;
      if (stage === AiBookStage.CONCEPT) await runConceptStage(job, state);
      else if (stage === AiBookStage.CONTENT) await runContentStage(job, state);
      else if (stage === AiBookStage.COMPOSE) await runComposeStage(job, state);
      else if (stage === AiBookStage.RENDER) await runRenderStage(job, state, () => lostLease);
      else if (stage === AiBookStage.QA) await runQaStage(job, state);
      console.info(JSON.stringify({ event: "ai-book-stage-finished", jobId: job.id, stage }));
    }
  } catch (error) {
    if (error instanceof LeaseLostError) {
      // Another worker owns the job now; stop quietly without touching state.
      console.warn(JSON.stringify({ event: "ai-book-lease-lost", jobId: job.id, stage: currentStage }));
      return;
    }
    const terminal = error instanceof TerminalError || error instanceof AiBookTerminalError;
    const message = error instanceof Error ? error.message : undefined;
    console.error(JSON.stringify({ event: "ai-book-failed", jobId: job.id, attempt: job.attempts, terminal }));
    if (!lostLease) await failAiBook(job, terminal, message);
  } finally {
    clearInterval(timer);
  }
}
