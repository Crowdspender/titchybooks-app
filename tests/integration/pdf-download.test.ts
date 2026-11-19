import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Prisma, type Submission } from '@prisma/client';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';
import { prisma } from '@/lib/prisma';
import { describeArtifact, type ArtifactManifest } from '@/lib/pdf/artifacts';
import { GET as download } from '@/app/api/submissions/[id]/downloads/route';
import { GET as aiDownload } from '@/app/api/ai/books/[id]/downloads/route';
import { GET as status } from '@/app/api/submissions/[id]/render-status/route';

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string } }));
const storage = vi.hoisted(() => ({ objects: new Map<string, Buffer>(), failure: null as null | 'interrupt' | 'checksum' }));
vi.mock('@/auth', () => ({ auth: async () => session.user ? { user: session.user } : null }));
vi.mock('@/lib/s3', () => ({ openS3Object: vi.fn(async (key: string) => {
  const bytes = storage.objects.get(key);
  if (!bytes) throw { name: 'NoSuchKey' };
  const failure = storage.failure;
  const content = failure === 'checksum' ? Buffer.alloc(bytes.length) : bytes;
  const body = Readable.from((async function* () {
    yield content.subarray(0, 128);
    yield content.subarray(128, 256);
    if (failure) await new Promise(resolve => setTimeout(resolve, 100));
    if (failure === 'interrupt') throw new Error('Injected storage interruption');
    yield content.subarray(256);
  })());
  return { body, size: bytes.length, contentType: 'application/pdf' };
}) }));
let book: Submission;
let manifest: ArtifactManifest;
const params = (id = book.id) => ({ params: Promise.resolve({ id }) });
const request = (kind = 'print') => new Request(`http://localhost/api/submissions/${book.id}/downloads?kind=${kind}`);

beforeEach(async () => {
  session.user = await createUser();
  book = await createDraft(session.user.id);
  const print = await PDFDocument.create(); print.addPage([841.8897637795277, 595.2755905511812]);
  const reading = await PDFDocument.create(); for (let i = 0; i < 8; i++) reading.addPage([209.76377952755905, 297.6377952755906]);
  const printBytes = Buffer.from(await print.save());
  const readingBytes = Buffer.from(await reading.save());
  const printKey = `pdfs/${session.user.id}/${book.id}/approved.pdf`;
  const readingKey = `pdfs/${session.user.id}/${book.id}/approved-reading.pdf`;
  storage.objects.set(printKey, printBytes); storage.objects.set(readingKey, readingBytes);
  manifest = { schemaVersion: 1, submissionId: book.id, submissionRevision: book.revision, renderJobId: 'historical-job',
    printProfile: 'test', templateId: null, templateVersion: null, title: book.title, createdAt: new Date(0).toISOString(),
    print: await describeArtifact({ kind: 'print', s3Key: printKey, bytes: printBytes }),
    reading: await describeArtifact({ kind: 'reading', s3Key: readingKey, bytes: readingBytes }) };
  book = await db.submission.update({ where: { id: book.id }, data: { status: 'APPROVED', pdfS3Key: printKey, readingPdfS3Key: readingKey, artifactManifest: manifest as unknown as Prisma.InputJsonValue } });
});
afterEach(async () => { await cleanupFixtures(); storage.objects.clear(); storage.failure = null; });
afterAll(async () => { await prisma.$disconnect(); await db.$disconnect(); });

it('downloads both published masters without modifying the approved row, pages, or render history', async () => {
  const before = await db.submission.findUniqueOrThrow({ where: { id: book.id }, include: { pages: true, renderJobs: true } });
  for (const kind of ['print', 'reading'] as const) {
    const result = await download(request(kind), params());
    expect(result.status).toBe(200);
    expect(Buffer.from(await result.arrayBuffer())).toEqual(storage.objects.get(manifest[kind].s3Key));
    expect(result.headers.get('content-length')).toBe(String(manifest[kind].bytes));
  }
  expect(await db.submission.findUniqueOrThrow({ where: { id: book.id }, include: { pages: true, renderJobs: true } })).toEqual(before);
});
it('rechecks current ownership, moderation state, and authentication on each transfer', async () => {
  session.user = await createUser();
  expect((await download(request(), params())).status).toBe(403);
  session.user = await createUser('ADMIN');
  await (await download(request(), params())).arrayBuffer();
  await db.submission.update({ where: { id: book.id }, data: { status: 'PENDING' } });
  session.user = { id: book.userId, role: 'USER' };
  expect((await download(request(), params())).status).toBe(403);
  session.user = null;
  expect((await download(request(), params())).status).toBe(401);
});
it('keeps existing AI URLs compatible while enforcing both job and submission access', async () => {
  const job = await db.aiBookJob.create({ data: { userId: book.userId, concept: 'Fixture', status: 'COMPLETED', submissionId: book.id } });
  const result = await aiDownload(request('reading'), params(job.id));
  expect(result.status).toBe(200);
  expect(Buffer.from(await result.arrayBuffer())).toEqual(storage.objects.get(manifest.reading.s3Key));
  await db.aiBookJob.update({ where: { id: job.id }, data: { status: 'PROCESSING' } });
  expect((await aiDownload(request(), params(job.id))).status).toBe(409);
});
it('preserves historical print-only availability even with a historical completed job', async () => {
  await db.submission.update({ where: { id: book.id }, data: { readingPdfS3Key: null, artifactManifest: Prisma.DbNull } });
  await db.renderJob.create({ data: { submissionId: book.id, status: 'COMPLETED', pdfS3Key: book.pdfS3Key } });
  const visible = await (await status(request(), params())).json();
  expect(visible).toMatchObject({ ready: true, legacy: true, readingPdfUrl: null, artifacts: { printSheet: true, readingPdf: false } });
  await (await download(request(), params())).arrayBuffer();
  expect((await download(request('reading'), params())).status).toBe(409);
});
it('exposes both no-job artifact links without signed URLs', async () => {
  const visible = await (await status(request(), params())).json();
  expect(visible).toMatchObject({ ready: true, pdfUrl: `/api/submissions/${book.id}/downloads?kind=print`, readingPdfUrl: `/api/submissions/${book.id}/downloads?kind=reading` });
});
it('allows an available reading artifact without substituting a missing print sheet', async () => {
  await db.submission.update({ where: { id: book.id }, data: { pdfS3Key: null } });
  const visible = await (await status(request(), params())).json();
  expect(visible).toMatchObject({ ready: false, pdfUrl: null, readingPdfUrl: `/api/submissions/${book.id}/downloads?kind=reading`, artifacts: { printSheet: false, readingPdf: true } });
  await (await download(request('reading'), params())).arrayBuffer();
  expect((await download(request(), params())).status).toBe(409);
});
it('labels a failed render truthfully instead of ready or generating', async () => {
  await db.submission.update({ where: { id: book.id }, data: { status: 'FAILED', pdfS3Key: null, readingPdfS3Key: null, artifactManifest: Prisma.DbNull } });
  await db.renderJob.create({ data: { submissionId: book.id, status: 'FAILED', errorMessage: 'secret provider error' } });
  const visible = await (await status(request(), params())).json();
  expect(visible).toMatchObject({ ready: false, jobStatus: 'FAILED', pdfUrl: null, readingPdfUrl: null });
  expect(visible.job.errorMessage).not.toContain('secret');
});
// Native Chromium transfer through the actual service, real local database and
// Node HTTP bridge. Only storage and the session are mocked; no provider egress.
it.each(['print', 'reading', 'interrupt', 'checksum'] as const)('verifies actual service HTTP transfer in Chromium: %s', async mode => {
  storage.failure = mode === 'interrupt' || mode === 'checksum' ? mode : null;
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const result = await download(new Request(`http://localhost${req.url}`, { signal: controller.signal, headers: { accept: 'text/html' } }), params());
      res.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body as import('node:stream/web').ReadableStream), res);
      else res.end();
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.route('**/*', route => new URL(route.request().url()).origin === `http://127.0.0.1:${port}` ? route.continue() : route.abort());
    const kind = mode === 'reading' ? 'reading' : 'print';
    // Browser navigation to attachment emits download without a document commit.
    const pending = page.waitForEvent('download');
    await page.goto(`http://127.0.0.1:${port}/downloads?kind=${kind}`).catch(error => {
      if (!String(error).includes('Download is starting') && !String(error).includes('ERR_ABORTED')) throw error;
    });
    const saved = await pending;
    if (storage.failure) expect(await saved.failure()).not.toBeNull();
    else {
      expect(await saved.failure()).toBeNull();
      const file = await saved.path();
      const bytes = await readFile(file!);
      expect(bytes.length).toBe(manifest[kind].bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest[kind].sha256);
      expect((await PDFDocument.load(bytes)).getPageCount()).toBe(kind === 'print' ? 1 : 8);
      expect(saved.suggestedFilename()).toContain(kind === 'print' ? 'print-sheet-a4-fold.pdf' : 'reading-74x105mm.pdf');
    }
    expect(await db.submission.findUniqueOrThrow({ where: { id: book.id } })).toEqual(book);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 30000);

it('missing storage produces an explicit error without changing approved masters', async () => {
  storage.objects.delete(book.pdfS3Key!);
  const result = await download(request(), params());
  expect(result.status).toBe(404);
  expect((await result.json()).error).toContain('stored PDF is missing');
  expect(await db.submission.findUniqueOrThrow({ where: { id: book.id } })).toEqual(book);
});
