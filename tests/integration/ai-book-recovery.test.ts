import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { cleanupFixtures, createDraft, createUser, db } from '../fixtures/database';
import { prisma } from '@/lib/prisma';

// The endpoints under test authorize through the session, sign through S3 and
// require an AI provider to be configured. Only those boundaries are replaced:
// ownership, phase derivation and queue sampling all run for real.
const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string } }));
vi.mock('@/auth', () => ({ auth: async () => (session.user ? { user: session.user } : null) }));
const storage = vi.hoisted(() => ({ getPresignedDownloadUrl: vi.fn() }));
vi.mock('@/lib/s3', () => ({ getPresignedDownloadUrl: storage.getPresignedDownloadUrl }));
vi.mock('@/lib/ai/client', () => ({ isAIConfigured: () => true }));

import { GET as listJobs, POST as startJob } from '@/app/api/ai/books/route';
import { GET as jobStatus } from '@/app/api/ai/books/[id]/route';
import { GET as download } from '@/app/api/ai/books/[id]/downloads/route';
import { GET as renderStatus } from '@/app/api/submissions/[id]/render-status/route';

const SIGNED = 'https://storage.example.invalid/signed.pdf';
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (url = 'http://localhost/test', body?: unknown) =>
  new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const downloadFor = (id: string, kind?: string) =>
  download(request(`http://localhost/api/ai/books/${id}/downloads${kind ? `?kind=${kind}` : ''}`), params(id));

beforeEach(async () => {
  session.user = await createUser();
  storage.getPresignedDownloadUrl.mockResolvedValue(SIGNED);
});
afterEach(async () => {
  await cleanupFixtures();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await prisma.$disconnect();
  await db.$disconnect();
});

async function createJob(userId: string, overrides: Partial<Prisma.AiBookJobUncheckedCreateInput> = {}) {
  return db.aiBookJob.create({ data: { userId, concept: 'a story about a rainy day', ...overrides } });
}

async function createBook(
  userId: string,
  data: {
    status?: 'DRAFT' | 'PENDING' | 'APPROVED';
    title?: string;
    pdfS3Key?: string | null;
    readingPdfS3Key?: string | null;
  } = {},
) {
  const draft = await createDraft(userId);
  return db.submission.update({
    where: { id: draft.id },
    data: {
      status: data.status ?? 'APPROVED',
      title: data.title ?? 'A Rainy Day',
      pdfS3Key: data.pdfS3Key === undefined ? 'renders/print.pdf' : data.pdfS3Key,
      readingPdfS3Key: data.readingPdfS3Key === undefined ? 'renders/reading.pdf' : data.readingPdfS3Key,
    },
  });
}

describe('AI book recovery surface', () => {
  it('returns a typed phase and refuses other users and anonymous callers', async () => {
    const owner = session.user!;
    const job = await createJob(owner.id, { status: 'PROCESSING', stage: 'CONTENT' });

    const response = await jobStatus(request(), params(job.id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.phase).toMatchObject({ phase: 'generating', terminal: false });
    expect(body.artifacts).toMatchObject({ approved: false, ready: false });
    expect(body.qaReport).toBeNull();
    // Queue age comes from the server, so the client never has to guess whether
    // a worker is merely slow or actually stopped.
    expect(body.queue).toMatchObject({ stalled: expect.any(Boolean), backlogAfterMs: expect.any(Number) });

    expect((await jobStatus(request(), params('missing-job'))).status).toBe(404);

    session.user = await createUser();
    expect((await jobStatus(request(), params(job.id))).status).toBe(403);

    session.user = await createUser('ADMIN');
    expect((await jobStatus(request(), params(job.id))).status).toBe(200);

    session.user = null;
    expect((await jobStatus(request(), params(job.id))).status).toBe(401);
  });

  it('reports a QA rejection as needs-review and keeps the QA report admin-only', async () => {
    const owner = session.user!;
    const job = await createJob(owner.id, {
      status: 'FAILED',
      stage: 'QA',
      errorMessage: 'Page 3 text still overflows its box.',
      stageOutput: { qaReport: { passed: false, checks: [{ id: 'text-fits', passed: false }] } },
    });

    const customer = await (await jobStatus(request(), params(job.id))).json();
    expect(customer.phase).toMatchObject({ phase: 'needs-review', terminal: true, retryable: false });
    expect(customer.phase.message).toBe('Page 3 text still overflows its box.');
    expect(customer.qaReport).toBeNull();

    session.user = await createUser('ADMIN');
    const admin = await (await jobStatus(request(), params(job.id))).json();
    expect(admin.qaReport).toMatchObject({ passed: false });
  });

  it('lists only the caller\'s jobs, including ones that have no draft yet', async () => {
    const owner = session.user!;
    const book = await createBook(owner.id);
    const finished = await createJob(owner.id, { status: 'COMPLETED', stage: 'QA', submissionId: book.id });
    const pending = await createJob(owner.id, { concept: 'an unfinished idea' });
    await createJob((await createUser()).id);

    const response = await listJobs();
    expect(response.status).toBe(200);
    const { jobs } = (await response.json()) as { jobs: Array<{ id: string; title: string | null; artifacts: { ready: boolean } }> };
    expect(jobs.map((job) => job.id).sort()).toEqual([finished.id, pending.id].sort());

    const ready = jobs.find((job) => job.id === finished.id)!;
    expect(ready.title).toBe('A Rainy Day');
    expect(ready.artifacts).toMatchObject({ approved: true, printSheet: true, readingPdf: true, ready: true });
    expect(jobs.find((job) => job.id === pending.id)!.artifacts.ready).toBe(false);

    session.user = null;
    expect((await listJobs()).status).toBe(401);
  });

  it('makes a retried request idempotent and rejects a key reused for another book', async () => {
    const requestKey = 'recovery-key-0001';
    const first = await startJob(request('http://localhost/test', { concept: 'a story about a rainy day', requestKey }));
    expect(first.status).toBe(202);
    const { jobId, duplicate } = await first.json();
    expect(duplicate).toBe(false);

    // Same key, same payload: the browser's retry returns the original job.
    const retry = await startJob(request('http://localhost/test', { concept: 'a story about a rainy day', requestKey }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ jobId, duplicate: true });
    expect(await db.aiBookJob.count({ where: { userId: session.user!.id } })).toBe(1);

    // Same key, different book: a client bug, not something to silently accept.
    const conflicting = await startJob(request('http://localhost/test', { concept: 'a different book', requestKey }));
    expect(conflicting.status).toBe(409);

    // A genuinely new request is still throttled by the per-user spacing window.
    const second = await startJob(request('http://localhost/test', { concept: 'a second book', requestKey: 'recovery-key-0002' }));
    expect(second.status).toBe(429);
  });

  it('authorizes every download and never invents a missing artifact', async () => {
    const owner = session.user!;
    const book = await createBook(owner.id);
    const job = await createJob(owner.id, { status: 'COMPLETED', stage: 'QA', submissionId: book.id });

    expect((await downloadFor(job.id, 'print')).status).toBe(302);
    expect(storage.getPresignedDownloadUrl).toHaveBeenLastCalledWith('renders/print.pdf', {
      filename: 'a-rainy-day-print-sheet-a4-fold.pdf',
    });
    const reading = await downloadFor(job.id, 'reading');
    expect(reading.status).toBe(302);
    expect(reading.headers.get('location')).toBe(SIGNED);
    expect(storage.getPresignedDownloadUrl).toHaveBeenLastCalledWith('renders/reading.pdf', {
      filename: 'a-rainy-day-reading-74x105mm.pdf',
    });

    expect((await downloadFor(job.id)).status).toBe(400);
    expect((await downloadFor(job.id, 'poster')).status).toBe(400);

    // Unapproved books have no deliverable link, even for their owner.
    await db.submission.update({ where: { id: book.id }, data: { status: 'PENDING' } });
    expect((await downloadFor(job.id, 'print')).status).toBe(403);

    // An admin may still inspect the proof.
    session.user = await createUser('ADMIN');
    expect((await downloadFor(job.id, 'print')).status).toBe(302);

    session.user = await createUser();
    expect((await downloadFor(job.id, 'print')).status).toBe(403);

    session.user = null;
    expect((await downloadFor(job.id, 'print')).status).toBe(401);
  });

  it('reports the reading PDF as unavailable for a print-only book', async () => {
    const owner = session.user!;
    const legacy = await createBook(owner.id, { readingPdfS3Key: null });
    const job = await createJob(owner.id, { status: 'COMPLETED', stage: 'QA', submissionId: legacy.id });

    const response = await downloadFor(job.id, 'reading');
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('only the print sheet is available');

    const status = await (await renderStatus(request(), params(legacy.id))).json();
    expect(status).toMatchObject({ readingPdfUrl: null, readingPdfAvailable: false, ready: false });
    expect(status.pdfUrl).toBe(SIGNED);
  });

  it('declares readiness only when the book is approved and both artifacts exist', async () => {
    const owner = session.user!;
    const complete = await createBook(owner.id);
    await db.renderJob.create({
      data: { submissionId: complete.id, status: 'COMPLETED', pdfS3Key: 'renders/print.pdf', readingPdfS3Key: 'renders/reading.pdf', completedAt: new Date() },
    });

    const status = await (await renderStatus(request(), params(complete.id))).json();
    expect(status).toMatchObject({ ready: true, readingPdfAvailable: true, submissionStatus: 'APPROVED' });
    expect(status.pdfUrl).toBe(SIGNED);
    expect(status.readingPdfUrl).toBe(SIGNED);

    // Approving a print-only render is not enough to claim the book is finished.
    const printOnly = await createBook(owner.id, { readingPdfS3Key: null });
    await db.renderJob.create({ data: { submissionId: printOnly.id, status: 'COMPLETED', pdfS3Key: 'renders/print.pdf', completedAt: new Date() } });
    const half = await (await renderStatus(request(), params(printOnly.id))).json();
    expect(half).toMatchObject({ ready: false, readingPdfAvailable: false, readingPdfUrl: null });
    expect(half.pdfUrl).toBe(SIGNED);

    // A book queued for render is not downloadable yet.
    const unfinished = await createBook(owner.id, { status: 'PENDING' });
    await db.renderJob.create({ data: { submissionId: unfinished.id, status: 'QUEUED' } });
    const queued = await (await renderStatus(request(), params(unfinished.id))).json();
    expect(queued).toMatchObject({ jobStatus: 'QUEUED', pdfUrl: null, readingPdfUrl: null, ready: false });

    session.user = await createUser();
    expect((await renderStatus(request(), params(complete.id))).status).toBe(403);
  });
});
