import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import { describeArtifact, type ArtifactManifest } from '@/lib/pdf/artifacts';
import { pdfErrorResponse, submissionPdfResponse } from '@/lib/pdf/download';
import { headS3Object, openS3Object, s3Client } from '@/lib/s3';
import { GET as download, HEAD as downloadHead } from '@/app/api/submissions/[id]/downloads/route';
import { GET as aiDownload, HEAD as aiHead } from '@/app/api/ai/books/[id]/downloads/route';

const mocks = vi.hoisted(() => ({ find: vi.fn(), job: vi.fn(), auth: vi.fn() }));
vi.mock('@/lib/prisma', () => ({ prisma: { submission: { findUnique: mocks.find }, aiBookJob: { findUnique: mocks.job } } }));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/s3', async () => ({
  ...await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3'), openS3Object: vi.fn(), headS3Object: vi.fn(),
}));
let bytes: Buffer;
let manifest: ArtifactManifest;
let source: Readable;
const owner = { id: 'owner', role: 'USER' };
const row = () => ({ id: 'book', userId: owner.id, title: 'Émilie\r\n"<Book>', status: 'APPROVED', revision: 3,
  pdfS3Key: 'private/print.pdf', readingPdfS3Key: 'private/reading.pdf', artifactManifest: manifest });
const request = (query = '?kind=print', init?: RequestInit) => new Request(`http://localhost/api/submissions/book/downloads${query}`, init);
const params = { params: Promise.resolve({ id: 'book' }) };
const response = (query = '?kind=print', actor: typeof owner | null = owner, init?: RequestInit) => submissionPdfResponse(request(query, init), 'book', actor);

beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const pdf = await PDFDocument.create();
  pdf.addPage([297 * 72 / 25.4, 210 * 72 / 25.4]).drawText('Controlled transfer');
  bytes = Buffer.from(await pdf.save());
  manifest = { schemaVersion: 1, submissionId: 'book', submissionRevision: 3, renderJobId: 'job', printProfile: 'test',
    templateId: null, templateVersion: null, title: null, createdAt: new Date(0).toISOString(),
    print: await describeArtifact({ kind: 'print', s3Key: 'private/print.pdf', bytes }),
    reading: await describeArtifact({ kind: 'reading', s3Key: 'private/reading.pdf', bytes }) };
  source = Readable.from([bytes.subarray(0, 128), bytes.subarray(128)]);
  vi.mocked(openS3Object).mockResolvedValue({ body: source, size: bytes.length, contentType: 'application/octet-stream' });
  vi.mocked(headS3Object).mockResolvedValue({ size: bytes.length, contentType: 'application/pdf' });
  mocks.find.mockResolvedValue(row());
  mocks.auth.mockResolvedValue({ user: owner });
  mocks.job.mockResolvedValue({ id: 'book', userId: owner.id, status: 'COMPLETED', submissionId: 'book' });
});
afterEach(() => { source.destroy(); vi.restoreAllMocks(); });

it.each(['print', 'reading'])('streams exact %s bytes with private headers and safe filenames', async kind => {
  const result = await response(`?kind=${kind}`);
  expect(result.status).toBe(200);
  expect(result.headers.get('content-type')).toBe('application/pdf');
  expect(result.headers.get('content-length')).toBe(String(bytes.length));
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(result.headers.get('vary')).toContain('Cookie');
  expect(result.headers.get('content-disposition')).toBe(`attachment; filename="emilie-book-${kind === 'print' ? 'print-sheet-a4-fold' : 'reading-74x105mm'}.pdf"`);
  expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
  expect(source.destroyed).toBe(true);
  expect(openS3Object).toHaveBeenCalledWith(`private/${kind}.pdf`, expect.any(AbortSignal));
});
it('uses inline only when explicitly requested', async () => {
  const result = await response('?kind=reading&disposition=inline');
  expect(result.headers.get('content-disposition')).toMatch(/^inline;/);
  await result.arrayBuffer();
});
it('answers HEAD with verified metadata without opening the object body', async () => {
  const result = await submissionPdfResponse(request(), 'book', owner, 'HEAD');
  expect(result.status).toBe(200);
  expect(result.body).toBeNull();
  expect(result.headers.get('content-length')).toBe(String(bytes.length));
  expect(result.headers.get('content-disposition')).toContain('print-sheet-a4-fold.pdf');
  expect(headS3Object).toHaveBeenCalledWith('private/print.pdf');
  expect(openS3Object).not.toHaveBeenCalled();
});
it('reports a missing object on HEAD without opening a body', async () => {
  vi.mocked(headS3Object).mockResolvedValue(null);
  expect((await submissionPdfResponse(request(), 'book', owner, 'HEAD')).status).toBe(404);
  expect(openS3Object).not.toHaveBeenCalled();
});
it('rejects an unverifiable HEAD length against the published descriptor', async () => {
  vi.mocked(headS3Object).mockResolvedValue({ size: bytes.length + 1, contentType: 'application/pdf' });
  expect((await submissionPdfResponse(request(), 'book', owner, 'HEAD')).status).toBe(502);
  expect(openS3Object).not.toHaveBeenCalled();
});
it.each([
  ['?kind=invalid', 400], ['', 400], ['?kind=print&disposition=bad', 400],
])('rejects invalid options %s before storage', async (query, code) => {
  expect((await response(query)).status).toBe(code);
  expect(openS3Object).not.toHaveBeenCalled();
});
it('rejects expired authentication before database or storage access', async () => {
  expect((await response('?kind=print', null)).status).toBe(401);
  expect(mocks.find).not.toHaveBeenCalled();
  expect(openS3Object).not.toHaveBeenCalled();
});
// Factories run inside each test, after beforeEach has built the manifest:
// the missing-key case must differ from the valid row only in pdfS3Key.
it.each([
  [() => null, 404], [() => ({ ...row(), userId: 'other' }), 403], [() => ({ ...row(), status: 'SUBMITTED' }), 403],
  [() => ({ ...row(), pdfS3Key: null }), 409], [() => ({ ...row(), artifactManifest: {} }), 409],
])('fails closed for missing, foreign, unapproved or inconsistent books %#', async (value, code) => {
  mocks.find.mockResolvedValue(value());
  expect((await response()).status).toBe(code);
  expect(openS3Object).not.toHaveBeenCalled();
});
it.each(['submissionId', 'submissionRevision', 'key'])('rejects a mismatched manifest %s', async field => {
  if (field === 'submissionId') manifest.submissionId = 'other';
  if (field === 'submissionRevision') manifest.submissionRevision = 2;
  if (field === 'key') manifest.print.s3Key = 'other';
  expect((await response()).status).toBe(409);
  expect(openS3Object).not.toHaveBeenCalled();
});
it('allows administrators to inspect unapproved artifacts', async () => {
  mocks.find.mockResolvedValue({ ...row(), userId: 'other', status: 'SUBMITTED' });
  const result = await response('?kind=print', { id: 'admin', role: 'ADMIN' });
  expect(result.status).toBe(200);
  await result.arrayBuffer();
});
it('preserves historical print-only downloads without inventing reading files', async () => {
  mocks.find.mockResolvedValue({ ...row(), readingPdfS3Key: null, artifactManifest: null });
  expect((await response('?kind=reading')).status).toBe(409);
  const result = await response();
  expect(result.status).toBe(200);
  expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
});
it.each(['NoSuchKey', 'NotFound'])('reports %s explicitly without regenerating', async name => {
  vi.mocked(openS3Object).mockRejectedValue({ name });
  const result = await response();
  expect(result.status).toBe(404);
  expect((await result.json()).error).toContain('will not regenerate');
});
it('sanitizes provider/database failures', async () => {
  vi.mocked(openS3Object).mockRejectedValue(new Error('SECRET bucket endpoint'));
  const result = await response();
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain('SECRET');
});
it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 100])('rejects unverifiable length %s and releases storage', async size => {
  vi.mocked(openS3Object).mockResolvedValue({ body: source, size, contentType: 'application/pdf' });
  expect((await response()).status).toBe(502);
  expect(source.destroyed).toBe(true);
});
it.each(['truncated', 'overflow', 'checksum', 'source-error'])('fails an incomplete or changed stream: %s', async mode => {
  source.destroy();
  source = mode === 'source-error' ? Readable.from((async function* () { yield bytes.subarray(0, 128); throw new Error('SECRET'); })())
    : Readable.from([mode === 'truncated' ? bytes.subarray(0, 128) : mode === 'overflow' ? Buffer.concat([bytes, Buffer.from('extra')]) : Buffer.alloc(bytes.length)]);
  vi.mocked(openS3Object).mockResolvedValue({ body: source, size: bytes.length, contentType: 'application/pdf' });
  const result = await response();
  expect(result.status).toBe(200); // Headers precede transfer integrity; failure is a broken body, never a completed save.
  await expect(result.arrayBuffer()).rejects.toThrow('transfer failed');
  expect(source.destroyed).toBe(true);
});
it('does not consume storage until the response is read and releases it on cancellation', async () => {
  source.destroy();
  let pulls = 0;
  source = new Readable({
    read() {
      pulls += 1;
      this.push(pulls === 1 ? bytes.subarray(0, 128) : pulls === 2 ? bytes.subarray(128) : null);
    },
  });
  vi.mocked(openS3Object).mockResolvedValue({ body: source, size: bytes.length, contentType: 'application/pdf' });
  const result = await response();
  // readableLength alone cannot prove laziness: a fully buffered source also
  // reports zero. Record actual reads instead.
  expect(pulls).toBe(0);
  expect(source.destroyed).toBe(false);
  await result.body!.cancel();
  expect(source.destroyed).toBe(true);
});
it('cancels an in-flight source when the browser aborts', async () => {
  const controller = new AbortController();
  const result = await response('?kind=print', owner, { signal: controller.signal });
  controller.abort();
  await expect(result.arrayBuffer()).rejects.toThrow();
  expect(source.destroyed).toBe(true);
});
it('returns escaped, visible HTML errors and retry links without attachment headers', async () => {
  const result = pdfErrorResponse(request('?kind=print&extra=%22', { headers: { accept: 'text/html' } }), 401, '<script>SECRET</script>');
  expect(result.status).toBe(401);
  const html = await result.text();
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('Retry PDF request');
  expect(html).toContain('Sign in');
  expect(result.headers.get('content-disposition')).toBeNull();
  expect(result.headers.get('content-security-policy')).toContain("default-src 'none'");
});
it.each(['submission', 'ai'])('delegates the %s route to the shared authenticated transfer', async kind => {
  const result = await (kind === 'ai' ? aiDownload : download)(request(), params);
  expect(result.status).toBe(200);
  expect(result.headers.get('location')).toBeNull();
  expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
});
it.each(['submission', 'ai'])('delegates the %s HEAD route to metadata-only verification', async kind => {
  const result = await (kind === 'ai' ? aiHead : downloadHead)(request(), params);
  expect(result.status).toBe(200);
  expect(result.body).toBeNull();
  expect(result.headers.get('content-length')).toBe(String(bytes.length));
  expect(openS3Object).not.toHaveBeenCalled();
});
it.each([
  [null, 404], [{ userId: 'other', status: 'COMPLETED', submissionId: 'book' }, 403],
  [{ userId: owner.id, status: 'PROCESSING', submissionId: 'book' }, 409],
])('preserves AI job access and completion checks %#', async (job, code) => {
  mocks.job.mockResolvedValue(job);
  expect((await aiDownload(request(), params)).status).toBe(code);
  expect(openS3Object).not.toHaveBeenCalled();
});
it.each([
  [{ userId: owner.id, status: 'PROCESSING', submissionId: 'book' }],
  [null],
])('rejects an invalid AI download kind before the job lookup %#', async job => {
  mocks.job.mockResolvedValue(job);
  expect((await aiDownload(request('?kind=invalid'), params)).status).toBe(400);
  expect(mocks.job).not.toHaveBeenCalled();
});
it('denies an AI job whose submission belongs to another account', async () => {
  mocks.find.mockResolvedValue({ ...row(), userId: 'other' });
  expect((await aiDownload(request(), params)).status).toBe(403);
  expect(openS3Object).not.toHaveBeenCalled();
});
it.each(['submission', 'ai'])('sanitizes %s authentication failures into visible retry responses', async kind => {
  mocks.auth.mockRejectedValue(new Error('SECRET auth failure'));
  const result = await (kind === 'ai' ? aiDownload : download)(request('', { headers: { accept: 'text/html' } }), params);
  expect(result.status).toBe(503);
  const html = await result.text();
  expect(html).toContain('Retry PDF request');
  expect(html).not.toContain('SECRET');
});
it('sanitizes AI database failures', async () => {
  mocks.job.mockRejectedValue(new Error('SECRET database'));
  const result = await aiDownload(request(), params);
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain('SECRET');
});
it('rechecks authorization on every request even for a previously valid same-origin URL', async () => {
  await (await download(request(), params)).arrayBuffer();
  mocks.auth.mockResolvedValue(null);
  expect((await download(request(), params)).status).toBe(401);
  expect(openS3Object).toHaveBeenCalledTimes(1);
});
it('opens the actual SDK adapter as an abortable Node stream without buffering', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3');
  const send = vi.spyOn(s3Client, 'send').mockResolvedValue({ Body: source, ContentLength: bytes.length, ContentType: 'application/pdf' } as never);
  const controller = new AbortController();
  const object = await actual.openS3Object('private/print.pdf', controller.signal);
  expect(object.body).toBe(source);
  expect(object.size).toBe(bytes.length);
  expect(send.mock.calls[0][0].input).toMatchObject({ Key: 'private/print.pdf' });
  expect(send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
});
it('bounds storage connect and socket inactivity so a stalled transfer fails instead of hanging', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3');
  const configured = actual.s3Client.config.requestHandler as unknown;
  const handler = (typeof configured === 'function' ? await (configured as () => Promise<unknown>)() : configured) as { configProvider: Promise<{ connectionTimeout?: number; socketTimeout?: number }> };
  // The pinned handler materializes its config on first handle(); until then
  // the resolved defaults (including our timeouts) live in configProvider.
  const configs = await handler.configProvider;
  expect(configs.connectionTimeout).toBeGreaterThan(0);
  expect(configs.socketTimeout).toBeGreaterThan(0);
});
