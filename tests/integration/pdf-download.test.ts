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
import { openS3Object } from '@/lib/s3';
import { describeArtifact, type ArtifactManifest } from '@/lib/pdf/artifacts';
import { GET as download, HEAD as downloadHead } from '@/app/api/submissions/[id]/downloads/route';
import { GET as aiDownload } from '@/app/api/ai/books/[id]/downloads/route';
import { GET as status } from '@/app/api/submissions/[id]/render-status/route';
import { GET as adminList } from '@/app/api/admin/submissions/route';
import { NextRequest } from 'next/server';

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string } }));
const storage = vi.hoisted(() => ({ objects: new Map<string, Buffer>(), tampered: new Map<string, Buffer>(), failure: null as null | 'interrupt' | 'checksum' }));
vi.mock('@/auth', () => ({ auth: async () => session.user ? { user: session.user } : null }));
vi.mock('@/lib/s3', () => ({ openS3Object: vi.fn(async (key: string) => {
  const bytes = storage.objects.get(key);
  if (!bytes) throw { name: 'NoSuchKey' };
  const failure = storage.failure;
  const content = failure === 'checksum' ? storage.tampered.get(key) ?? Buffer.alloc(bytes.length) : bytes;
  const body = Readable.from((async function* () {
    yield content.subarray(0, 128);
    yield content.subarray(128, 256);
    if (failure) await new Promise(resolve => setTimeout(resolve, 100));
    if (failure === 'interrupt') throw new Error('Injected storage interruption');
    yield content.subarray(256);
  })());
  return { body, size: bytes.length, contentType: 'application/pdf' };
}), headS3Object: vi.fn(async (key: string) => {
  const bytes = storage.objects.get(key);
  return bytes ? { size: bytes.length, contentType: 'application/pdf' } : null;
}), getPresignedDownloadUrl: vi.fn(async (key: string) => `https://signed.fixture/${key}`) }));
let book: Submission;
let manifest: ArtifactManifest;
const params = (id = book.id) => ({ params: Promise.resolve({ id }) });
const request = (kind = 'print') => new Request(`http://localhost/api/submissions/${book.id}/downloads?kind=${kind}`);

// A different VALID PDF of exactly the original length: only the checksum can
// detect this swap, so the fixture must not fail for being a non-PDF. The
// titled original stays longer than its untitled variant; a trailing PDF
// comment pads the variant to the identical byte count.
async function sameLengthPdfVariant(original: Buffer, size: [number, number], pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage(size);
  const base = Buffer.from(await doc.save());
  const pad = original.length - base.length;
  if (pad < 3) throw new Error('Fixture title must keep the original longer than its untitled variant');
  const padded = Buffer.concat([base, Buffer.from('%' + 'x'.repeat(pad - 2) + '\n')]);
  await PDFDocument.load(padded); // the variant must remain a parseable PDF
  return padded;
}

beforeEach(async () => {
  session.user = await createUser();
  book = await createDraft(session.user.id);
  const print = await PDFDocument.create(); print.addPage([841.8897637795277, 595.2755905511812]);
  print.setTitle('Approved print master fixture');
  const reading = await PDFDocument.create(); for (let i = 0; i < 8; i++) reading.addPage([209.76377952755905, 297.6377952755906]);
  reading.setTitle('Approved reading master fixture');
  const printBytes = Buffer.from(await print.save());
  const readingBytes = Buffer.from(await reading.save());
  const printKey = `pdfs/${session.user.id}/${book.id}/approved.pdf`;
  const readingKey = `pdfs/${session.user.id}/${book.id}/approved-reading.pdf`;
  storage.objects.set(printKey, printBytes); storage.objects.set(readingKey, readingBytes);
  storage.tampered.set(printKey, await sameLengthPdfVariant(printBytes, [841.8897637795277, 595.2755905511812], 1));
  storage.tampered.set(readingKey, await sameLengthPdfVariant(readingBytes, [209.76377952755905, 297.6377952755906], 8));
  manifest = { schemaVersion: 1, submissionId: book.id, submissionRevision: book.revision, renderJobId: 'historical-job',
    printProfile: 'test', templateId: null, templateVersion: null, title: book.title, createdAt: new Date(0).toISOString(),
    print: await describeArtifact({ kind: 'print', s3Key: printKey, bytes: printBytes }),
    reading: await describeArtifact({ kind: 'reading', s3Key: readingKey, bytes: readingBytes }) };
  book = await db.submission.update({ where: { id: book.id }, data: { status: 'APPROVED', pdfS3Key: printKey, readingPdfS3Key: readingKey, artifactManifest: manifest as unknown as Prisma.InputJsonValue } });
});
afterEach(async () => { await cleanupFixtures(); storage.objects.clear(); storage.tampered.clear(); storage.failure = null; });
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
  const adminResult = await download(request(), params());
  expect(adminResult.status).toBe(200);
  expect(Buffer.from(await adminResult.arrayBuffer())).toEqual(storage.objects.get(manifest.print.s3Key));
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
it('denies an AI job whose submission belongs to another account without touching storage', async () => {
  vi.mocked(openS3Object).mockClear();
  const other = await createUser();
  const job = await db.aiBookJob.create({ data: { userId: other.id, concept: 'Fixture', status: 'COMPLETED', submissionId: book.id } });
  session.user = other;
  expect((await aiDownload(request('reading'), params(job.id))).status).toBe(403);
  expect(openS3Object).not.toHaveBeenCalled();
});
it('rejects an invalid artifact kind before the AI job lookup', async () => {
  const job = await db.aiBookJob.create({ data: { userId: book.userId, concept: 'Fixture', status: 'PROCESSING', submissionId: book.id } });
  expect((await aiDownload(request('bogus'), params(job.id))).status).toBe(400);
});
it('answers HEAD with verified metadata without opening the object body', async () => {
  vi.mocked(openS3Object).mockClear();
  const result = await downloadHead(request(), params());
  expect(result.status).toBe(200);
  expect(result.body).toBeNull();
  expect(result.headers.get('content-length')).toBe(String(manifest.print.bytes));
  expect(openS3Object).not.toHaveBeenCalled();
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
it('does not advertise artifacts the download manifest rules would reject', async () => {
  await db.renderJob.create({ data: { submissionId: book.id, status: 'COMPLETED', pdfS3Key: book.pdfS3Key } });
  // A manifest naming a different submission must not surface ready links.
  await db.submission.update({ where: { id: book.id }, data: { artifactManifest: { ...manifest, submissionId: 'another-submission' } as unknown as Prisma.InputJsonValue } });
  let visible = await (await status(request(), params())).json();
  expect(visible).toMatchObject({ ready: false, pdfUrl: null, readingPdfUrl: null, artifacts: { printSheet: false, readingPdf: false } });
  expect((await download(request(), params())).status).toBe(409);
  // A stale revision is equally rejected by the transfer route.
  await db.submission.update({ where: { id: book.id }, data: { artifactManifest: manifest as unknown as Prisma.InputJsonValue, revision: { increment: 1 } } });
  visible = await (await status(request(), params())).json();
  expect(visible).toMatchObject({ ready: false, pdfUrl: null, readingPdfUrl: null, artifacts: { printSheet: false, readingPdf: false } });
  // A per-kind key mismatch hides only that artifact; the matching one stays.
  await db.submission.update({ where: { id: book.id }, data: { revision: book.revision, artifactManifest: { ...manifest, reading: { ...manifest.reading, s3Key: 'pdfs/other/reading.pdf' } } as unknown as Prisma.InputJsonValue } });
  visible = await (await status(request(), params())).json();
  expect(visible).toMatchObject({ ready: false, pdfUrl: `/api/submissions/${book.id}/downloads?kind=print`, readingPdfUrl: null, artifacts: { printSheet: true, readingPdf: false } });
  expect((await download(request('reading'), params())).status).toBe(409);
});
it('admin listing advertises only artifacts the download manifest rules accept', async () => {
  session.user = await createUser('ADMIN');
  const rowFor = async () => {
    const body = await (await adminList(new NextRequest('http://localhost/api/admin/submissions'))).json();
    return body.submissions.find((sub: { id: string }) => sub.id === book.id);
  };
  // A valid manifest advertises both artifacts regardless of moderation state.
  expect((await rowFor()).artifacts).toEqual({ printSheet: true, readingPdf: true });
  // A manifest naming a different submission hides both.
  await db.submission.update({ where: { id: book.id }, data: { artifactManifest: { ...manifest, submissionId: 'another-submission' } as unknown as Prisma.InputJsonValue } });
  expect((await rowFor()).artifacts).toEqual({ printSheet: false, readingPdf: false });
  // A stale revision is equally rejected by the transfer route.
  await db.submission.update({ where: { id: book.id }, data: { artifactManifest: manifest as unknown as Prisma.InputJsonValue, revision: { increment: 1 } } });
  expect((await rowFor()).artifacts).toEqual({ printSheet: false, readingPdf: false });
  // A per-kind key mismatch hides only that artifact; the matching one stays.
  await db.submission.update({ where: { id: book.id }, data: { revision: book.revision, artifactManifest: { ...manifest, reading: { ...manifest.reading, s3Key: 'pdfs/other/reading.pdf' } } as unknown as Prisma.InputJsonValue } });
  const mismatched = await rowFor();
  expect(mismatched.artifacts).toEqual({ printSheet: true, readingPdf: false });
  expect(mismatched.pdfDownloadUrl).toBe(`/api/submissions/${book.id}/downloads?kind=print`);
  // A null manifest keeps the historical print-only fact.
  await db.submission.update({ where: { id: book.id }, data: { readingPdfS3Key: null, artifactManifest: Prisma.DbNull } });
  expect((await rowFor()).artifacts).toEqual({ printSheet: true, readingPdf: false });
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
  let browser: import('@playwright/test').Browser | undefined;
  try {
    // Launch inside the guarded block: a rejected launch must still close the
    // listening HTTP server instead of leaking it for the rest of the run.
    browser = await chromium.launch();
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
    try { await browser?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}, 30000);

it('missing storage produces an explicit error without changing approved masters', async () => {
  storage.objects.delete(book.pdfS3Key!);
  const result = await download(request(), params());
  expect(result.status).toBe(404);
  expect((await result.json()).error).toContain('stored PDF is missing');
  expect(await db.submission.findUniqueOrThrow({ where: { id: book.id } })).toEqual(book);
});
