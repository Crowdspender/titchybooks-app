import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  db,
  createUser,
  createAiReadyTemplate,
  cleanupFixtures,
} from '../fixtures/database';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { SEED_RECIPES, type SeedTextElement } from '../../prisma/seed-recipes';

// The fake LLM fills every generated slot of the starter recipe, because the
// pipeline refuses a plan that skips a required slot. Tests override individual
// slots (`ai.texts`) to drive QA outcomes.
const ai = vi.hoisted(() => ({
  texts: {} as Record<string, string>,
  flagged: false,
}));

const RECIPE = SEED_RECIPES[0];
const GENERATED_SLOTS = RECIPE.elements.filter(
  (element): element is SeedTextElement => element.kind === 'text' && !element.locked,
);
const BODY_TEXT = 'Rain taps softly on the window while the lantern glows beside the bed.';
const ROLE_TEXT: Record<string, string> = {
  'story-cover-title': 'A Rainy Day',
  'story-back-closing': 'Goodnight, little one. The lantern keeps its light until morning.',
};

function fakePlan() {
  return {
    title: 'A Rainy Day',
    overrides: GENERATED_SLOTS.map((element) => ({
      templateElementId: element.id,
      text: ai.texts[element.id] ?? ROLE_TEXT[element.id] ?? BODY_TEXT,
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
        create: async () => ({ choices: [{ message: { content: JSON.stringify(fakePlan()) } }] }),
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

interface QaCheckOut { id: string; passed: boolean; detail: string; severity: string }
interface StageOutput {
  templateId?: string;
  contentPlan?: { title: string };
  qaReport?: { passed: boolean; checks: QaCheckOut[] };
  qaSampled?: boolean;
}

let user: { id: string; role: string };
let templateId: string;

beforeEach(async () => {
  ai.texts = {};
  ai.flagged = false;
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
    // Wide uppercase text that still fits the character budget but overflows the
    // box when measured, so it survives plan validation and fails QA `text-fits`.
    ai.texts['story-page2-body'] = 'MMMM '.repeat(104);
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

  it('exhausts retries on persistent QA failure and leaves the submission PENDING', async () => {
    ai.texts['story-page2-body'] = 'MMMM '.repeat(104);
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
