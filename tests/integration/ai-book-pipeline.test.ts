import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  db,
  createUser,
  createAiReadyTemplate,
  cleanupFixtures,
} from '../fixtures/database';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { SEED_RECIPES, elementSeeds, type SeedTextElement } from '../../prisma/seed-recipes';
import { FULL_INTERIOR_TEXT, NATURAL_GUIDE_SECTIONS, imageElement } from '../fixtures/scenes';
import { editorElementSchema } from '@/lib/editor/schema';
import { parseRenderSnapshot } from '@/lib/pdf/snapshot';

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
  responses: [] as string[],
}));

const RECIPE = SEED_RECIPES[0];
const GENERATED_SLOTS = RECIPE.elements.filter(
  (element): element is SeedTextElement => element.kind === 'text' && !element.locked,
);
const BODY_SLOT_IDS = GENERATED_SLOTS.filter((element) => element.id.endsWith('-body')).map((element) => element.id);
// Historical pins retain 620px frames and a shorter, substantive final page.
const LEGACY_BODY_TEXT =
  'The lantern glows beside the window while the rain taps softly on the glass. ' +
  'Beyond the dunes the sea keeps its long, patient breathing, and the little house ' +
  'holds its warmth against the dark. A child counts the falling drops and wonders ' +
  'where the light goes when morning comes, but the wick answers nothing at all. It ' +
  'only burns on, steadily and without hurry, which is enough to read by and enough ' +
  'to dream by, until the pages blur and sleep leans in to carry the story onward.';
const BODY_TEXT = FULL_INTERIOR_TEXT;
// Seventeen one-line paragraphs fill the expanded 730px guide frame.
// Explicit paragraph boundaries make the heading-break fixture exact.
const GUIDE_BODY_TEXT = Array.from({ length: 17 }, (_, index) => `Safety step ${index + 1}: keep the lantern steady.`).join('\n');
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
  if (id.startsWith('guide-') && id.endsWith('-body')) return GUIDE_BODY_TEXT;
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
          const plan = fakePlan();
          const userPrompt = request.messages[1].content;
          const isRepair = userPrompt.includes('slots to repair:');
          const targets = new Set([...userPrompt.matchAll(/^- id: "([^"]+)"/gm)].map((match) => match[1]));
          // Model the actual patch contract by default, without book metadata.
          const response = isRepair
            ? { overrides: plan.overrides.filter((entry) => targets.has(entry.templateElementId)) }
            : plan;
          return { choices: [{ message: { content: ai.responses.shift() ?? JSON.stringify(response) } }] };
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
  continueAiBook,
  failAiBook,
  AiBookStage,
  AiBookTerminalError,
} from '@/lib/ai/ai-book-job';
import { processAiBookJob } from '@/lib/ai/pipeline';
import { AUTONOMOUS_PROMPT_VERSION } from '@/lib/ai/book-prompts';
import { parseArtifactManifest } from '@/lib/pdf/artifacts';
import { buildManifestFromRows, buildPinnedTemplate, parsePinnedTemplate } from '@/lib/ai/template-contract';
import { isPrintSafeColor, printSafetyIssues } from '@/lib/ai/print-palette';
import type { ContentPlan } from '@/lib/ai/content-plan';
import { interiorFlowPages, prepareAiBookLayout, type FlowRepairTarget } from '@/lib/ai/flow';
import { measureTextBlock, type TextStyle } from '@/lib/pdf/text-layout';
import { PAGE_LABELS, type PageLabel } from '@/lib/constants';

interface QaCheckOut { id: string; passed: boolean; detail: string; severity: string }
interface FlowIssueOut { code: string; message: string; slotId: string | null; pageLabel: string | null }
interface StageOutput {
  templateId?: string;
  promptVersion?: string;
  flowMetrics?: Array<{ pageLabel: string; usedHeight: number; capacityHeight: number; bodyChars: number; filled: boolean }>;
  contentPlan?: ContentPlan;
  manuscriptPlan?: ContentPlan;
  pinnedTemplate?: unknown;
  flowIssues?: FlowIssueOut[];
  flowRepairTargets?: FlowRepairTarget[] | null;
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
  ai.responses = [];
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
function recipePin(recipe = RECIPE, id = 'recipe') {
  const rows = elementSeeds(recipe);
  const manifest = buildManifestFromRows({ templateId: id, templateVersion: 1, rows }).manifest;
  return buildPinnedTemplate({ templateId: id, templateVersion: 1, manifest, pages: PAGE_LABELS.map((pageLabel) => ({
    pageLabel,
    elements: rows.filter((row) => row.pageLabel === pageLabel).map((row) => editorElementSchema.parse(JSON.parse(row.elementJson))),
  })) });
}
const FLOW_PAGES = interiorFlowPages(prepareAiBookLayout(recipePin()).manifest);

/** Read the composed override text for one slot on one page of a submission. */
async function composedOverride(submissionId: string, pageLabel: PageLabel, slotId: string): Promise<string> {
  const page = await db.submissionPage.findUniqueOrThrow({
    where: { submissionId_pageLabel: { submissionId, pageLabel } },
  });
  const scene = JSON.parse(page.sceneJson) as { templateTextOverrides?: Record<string, string> };
  return scene.templateTextOverrides?.[slotId] ?? '';
}

describe('autonomous AI book pipeline', () => {
  it('fails terminally on the first attempt when a persisted pin references a removed image', async () => {
    // Simulate the race outcome the stage fence guards against: the pin was
    // captured while the image was active, then the source was removed before
    // the stage transaction persisted it. Retrying can never make it valid.
    const assetId = randomUUID();
    await db.asset.create({ data: { id: assetId, userId: user.id, s3Key: `assets/${user.id}/${assetId}.png`, originalFilename: 'fixture.png', mimeType: 'image/png', fileSize: 1, width: 1, height: 1, deletedAt: new Date() } });
    const pin = recipePin(RECIPE, templateId);
    pin.pages.find(page => page.pageLabel === 'FRONT_COVER')!.elements.push(imageElement(assetId));
    pin.manifest.pages.find(page => page.pageLabel === 'FRONT_COVER')!.images.push({ id: `image-${assetId}`, assetId, box: { x: 30, y: 40, width: 250, height: 90 } });
    const { jobId } = await enqueueAiBookJob(user.id, 'a story about a rainy day', templateId);
    await db.aiBookJob.update({ where: { id: jobId }, data: { stage: 'COMPOSE', stageOutput: {
      templateId, pinnedTemplate: pin, manifest: pin.manifest, contentPlan: fakePlan(), manuscriptPlan: fakePlan(),
    } as unknown as Prisma.InputJsonValue } });
    const job = await claimAiBookJob();
    expect(job).not.toBeNull();

    await processAiBookJob(job!);

    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('FAILED');
    expect(stored.failureCount).toBe(1);
    expect(stored.completedAt).toBeInstanceOf(Date);
    expect(stored.errorMessage).toContain('missing or removed');
    // The composition transaction rolled back: no draft was created.
    expect(await db.submission.count({ where: { userId: user.id, isTemplate: false } })).toBe(0);
  });

  it('runs CONCEPT -> CONTENT -> COMPOSE -> RENDER -> QA and auto-approves', async () => {
    const sourceBefore = await db.templateElement.findMany({ where: { templateId }, orderBy: { order: 'asc' } });
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
    expect(output.promptVersion).toBe(AUTONOMOUS_PROMPT_VERSION);
    expect(output.flowMetrics).toHaveLength(6);
    expect(output.flowMetrics!.every((page) => page.filled && page.usedHeight === 798 && page.capacityHeight === 830)).toBe(true);
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
    expect(pin.manifest.fillAllInteriorPages).toBe(true);
    const render = await db.renderJob.findFirstOrThrow({ where: { submissionId: submission.id } });
    const snapshot = parseRenderSnapshot(render.inputSnapshot);
    for (const page of interiorFlowPages(pin.manifest)) {
      expect(page.flow.box.y + page.flow.box.height).toBe(940);
      const element = snapshot.pages.find((entry) => entry.pageLabel === page.pageLabel)!.scene.elements.find((entry) => entry.id === page.flow.id)!;
      expect(element).toMatchObject({ type: 'text', y: 110, height: 830, text: BODY_TEXT });
      expect(await composedOverride(submission.id, page.pageLabel, page.flow.id)).toBe(BODY_TEXT);
    }
    expect(await db.templateElement.findMany({ where: { templateId }, orderBy: { order: 'asc' } })).toEqual(sourceBefore);
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

  it.each([true, false])('rejects heading-boundary gaps before composition (repair succeeds: %s)', async (repairSucceeds) => {
    ai.recipeIndex = 1;
    const template = await createAiReadyTemplate(user.id, SEED_RECIPES[1]);
    const flowPages = interiorFlowPages(prepareAiBookLayout(recipePin(SEED_RECIPES[1], template.id)).manifest);
    const shortBody = GUIDE_BODY_TEXT.split('\n').slice(0, 15).join('\n');
    const heading = 'Every Hunstead offers a different reason to stay';
    for (const page of flowPages) {
      expect(measureTextBlock(shortBody, page.flow.box.width, page.flow.style).height).toBe(630);
      expect(measureTextBlock(heading, page.flow.box.width, page.flow.style).lineCount).toBe(2);
      ai.texts[page.flow.id] = shortBody;
      ai.texts[page.heading!.id] = heading;
    }
    const { jobId } = await enqueueAiBookJob(user.id, 'a guide with section boundaries', template.id);
    await processAiBookJob((await claimAiBookJob())!);
    const queued = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(queued).toMatchObject({ status: 'QUEUED', stage: 'CONTENT', submissionId: null, repairCount: 1 });
    const output = queued.stageOutput as unknown as StageOutput;
    expect(output.flowIssues).toEqual([expect.objectContaining({ code: 'flow-underfull', pageLabel: 'PAGE_2' })]);
    expect(output.flowMetrics!.every((page) => !page.filled && page.usedHeight === 630 && page.capacityHeight === 730)).toBe(true);
    expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);
    const pinned = output.pinnedTemplate;

    if (repairSucceeds) for (const page of flowPages) ai.texts[page.flow.id] = GUIDE_BODY_TEXT;
    for (let attempt = 0; attempt < (repairSucceeds ? 1 : 2); attempt++) {
      await makeDue(jobId);
      await processAiBookJob((await claimAiBookJob())!);
    }
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(ai.prompts.at(-1)).toContain('2 unused body lines');
    expect(ai.prompts.at(-1)).toContain('BEFORE the reported gaps');
    if (repairSucceeds) {
      expect(stored).toMatchObject({ status: 'COMPLETED', repairCount: 1, failureCount: 0 });
      const repaired = stored.stageOutput as unknown as StageOutput;
      expect(repaired.flowIssues).toBeNull();
      expect(repaired.flowMetrics!.every((page) => page.filled && page.usedHeight === 714 && page.capacityHeight === 730)).toBe(true);
      for (const page of flowPages) {
        const text = await composedOverride(stored.submissionId!, page.pageLabel, page.flow.id);
        expect(text).toBe(GUIDE_BODY_TEXT);
        const height = measureTextBlock(text, page.flow.box.width, page.flow.style).height;
        expect(height + page.flow.style.fontSize * page.flow.style.lineHeight).toBeGreaterThan(page.flow.box.height);
        const repairedPage = parsePinnedTemplate(repaired.pinnedTemplate)!.manifest.pages.find((entry) => entry.pageLabel === page.pageLabel)!;
        const originalPage = parsePinnedTemplate(pinned)!.manifest.pages.find((entry) => entry.pageLabel === page.pageLabel)!;
        expect(repairedPage.slots.map((slot) => slot.box)).toEqual(originalPage.slots.map((slot) => slot.box));
      }
    } else {
      expect(stored).toMatchObject({ status: 'FAILED', submissionId: null });
      expect((stored.stageOutput as unknown as StageOutput).pinnedTemplate).toEqual(pinned);
      expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);
    }
  });

  it.each([true, false])('requires repair when only the ending is short (repair succeeds: %s)', async (repairSucceeds) => {
    ai.texts[BODY_SLOT_IDS.at(-1)!] = SHORT_BODY;
    const { jobId } = await enqueueAiBookJob(user.id, 'a story with a complete ending', templateId);
    await processAiBookJob((await claimAiBookJob())!);
    const queued = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(queued).toMatchObject({ status: 'QUEUED', stage: 'CONTENT', submissionId: null, repairCount: 1 });
    const output = queued.stageOutput as unknown as StageOutput;
    expect(output.flowMetrics!.slice(0, -1).every((page) => page.filled)).toBe(true);
    expect(output.flowMetrics!.at(-1)?.filled).toBe(false);
    expect(output.flowIssues).toEqual([expect.objectContaining({ code: 'flow-underfull', pageLabel: 'PAGE_7' })]);
    expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);
    if (repairSucceeds) ai.texts = {};
    for (let attempt = 0; attempt < (repairSucceeds ? 1 : 2); attempt++) {
      await makeDue(jobId);
      await processAiBookJob((await claimAiBookJob())!);
    }
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(ai.prompts.at(-1)).toContain('the final interior page must also fill to its last usable line');
    expect(ai.prompts.at(-1)).toContain('PAGE_7 has');
    if (repairSucceeds) {
      expect(stored).toMatchObject({ status: 'COMPLETED', repairCount: 1 });
      const completed = stored.stageOutput as unknown as StageOutput;
      expect(completed.flowMetrics!.every((page) => page.filled && page.capacityHeight === 830)).toBe(true);
      expect(await composedOverride(stored.submissionId!, 'PAGE_7', BODY_SLOT_IDS.at(-1)!)).toBe(BODY_TEXT);
      expect(parsePinnedTemplate(completed.pinnedTemplate)!.manifest.pages.map((page) => page.slots.map((slot) => slot.box)))
        .toEqual(parsePinnedTemplate(output.pinnedTemplate)!.manifest.pages.map((page) => page.slots.map((slot) => slot.box)));
    } else {
      expect(stored).toMatchObject({ status: 'FAILED', submissionId: null });
      expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);
    }
  });

  it.each(['overflow', 'heading-gap', 'ending', 'mixed'] as const)('repairs distinct natural prose with measured section guidance (%s)', async (failure) => {
    ai.recipeIndex = 1;
    const template = await createAiReadyTemplate(user.id, SEED_RECIPES[1]);
    const flowPages = interiorFlowPages(prepareAiBookLayout(recipePin(SEED_RECIPES[1], template.id)).manifest);
    const texts = [...NATURAL_GUIDE_SECTIONS];
    if (failure === 'overflow') for (let index = 0; index < texts.length; index++) texts[index] += ' A second bed needs careful observation too. Watch the rain and light there before buying more plants.';
    if (failure === 'heading-gap') texts[0] = texts[0].replace(' That sketch will help you choose sensible positions and remember what changed as the season passed.', '');
    if (failure === 'ending') texts[5] = texts[5].split('\n')[0];
    if (failure === 'mixed') {
      texts[0] += ' A second bed needs careful observation too. Watch the rain and light there before buying more plants.';
      texts[1] = texts[1].split('\n')[0];
    }
    const titles = ['Choose a garden site that suits your daily life', 'Healthy soil supports each new plant in the bed', 'Plant seeds suited to your local growing season', 'Water slowly and check the soil beneath plants', 'Observe every plant before treating a problem', 'Harvest carefully and plan for the next season'];
    for (const [index, page] of flowPages.entries()) {
      ai.texts[page.flow.id] = texts[index];
      ai.texts[page.heading!.id] = titles[index];
    }
    const { jobId } = await enqueueAiBookJob(user.id, 'a practical garden guide', template.id);
    await processAiBookJob((await claimAiBookJob())!);
    const queued = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(queued).toMatchObject({ status: 'QUEUED', stage: 'CONTENT', submissionId: null, repairCount: 1, failureCount: 0 });
    const rejected = queued.stageOutput as unknown as StageOutput;
    const targets = rejected.flowRepairTargets!;
    expect(targets).toHaveLength(6);
    if (failure === 'overflow') {
      expect(rejected.flowIssues!.some((issue) => issue.code === 'flow-overflow')).toBe(true);
      expect(targets.every((target) => target.action === 'condense')).toBe(true);
    } else if (failure === 'mixed') {
      expect(targets.map((target) => target.action)).toEqual(['condense', 'expand', 'keep', 'keep', 'keep', 'keep']);
      expect(rejected.flowIssues!.length).toBeGreaterThan(0);
    } else {
      const shortIndex = failure === 'ending' ? 5 : 0;
      expect(targets[shortIndex].action).toBe('expand');
      expect(targets.filter((_, index) => index !== shortIndex).every((target) => target.action === 'keep')).toBe(true);
      expect(rejected.flowIssues!.some((issue) => issue.code === 'flow-underfull')).toBe(true);
      if (failure === 'heading-gap') expect(rejected.flowIssues![0].message).toContain('must stay together');
    }
    for (const [index, page] of flowPages.entries()) ai.texts[page.flow.id] = NATURAL_GUIDE_SECTIONS[index];
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored).toMatchObject({ status: 'COMPLETED', failureCount: 0, repairCount: 1 });
    const completed = stored.stageOutput as unknown as StageOutput;
    expect(completed.flowRepairTargets).toBeNull();
    expect(completed.flowMetrics!.every((page) => page.filled && page.usedHeight === 714 && page.capacityHeight === 730)).toBe(true);
    expect(completed.manuscriptPlan).toMatchObject({ title: rejected.manuscriptPlan!.title, brief: rejected.manuscriptPlan!.brief, outline: rejected.manuscriptPlan!.outline, palette: 'mist' });
    const prompt = ai.prompts.at(-1)!;
    expect(prompt).toContain('Measured raw-section targets (take precedence');
    expect(prompt).toContain('Combined revised body estimate:');
    const requestedIds = new Set([...prompt.matchAll(/^- id: "([^"]+)"/gm)].map((match) => match[1]));
    expect(requestedIds).toEqual(new Set(targets.filter((target) => target.action !== 'keep').map((target) => target.slotId)));
    for (const target of targets.filter((target) => target.action !== 'keep')) expect(prompt).toContain(`${target.currentChars} characters, ${Math.round(target.currentHeight)}/730px measured; ${target.action.toUpperCase()}`);
    const keptChars = targets.filter((target) => target.action === 'keep').reduce((sum, target) => sum + target.currentChars, 0);
    expect(prompt).toContain(`Unchanged interior bodies: ${keptChars} characters preserved by the server`);
    const revisedMin = targets.reduce((sum, target) => sum + target.targetMinChars, 0);
    const revisedMax = targets.reduce((sum, target) => sum + target.targetMaxChars, 0);
    expect(prompt).toContain(`Combined revised body estimate: ${revisedMin}-${revisedMax}`);
    for (const [index, page] of flowPages.entries()) {
      expect(await composedOverride(stored.submissionId!, page.pageLabel, page.flow.id)).toBe(NATURAL_GUIDE_SECTIONS[index]);
      expect(await composedOverride(stored.submissionId!, page.pageLabel, page.heading!.id)).toBe(titles[index]);
    }
    expect(parsePinnedTemplate(completed.pinnedTemplate)!.manifest.pages.map((page) => page.slots)).toEqual(parsePinnedTemplate(rejected.pinnedTemplate)!.manifest.pages.map((page) => page.slots));
    expect(ai.calls).toBe(2);
  });

  it('saves the FINAL rejected manuscript and metrics when the repair budget exhausts', async () => {
    ai.shortFirst = true;
    const { jobId } = await enqueueAiBookJob(user.id, 'a repair that changes failure mode', templateId);
    await processAiBookJob((await claimAiBookJob())!);
    for (const id of BODY_SLOT_IDS) ai.texts[id] = SHORT_BODY;
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const previous = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(previous).toMatchObject({ status: 'QUEUED', repairCount: 2 });
    expect((previous.stageOutput as unknown as StageOutput).flowIssues!.some((issue) => issue.code === 'flow-underfull')).toBe(true);
    for (const id of BODY_SLOT_IDS) ai.texts[id] = BODY_TEXT.repeat(2);
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const failed = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(failed).toMatchObject({ status: 'FAILED', stage: 'CONTENT', repairCount: 2, failureCount: 1, submissionId: null, claimToken: null });
    const output = failed.stageOutput as unknown as StageOutput;
    expect(output.flowIssues!.some((issue) => issue.code === 'flow-overflow')).toBe(true);
    expect(output.flowMetrics!.every((page) => page.filled)).toBe(true);
    expect(output.flowRepairTargets!.every((target) => target.action === 'condense')).toBe(true);
    expect(output.promptVersion).toBe(AUTONOMOUS_PROMPT_VERSION);
    expect(output.manuscriptPlan!.overrides.filter((entry) => BODY_SLOT_IDS.includes(entry.templateElementId)).map((entry) => entry.text)).toEqual(BODY_SLOT_IDS.map(() => BODY_TEXT.repeat(2)));
    expect(output.pinnedTemplate).toEqual((previous.stageOutput as unknown as StageOutput).pinnedTemplate);
    expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);
  });

  it('resumes a historical pin without expanding its frames or requiring a full ending', async () => {
    for (const id of BODY_SLOT_IDS) ai.texts[id] = LEGACY_BODY_TEXT;
    const pin = recipePin(RECIPE, templateId);
    const { jobId } = await enqueueAiBookJob(user.id, 'a previously pinned book', templateId);
    const claimed = (await claimAiBookJob())!;
    const stageOutput = { pinnedTemplate: JSON.parse(JSON.stringify(pin)) };
    await db.aiBookJob.update({ where: { id: jobId }, data: { stage: 'CONTENT', stageOutput } });
    await processAiBookJob({ ...claimed, stage: 'CONTENT', stageOutput });
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('COMPLETED');
    const output = stored.stageOutput as unknown as StageOutput;
    expect(output.flowMetrics!.every((page) => page.capacityHeight === 620)).toBe(true);
    expect(output.flowMetrics!.at(-1)?.filled).toBe(false);
    const restored = parsePinnedTemplate(output.pinnedTemplate)!;
    expect(restored.manifest.fillAllInteriorPages).toBeUndefined();
    expect(restored.manifest.pages.map((page) => page.slots.map((slot) => slot.box)))
      .toEqual(pin.manifest.pages.map((page) => page.slots.map((slot) => slot.box)));
    expect(ai.prompts[0]).toContain('only the final page may end early');
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
    // Unsolicited legacy metadata cannot replace accepted book metadata.
    ai.responses = [JSON.stringify({
      version: 2, title: 'Unrequested title', palette: 'peach',
      brief: { purpose: 'Different purpose', audience: 'Different readers', tone: 'Cold', progression: 'A different plot' },
      outline: [{ pageLabel: 'BACK_COVER', purpose: 'Different ending' }],
      overrides: [{ templateElementId: 'story-back-closing', text: ROLE_TEXT['story-back-closing'] }],
    })];
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.submissionId).toBe(before.id);
    const after = await db.submission.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.pinnedTemplate).toEqual(before.pinnedTemplate);
    const repairedPlan = (stored.stageOutput as unknown as StageOutput).contentPlan!;
    const originalPlan = (queued.stageOutput as unknown as StageOutput).contentPlan!;
    expect(repairedPlan).toMatchObject({ version: originalPlan.version, title: originalPlan.title, brief: originalPlan.brief, outline: originalPlan.outline, palette: 'mist' });
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

  it('expands an underfull manuscript through one flow repair and fills pages 2-7', async () => {
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
    expect(queuedOutput.promptVersion).toBe(AUTONOMOUS_PROMPT_VERSION);
    expect(queuedOutput.flowMetrics?.some((page) => !page.filled)).toBe(true);
    expect(queued.submissionId).toBeNull();

    // The repair expands the manuscript and the book then completes end-to-end.
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.errorMessage).toBeNull();
    expect(ai.prompts.at(-1)).toContain('Book-level interior body target:');
    expect(ai.prompts.at(-1)).toContain('body estimate (not a limit)');
    expect(ai.prompts.at(-1)).toContain('The current manuscript has');
    expect(ai.prompts.at(-1)).toContain('Current content to revise');
    expect(ai.calls).toBe(2);
    expect(stored.failureCount).toBe(0);
    expect(stored.repairCount).toBe(1);
    const completedPlan = (stored.stageOutput as unknown as StageOutput).manuscriptPlan!;
    expect(completedPlan).toMatchObject({ version: 2, title: queuedOutput.contentPlan!.title, brief: queuedOutput.contentPlan!.brief, outline: queuedOutput.contentPlan!.outline, palette: queuedOutput.contentPlan!.palette });
    expect(completedPlan.overrides.filter((entry) => !FLOW_PAGES.some((page) => page.flow.id === entry.templateElementId || page.heading?.id === entry.templateElementId))).toEqual(queuedOutput.contentPlan!.overrides.filter((entry) => !FLOW_PAGES.some((page) => page.flow.id === entry.templateElementId || page.heading?.id === entry.templateElementId)));

    // Every interior page, including the ending, fills to its last usable line.
    const submissionId = stored.submissionId!;
    for (const page of FLOW_PAGES) {
      const text = await composedOverride(submissionId, page.pageLabel, page.flow.id);
      const style: TextStyle = page.flow.style;
      const height = measureTextBlock(text, page.flow.box.width, style).height;
      const oneLine = style.fontSize * style.lineHeight;
      expect(height).toBeLessThanOrEqual(page.flow.box.height + 0.01);
      expect(page.flow.box.height - height).toBeLessThan(oneLine);
    }
  });

  it('condenses an overflowing manuscript with an overrides-only repair', async () => {
    for (const id of BODY_SLOT_IDS) ai.texts[id] = BODY_TEXT.repeat(2);
    const { jobId } = await enqueueAiBookJob(user.id, 'a story that needs condensing', templateId);
    await processAiBookJob((await claimAiBookJob())!);
    const queued = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(queued.submissionId).toBeNull();
    expect((queued.stageOutput as unknown as StageOutput).flowIssues?.some((issue) => issue.code === 'flow-overflow')).toBe(true);
    ai.texts = {};
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored).toMatchObject({ status: 'COMPLETED', failureCount: 0, repairCount: 1 });
    expect(ai.calls).toBe(2);
    expect(ai.prompts.at(-1)).toContain('flow-overflow');
    expect((stored.stageOutput as unknown as StageOutput).flowMetrics!.every((page) => page.filled)).toBe(true);
  });

  it.each([1, 2] as const)('resumes a v%s plan and synchronizes a repaired cover title without replacing metadata', async (version) => {
    ai.shortFirst = true;
    const { jobId } = await enqueueAiBookJob(user.id, 'a cover title revision', templateId);
    await processAiBookJob((await claimAiBookJob())!);
    const queued = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    ai.shortFirst = false;
    const full = fakePlan();
    const base = version === 1
      ? { version, title: full.title, overrides: full.overrides }
      : { ...full, version };
    // Resume a persisted, slot-scoped QA repair for either supported plan shape.
    await db.aiBookJob.update({ where: { id: jobId }, data: { stageOutput: {
      ...(queued.stageOutput as Prisma.JsonObject), contentPlan: base, manuscriptPlan: base, flowIssues: null,
      qaReport: { passed: false, checks: [], findings: [{ code: 'text-fits', severity: 'repair', pageLabel: 'FRONT_COVER', elementId: 'story-cover-title', detail: 'Rewrite the cover title to fit.' }] },
    } } });
    ai.texts['story-cover-title'] = 'After the Rain';
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('COMPLETED');
    expect(ai.calls).toBe(2);
    const manuscript = (stored.stageOutput as unknown as StageOutput).manuscriptPlan!;
    expect(manuscript).toMatchObject({ version, title: 'After the Rain' });
    expect(manuscript.brief).toEqual(version === 2 ? full.brief : undefined);
    expect(manuscript.outline).toEqual(version === 2 ? full.outline : undefined);
    expect(manuscript.overrides.filter((entry) => entry.templateElementId !== 'story-cover-title')).toEqual(base.overrides.filter((entry) => entry.templateElementId !== 'story-cover-title'));
    const submission = await db.submission.findUniqueOrThrow({ where: { id: stored.submissionId! } });
    expect(submission.title).toBe('After the Rain');
    expect(await composedOverride(submission.id, 'FRONT_COVER', 'story-cover-title')).toBe('After the Rain');
  });

  it.each([
    ['malformed JSON', '{"overrides":', 'Invalid JSON'],
    ['wrong text type', JSON.stringify({ overrides: [{ templateElementId: BODY_SLOT_IDS[0], text: 42 }] }), 'overrides.0.text'],
    ['missing targets', JSON.stringify({ overrides: [{ templateElementId: BODY_SLOT_IDS[0], text: BODY_TEXT }] }), 'Missing replacement'],
    ['duplicate targets', JSON.stringify({ overrides: [0, 1].map(() => ({ templateElementId: BODY_SLOT_IDS[0], text: BODY_TEXT })) }), 'Duplicate override'],
    ['unrequested cover', JSON.stringify({ overrides: [{ templateElementId: 'story-cover-title', text: 'A changed title' }] }), 'was not requested'],
  ])('recovers from %s within the same repair claim using actionable feedback', async (_name, raw, detail) => {
    ai.shortFirst = true;
    const { jobId } = await enqueueAiBookJob(user.id, 'a repaired response', templateId);
    await processAiBookJob((await claimAiBookJob())!);
    ai.responses = [raw];
    await makeDue(jobId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored).toMatchObject({ status: 'COMPLETED', failureCount: 0, repairCount: 1 });
    expect(ai.calls).toBe(3);
    expect(ai.prompts.at(-1)).toContain('Your previous answer was rejected:');
    expect(ai.prompts.at(-1)).toContain(detail);
  });

  it('bounds repeated malformed repairs without composing or losing accepted content', async () => {
    ai.shortFirst = true;
    const { jobId } = await enqueueAiBookJob(user.id, 'a broken repair provider', templateId);
    await processAiBookJob((await claimAiBookJob())!);
    const queued = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    const original = queued.stageOutput as unknown as StageOutput;
    ai.responses = Array(6).fill('{"overrides":');
    for (let attempt = 0; attempt < 3; attempt++) {
      await makeDue(jobId);
      await processAiBookJob((await claimAiBookJob())!);
    }
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored).toMatchObject({ status: 'FAILED', failureCount: 3, repairCount: 1, submissionId: null });
    expect(stored.errorMessage).toContain('Invalid JSON');
    expect((stored.stageOutput as unknown as StageOutput).manuscriptPlan).toEqual(original.manuscriptPlan);
    expect((stored.stageOutput as unknown as StageOutput).contentPlan).toEqual(original.contentPlan);
    expect(ai.calls).toBe(7);
    expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);
  });

  it('retries malformed initial plan JSON inside the content claim', async () => {
    ai.responses = ['{"version":'];
    const { jobId } = await enqueueAiBookJob(user.id, 'a valid second response', templateId);
    await processAiBookJob((await claimAiBookJob())!);
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored).toMatchObject({ status: 'COMPLETED', failureCount: 0, repairCount: 0 });
    expect(ai.calls).toBe(2);
  });

  it('never composes a book when nonempty half-page sections remain underfull after repairs', async () => {
    const halfPage = BODY_TEXT.slice(0, 280);
    for (const id of BODY_SLOT_IDS) ai.texts[id] = halfPage;
    const { jobId } = await enqueueAiBookJob(user.id, 'a short manuscript that refuses to grow', templateId);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await makeDue(jobId);
      await processAiBookJob((await claimAiBookJob())!);
    }
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored.status).toBe('FAILED');
    expect(stored.submissionId).toBeNull();
    const output = stored.stageOutput as unknown as StageOutput;
    expect(output.flowIssues).toEqual([expect.objectContaining({ code: 'flow-underfull' })]);
    expect(output.manuscriptPlan?.overrides.filter((entry) => BODY_SLOT_IDS.includes(entry.templateElementId)).map((entry) => entry.text)).toEqual(BODY_SLOT_IDS.map(() => halfPage));
    expect(await db.submission.count({ where: { userId: user.id, aiGenerated: true } })).toBe(0);
  });

  it('fails terminally when an overlong manuscript cannot condense to fit the pages', async () => {
    // Every interior body slot is far longer than the book can hold. Pagination
    // fills all six pages and still has text left over (flow-overflow). The stub
    // provider cannot condense it, so the repair budget exhausts and the job
    // fails rather than composing a silently truncated book.
    const overlong = (
      'The lantern glows beside the window while the rain taps softly on the glass and ' +
      'the sea keeps its long patient breathing beyond the dunes all through the night. '
    ).repeat(10).trim();
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

  it('fences exhausted-repair diagnostics without releasing the current lease or spending another repair', async () => {
    const { jobId } = await enqueueAiBookJob(user.id, 'an exhausted content repair', templateId);
    const stale = (await claimAiBookJob())!;
    await db.aiBookJob.update({ where: { id: jobId }, data: { repairCount: 2, stageOutput: { sentinel: 'keep', flowIssues: ['old'] }, leaseExpiresAt: new Date(Date.now() - 1000) } });
    const current = (await claimAiBookJob())!;
    expect(await continueAiBook(stale, { repair: true, patch: { flowIssues: ['stale'] } })).toBe('lease-lost');
    expect((await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } })).stageOutput).toEqual({ sentinel: 'keep', flowIssues: ['old'] });
    expect(await continueAiBook(current, { repair: true, stage: AiBookStage.CONTENT, patch: { flowIssues: ['final'] } })).toBe('repair-exhausted');
    const stored = await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(stored).toMatchObject({ status: 'PROCESSING', stage: 'CONTENT', repairCount: 2, failureCount: current.failureCount, claimToken: current.claimToken });
    expect(stored.leaseExpiresAt).toEqual(current.leaseExpiresAt);
    expect(stored.stageOutput).toEqual({ sentinel: 'keep', flowIssues: ['final'] });
    expect(await failAiBook(current, true, 'Content repairs exhausted.')).toBe(true);
    expect((await db.aiBookJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('FAILED');
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
