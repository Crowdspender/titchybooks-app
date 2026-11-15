import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  db,
  createUser,
  createAiReadyTemplate,
  cleanupFixtures,
} from '../fixtures/database';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { SEED_RECIPES, elementSeeds, type SeedTextElement } from '../../prisma/seed-recipes';

// The fake LLM fills every generated slot of the starter recipe, because the
// pipeline refuses a plan that skips a required slot. Tests override individual
// slots (`ai.texts`) to drive QA outcomes.
const ai = vi.hoisted(() => ({
  texts: {} as Record<string, string>,
  flagged: false,
  /** Count of content-plan calls the stub provider has served. */
  calls: 0,
  /**
   * When set, interior body slots return the short stub on the first plan call
   * and the full-length body afterwards, so the paginator reports flow-underfull
   * once and the repair expands the manuscript to fill the book.
   */
  shortFirst: false,
  recipeIndex: 0,
  palette: 'mist',
  prompts: [] as string[],
}));

const RECIPE = SEED_RECIPES[0];
const GENERATED_SLOTS = RECIPE.elements.filter(
  (element): element is SeedTextElement => element.kind === 'text' && !element.locked,
);
const BODY_SLOT_IDS = GENERATED_SLOTS.filter((element) => element.id.endsWith('-body')).map((element) => element.id);
// A full page of prose. Six of these pack the interior manuscript to roughly the
// middle of the measured character window, so pages 2-6 fill completely and
// PAGE_7 carries a real closing page without overflowing.
const BODY_TEXT =
  'The lantern glows beside the window while the rain taps softly on the glass. ' +
  'Beyond the dunes the sea keeps its long, patient breathing, and the little house ' +
  'holds its warmth against the dark. A child counts the falling drops and wonders ' +
  'where the light goes when morning comes, but the wick answers nothing at all. It ' +
  'only burns on, steadily and without hurry, which is enough to read by and enough ' +
  'to dream by, until the pages blur and sleep leans in to carry the story onward.';
// Above the body minimum but far short of a filled book: drives flow-underfull.
const SHORT_BODY = 'Rain taps softly on the window while the lantern glows beside the bed.';
const ROLE_TEXT: Record<string, string> = {
  'story-cover-title': 'A Rainy Day',
  'story-back-closing': 'Goodnight, little one. The lantern keeps its light until morning.',
  'guide-cover-title': 'A Rainy Day',
  'guide-back-closing': 'Goodnight, little one. The lantern keeps its light until morning.',
};

function slotText(id: string): string {
  if (ai.texts[id] !== undefined) return ai.texts[id];
  if (ROLE_TEXT[id] !== undefined) return ROLE_TEXT[id];
  if (id.endsWith('-heading')) return 'How the lantern keeps its light until morning';
  if (ai.shortFirst && ai.calls <= 1 && id.endsWith('-body')) return SHORT_BODY;
  return BODY_TEXT;
}

function fakePlan() {
  return {
    version: 2,
    brief: { purpose: 'A finished story', audience: 'Families', tone: 'Warm', progression: 'From rain to morning' },
    outline: [{ pageLabel: 'FRONT_COVER', purpose: 'Introduce the story' }],
    palette: ai.palette,
    title: 'A Rainy Day',
    overrides: SEED_RECIPES[ai.recipeIndex].elements.filter((element): element is SeedTextElement => element.kind === 'text' && !element.locked).map((element) => ({
      templateElementId: element.id,
      text: slotText(element.id),
    })),
  };
}

// Make the RENDER poll loop instant: the pipeline awaits sleep(RENDER_POLL_MS)
// between status checks, and the mocked render job is already COMPLETED.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));

vi.mock('@/lib/ai/client', () => ({
  isAIConfigured: () => true,
  getOpenAIModel: () => 'test-model',
  getOpenAIClient: () => ({
    chat: {
      completions: {
        create: async (request: { messages: Array<{ content: string }> }) => {
          ai.prompts.push(request.messages.map((message) => message.content).join('\n'));
          ai.calls += 1;
          return { choices: [{ message: { content: JSON.stringify(fakePlan()) } }] };
        },
      },
    },
    moderations: { create: async () => ({ results: [{ flagged: ai.flagged }] }) },
  }),
}));

// In-memory object store standing in for S3. The bytes are real: the actual
// renderer writes the PDFs and QA reads them back to verify checksums.
const storage = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));

vi.mock('@/lib/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/s3')>();
  return {
    ...actual,
    objectExists: async (s3Key: string) => storage.objects.has(s3Key),
    downloadFromS3: async (s3Key: string) => {
      const bytes = storage.objects.get(s3Key);
      if (!bytes) throw new Error(`No object at ${s3Key}`);
      return bytes;
    },
    uploadToS3: async (s3Key: string, bytes: Buffer) => {
      storage.objects.set(s3Key, Buffer.from(bytes));
    },
    deleteS3Object: async (s3Key: string) => {
      storage.objects.delete(s3Key);
    },
    getPresignedDownloadUrl: async () => 'https://storage.example.invalid/test.pdf',
  };
});

// The render queue itself is real. Only the wait for a worker is removed: the
// enqueue is drained synchronously so QA receives genuine, freshly rendered
// artifacts instead of stubbed keys.
vi.mock('@/lib/pdf/render-job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf/render-job')>();
  return {
    ...actual,
    enqueueRenderJob: async (submissionId: string) => {
      const { db } = await import('../fixtures/database');
      const submission = await db.submission.findUniqueOrThrow({
        where: { id: submissionId },
        include: { user: true },
      });
      const result = await actual.enqueueRenderJob(submissionId, submission.user);
      const job = await actual.claimRenderJob();
      if (job) await actual.processRenderJob(job);
      return result;
    },
  };
});

import {
  enqueueAiBookJob,
  claimAiBookJob,
  advanceStage,
  completeAiBook,
  AiBookStage,
  AiBookTerminalError,
} from '@/lib/ai/ai-book-job';
import { processAiBookJob } from '@/lib/ai/pipeline';
import { parseArtifactManifest } from '@/lib/pdf/artifacts';
import { buildManifestFromRows, parsePinnedTemplate } from '@/lib/ai/template-contract';
import { isPrintSafeColor, printSafetyIssues } from '@/lib/ai/print-palette';
import type { ContentPlan } from '@/lib/ai/content-plan';
import { interiorFlowPages } from '@/lib/ai/flow';
import { measureTextBlock, type TextStyle } from '@/lib/pdf/text-layout';
import type { PageLabel } from '@/lib/constants';

interface QaCheckOut { id: string; passed: boolean; detail: string; severity: string }
interface FlowIssueOut { code: string; message: string; slotId: string | null; pageLabel: string | null }
interface StageOutput {
  templateId?: string;
  contentPlan?: ContentPlan;
  manuscriptPlan?: ContentPlan;
  pinnedTemplate?: unknown;
  flowIssues?: FlowIssueOut[];
  qaReport?: { passed: boolean; checks: QaCheckOut[] };
  qaSampled?: boolean;
}

let user: { id: string; role: string };
let templateId: string;

beforeEach(async () => {
  ai.texts = {};
  ai.flagged = false;
  ai.calls = 0;
  ai.shortFirst = false;
  ai.recipeIndex = 0;
  ai.palette = 'mist';
  ai.prompts = [];
  storage.objects.clear();
  const created = await createUser();
  user = { id: created.id, role: created.role };
  const template = await createAiReadyTemplate(user.id);
  templateId = template.id;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External HTTP is forbidden in integration tests'); }));
});
afterEach(async () => { await cleanupFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await prisma.$disconnect(); await db.$disconnect(); });

/** Force a queued job to become claimable immediately (bypass the retry delay). */
async function makeDue(id: string) {
  await db.aiBookJob.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
}

// The interior flow geometry, rebuilt from the same recipe the fixture template
// was created from, so a composed page can be measured exactly as QA measures it.
const FLOW_PAGES = interiorFlowPages(
  buildManifestFromRows({
    templateId: 'recipe',
    templateVersion: 1,
    rows: elementSeeds(RECIPE).map((row) => ({ pageLabel: row.pageLabel, elementJson: row.elementJson })),
  }).manifest,
);

/** Read the composed override text for one slot on one page of a submission. */
async function composedOverride(submissionId: string, pageLabel: PageLabel, slotId: string): Promise<string> {
  const page = await db.submissionPage.findUniqueOrThrow({
    where: { submissionId_pageLabel: { submissionId, pageLabel } },
  });
  const scene = JSON.parse(page.sceneJson) as { templateTextOverrides?: Record<string, string> };
  return scene.templateTextOverrides?.[slotId] ?? '';
}

describe('autonomous AI book pipeline', () => {
  it('runs CONCEPT -> CONTENT -> COMPOSE -> RENDER -> QA and auto-approves', async () => {
    const { jobId } = await enqueueAiBookJob(user.id, 'a story about a rainy day', templateId);
    const job = await claimAiBookJob();
    expect(job).not.toBeNull();
    expect(job!.attempts).toBe(1);

    await processAiBookJob(job!);

    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.stage).toBe('QA');
    expect(stored.submissionId).toBeTruthy();
    expect(stored.errorMessage).toBeNull();

    // Stage progression persisted into stageOutput for auditability.
    const output = stored.stageOutput as unknown as StageOutput;
    expect(output.templateId).toBe(templateId);
    expect(output.contentPlan).toMatchObject({ title: 'A Rainy Day' });
    expect(output.qaReport?.passed).toBe(true);
    expect(output.qaSampled).toBeTypeOf('boolean');

    const submission = await db.submission.findUniqueOrThrow({ where: { id: stored.submissionId! } });
    expect(submission.aiGenerated).toBe(true);
    expect(submission.templateId).toBe(templateId);
    expect(submission.status).toBe('APPROVED');
    // Both deliverables were really rendered and published, and the manifest
    // QA verified describes exactly the bytes now stored on the submission.
    expect(submission.pdfS3Key).toMatch(/print-sheet-a4-fold\.pdf$/);
    expect(submission.readingPdfS3Key).toMatch(/reading-74x105mm\.pdf$/);
    expect(storage.objects.has(submission.pdfS3Key!)).toBe(true);
    expect(storage.objects.has(submission.readingPdfS3Key!)).toBe(true);
    expect(parseArtifactManifest(submission.artifactManifest)).not.toBeNull();

    // The render queue was reused: exactly one COMPLETED render job exists.
    expect(await db.renderJob.count({ where: { submissionId: submission.id, status: 'COMPLETED' } })).toBe(1);

    // The generated text landed as a templateTextOverride on the cover page.
    const cover = await db.submissionPage.findUniqueOrThrow({
      where: { submissionId_pageLabel: { submissionId: submission.id, pageLabel: 'FRONT_COVER' } },
    });
    const scene = JSON.parse(cover.sceneJson) as { templateTextOverrides?: Record<string, string> };
    expect(scene.templateTextOverrides).toMatchObject({ 'story-cover-title': 'A Rainy Day' });
    const pin = parsePinnedTemplate(submission.pinnedTemplate)!;
    expect(printSafetyIssues(pin)).toEqual([]);
    expect(output.pinnedTemplate).toEqual(submission.pinnedTemplate);
    expect(output.contentPlan?.palette).toBe('mist');
    expect(output.manuscriptPlan?.overrides.find((entry) => entry.templateElementId === BODY_SLOT_IDS[0])?.text).toBe(BODY_TEXT);
  });

  it('composes a print-safe guide from a navy template without changing its source', async () => {
    ai.recipeIndex = 1;
    ai.palette = 'sage';
    const template = await createAiReadyTemplate(user.id, SEED_RECIPES[1]);
    const sourceBefore = await db.submissionPage.findMany({ where: { submissionId: template.id }, orderBy: { order: 'asc' } });
    const sourceElements = await db.templateElement.findMany({ where: { templateId: template.id }, orderBy: { order: 'asc' } });
    const { jobId } = await enqueueAiBookJob(user.id, 'a guide to lanterns', template.id);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('COMPLETED');
    const book = await db.submission.findUniqueOrThrow({ where: { id: stored.submissionId! } });
    const pin = parsePinnedTemplate(book.pinnedTemplate)!;
    expect(printSafetyIssues(pin)).toEqual([]);
    expect(pin.pages.find((page) => page.pageLabel === 'FRONT_COVER')?.backgroundColor).toBe('#eef5ee');
    const pages = await db.submissionPage.findMany({ where: { submissionId: book.id } });
    for (const page of pages) {
      const background = (JSON.parse(page.sceneJson) as { page: { backgroundColor: string } }).page.backgroundColor;
      expect(isPrintSafeColor(background)).toBe(true);
      expect(background).toBe(pin.pages.find((entry) => entry.pageLabel === page.pageLabel)?.backgroundColor);
    }
    expect(await db.submissionPage.findMany({ where: { submissionId: template.id }, orderBy: { order: 'asc' } })).toEqual(sourceBefore);
    expect(await db.templateElement.findMany({ where: { templateId: template.id }, orderBy: { order: 'asc' } })).toEqual(sourceElements);
  });

  it('honors the QA sampling rate when flagging for admin spot-check', async () => {
    vi.stubEnv('AI_QA_SAMPLE_RATE', '1');
    // The sampling rate is read at module load, so only assert the flag exists
    // and is a boolean here; deterministic rate coverage lives in the unit test.
    const { jobId } = await enqueueAiBookJob(user.id, 'a sampled book', templateId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('COMPLETED');
    const submission = await db.submission.findUniqueOrThrow({ where: { id: stored.submissionId! } });
    expect(submission.qaSampled).toBeTypeOf('boolean');
  });

  it('regenerates CONTENT on a retryable QA failure and reuses the same submission', async () => {
    // Wide uppercase text in the back-cover closing slot (which pagination does
    // not repack): it still fits the character budget but overflows the box when
    // measured, so it survives plan validation and fails QA `text-fits`.
    ai.texts['story-back-closing'] = 'MMMM '.repeat(104);
    const { jobId } = await enqueueAiBookJob(user.id, 'a very long book', templateId);

    await processAiBookJob((await claimAiBookJob())!);

    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('QUEUED'); // retryable, attempts remain
    expect(stored.stage).toBe('CONTENT'); // rewound to regenerate text
    expect(stored.submissionId).toBeTruthy();

    const submission = await db.submission.findUniqueOrThrow({ where: { id: stored.submissionId! } });
    expect(submission.aiGenerated).toBe(true);
    expect(submission.status).toBe('PENDING'); // left for moderation, not auto-approved
    const output = stored.stageOutput as unknown as StageOutput;
    expect(output.qaReport?.passed).toBe(false);
    expect(output.qaReport?.checks.some((c) => c.id === 'text-fits' && !c.passed)).toBe(true);
  });

  it('repairs QA text from the original manuscript without repagination drift or palette changes', async () => {
    ai.texts['story-back-closing'] = 'MMMM '.repeat(104);
    const { jobId } = await enqueueAiBookJob(user.id, 'a story with a repaired closing', templateId);
    await processAiBookJob((await claimAiBookJob())!);
    const queued = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(queued.stage).toBe('CONTENT');
    const before = await db.submission.findUniqueOrThrow({ where: { id: queued.submissionId! } });
    const bodiesBefore = await Promise.all(FLOW_PAGES.map((page) => composedOverride(before.id, page.pageLabel, page.flow.id)));
    ai.texts['story-back-closing'] = ROLE_TEXT['story-back-closing'];
    ai.palette = 'peach'; // Repair responses cannot change the accepted palette.
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.submissionId).toBe(before.id);
    const after = await db.submission.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.pinnedTemplate).toEqual(before.pinnedTemplate);
    expect((stored.stageOutput as unknown as StageOutput).contentPlan?.palette).toBe('mist');
    expect(await Promise.all(FLOW_PAGES.map((page) => composedOverride(before.id, page.pageLabel, page.flow.id)))).toEqual(bodiesBefore);
    expect(ai.prompts.at(-1)).toContain(BODY_TEXT);
  });

  it('exhausts retries on persistent QA failure and leaves the submission PENDING', async () => {
    ai.texts['story-back-closing'] = 'MMMM '.repeat(104);
    const { jobId } = await enqueueAiBookJob(user.id, 'a very long book', templateId);

    let submissionId: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await makeDue(jobId);
      await processAiBookJob((await claimAiBookJob())!);
      const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
      submissionId = stored.submissionId;
      if (attempt < 3) expect(stored.status).toBe('QUEUED');
      else expect(stored.status).toBe('FAILED');
    }

    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('FAILED');
    expect(stored.errorMessage).toBeTruthy();

    // The retried pipeline reuses one submission and leaves it for manual review.
    expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(1);
    const submission = await db.submission.findUniqueOrThrow({ where: { id: submissionId! } });
    expect(submission.status).toBe('PENDING');
    expect(submission.aiGenerated).toBe(true);
  });

  it('expands an underfull manuscript through one flow repair and fills pages 2-6', async () => {
    // The first plan is far too short to fill the interior, so the paginator
    // reports flow-underfull and spends one repair cycle. The stub provider then
    // returns full-length prose, which packs every interior page.
    ai.shortFirst = true;
    const { jobId } = await enqueueAiBookJob(user.id, 'a story that grows', templateId);

    await processAiBookJob((await claimAiBookJob())!);
    const queued = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(queued.status).toBe('QUEUED');
    expect(queued.stage).toBe('CONTENT');
    const queuedOutput = queued.stageOutput as unknown as StageOutput;
    expect(queuedOutput.flowIssues?.some((issue) => issue.code === 'flow-underfull')).toBe(true);
    expect(queuedOutput.contentPlan?.overrides.filter((entry) => BODY_SLOT_IDS.includes(entry.templateElementId)).map((entry) => entry.text)).toEqual(BODY_SLOT_IDS.map(() => SHORT_BODY));
    expect(queuedOutput.manuscriptPlan).toEqual(queuedOutput.contentPlan);

    // The repair expands the manuscript and the book then completes end-to-end.
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.errorMessage).toBeNull();

    // Every interior page before the last fills to within one line of its box:
    // text is packed to the last line that fits, never left half empty.
    const submissionId = stored.submissionId!;
    for (const page of FLOW_PAGES.slice(0, -1)) {
      const text = await composedOverride(submissionId, page.pageLabel, page.flow.id);
      const style: TextStyle = page.flow.style;
      const height = measureTextBlock(text, page.flow.box.width, style).height;
      const oneLine = style.fontSize * style.lineHeight;
      expect(height).toBeLessThanOrEqual(page.flow.box.height + 0.01);
      expect(page.flow.box.height - height).toBeLessThan(oneLine);
    }
  });

  it('fails terminally when an overlong manuscript cannot condense to fit the pages', async () => {
    // Every interior body slot is far longer than the book can hold. Pagination
    // fills all six pages and still has text left over (flow-overflow). The stub
    // provider cannot condense it, so the repair budget exhausts and the job
    // fails rather than composing a silently truncated book.
    const overlong = (
      'The lantern glows beside the window while the rain taps softly on the glass and ' +
      'the sea keeps its long patient breathing beyond the dunes all through the night. '
    ).repeat(5).trim();
    for (const id of BODY_SLOT_IDS) ai.texts[id] = overlong;
    const { jobId } = await enqueueAiBookJob(user.id, 'an overlong book', templateId);

    let stored;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await makeDue(jobId);
      await processAiBookJob((await claimAiBookJob())!);
      stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    }

    expect(stored!.status).toBe('FAILED');
    expect(stored!.errorMessage).toContain('could not be fit');
    // The overflow was reported, never truncated into a composed book.
    const flowOutput = stored!.stageOutput as unknown as StageOutput;
    expect(flowOutput.flowIssues?.some((issue) => issue.code === 'flow-overflow')).toBe(true);
    expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);
  });

  it('fails terminally when no approved template with editable text exists', async () => {
    // Remove the seeded template's only text slot so CONCEPT cannot resolve it.
    await db.templateElement.deleteMany({ where: { templateId } });
    const { jobId } = await enqueueAiBookJob(user.id, 'an orphan concept');

    await processAiBookJob((await claimAiBookJob())!);

    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('FAILED');
    expect(stored.errorMessage).toBeTruthy();
    expect(stored.submissionId).toBeNull();
  });

  it('fails terminally when moderation flags the content', async () => {
    ai.flagged = true;
    const { jobId } = await enqueueAiBookJob(user.id, 'a flagged concept', templateId);

    await processAiBookJob((await claimAiBookJob())!);

    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    // content-policy is a terminal check: the job fails and is not auto-approved.
    expect(stored.status).toBe('FAILED');
    const submission = await db.submission.findUniqueOrThrow({ where: { id: stored.submissionId! } });
    expect(submission.status).toBe('PENDING');
  });

  it('rejects enqueueing beyond the active-job limit', async () => {
    await enqueueAiBookJob(user.id, 'book one', templateId);
    await enqueueAiBookJob(user.id, 'book two', templateId);
    await expect(enqueueAiBookJob(user.id, 'book three', templateId)).rejects.toMatchObject({ status: 429 });
  });

  it('fences a stale worker out of advancing and approving while the new owner completes', async () => {
    const { jobId } = await enqueueAiBookJob(user.id, 'a story about a rainy day', templateId);
    const stale = (await claimAiBookJob())!; // token T1, attempts 1

    // The lease expires and a second worker reclaims the same job row.
    await db.aiBookJob.update({ where: { id: jobId }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const current = (await claimAiBookJob())!; // token T2, attempts 2
    expect(current.claimToken).not.toBe(stale.claimToken);

    // The stale worker's fenced writes are rejected, and its approval callback
    // (which runs only inside the lease-fenced transaction) is never invoked.
    const approve = vi.fn(async () => { throw new Error('a stale worker must not approve'); });
    expect(await advanceStage(stale, AiBookStage.CONTENT, {})).toBe(false);
    expect(await completeAiBook(stale, {}, approve)).toBe(false);
    expect(approve).not.toHaveBeenCalled();

    // Running the whole pipeline on the stale claim is fenced out at the first
    // stage: it creates no submission and leaves the job owned by `current`.
    await processAiBookJob(stale);
    const afterStale = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(afterStale.status).toBe('PROCESSING');
    expect(afterStale.claimToken).toBe(current.claimToken);
    expect(afterStale.submissionId).toBeNull();
    expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);

    // The rightful owner still completes end-to-end and auto-approves.
    await processAiBookJob(current);
    const done = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(done.status).toBe('COMPLETED');
    const submission = await db.submission.findUniqueOrThrow({ where: { id: done.submissionId! } });
    expect(submission.status).toBe('APPROVED');
  });

  it('maps a missing submission (P2025) during completion to a terminal error, not a retry', async () => {
    const { jobId } = await enqueueAiBookJob(user.id, 'a story about a rainy day', templateId);
    const job = (await claimAiBookJob())!;

    // Stand in for the QA approval callback targeting a submission that no
    // longer exists: Prisma raises P2025 inside the fenced transaction.
    const approveMissing = async (tx: Prisma.TransactionClient) => {
      await tx.submission.update({ where: { id: 'nonexistent-submission-id' }, data: { status: 'APPROVED' } });
    };

    const error = await completeAiBook(job, {}, approveMissing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiBookTerminalError);
    expect((error as Error).message).toBe('The book draft no longer exists.');

    // The transaction rolled back, so the job was not marked complete and can
    // be failed terminally by the pipeline instead of exhausting retries.
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('PROCESSING');
    expect(stored.completedAt).toBeNull();
  });

  it('fails terminally when a job resumed at COMPOSE finds no editable text slots', async () => {
    const { jobId } = await enqueueAiBookJob(user.id, 'a story about a rainy day', templateId);
    const claimed = (await claimAiBookJob())!;

    // The template loses its text slots between attempts (e.g. an admin edited
    // or unpublished it), and the job resumes directly at COMPOSE.
    await db.templateElement.deleteMany({ where: { templateId } });
    const stageOutput = {
      templateId,
      contentPlan: { title: 'A Rainy Day', overrides: [{ templateElementId: 'story-cover-title', text: 'Rain falls.' }] },
    };
    await db.aiBookJob.update({ where: { id: jobId }, data: { stage: 'COMPOSE', stageOutput } });
    const job = { ...claimed, stage: 'COMPOSE', stageOutput } as typeof claimed;

    await processAiBookJob(job);

    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('FAILED');
    expect(stored.errorMessage).toContain('no editable text');
    // No blank book is composed or auto-approved.
    expect(stored.submissionId).toBeNull();
    expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);
  });
});
