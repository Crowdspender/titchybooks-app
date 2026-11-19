import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';
import { Prisma } from '@prisma/client';
import { createEmptyEditorScene } from '@/lib/editor/schema';
import { imageElement } from '../fixtures/scenes';
import { PAGE_LABELS } from '@/lib/constants';
import { buildPinnedTemplate, buildTemplateManifest } from '@/lib/ai/template-contract';
import { createInstanceWithOverrides, duplicateAsDraft, lockSubmission, savePage } from '@/lib/editor/submission-store';
import { lockAssetReferences, removeAssetFromLibrary, requireNoTemplateDependents } from '@/lib/assets/references';
import { enqueueInTransaction, enqueueRenderJob, claimRenderJob, processRenderJob } from '@/lib/pdf/render-job';
import { enqueueAiBookJob, claimAiBookJob, advanceStage, continueAiBook, completeAiBook, AiBookStage } from '@/lib/ai/ai-book-job';
import { PDFDocument } from 'pdf-lib';
import { prisma } from '@/lib/prisma';
import { GET as list, POST as register } from '@/app/api/assets/route';
import { GET as image } from '@/app/api/assets/[assetId]/image/route';
import { POST as presign } from '@/app/api/assets/presign/route';
import { DELETE as remove } from '@/app/api/assets/[assetId]/route';
import { DELETE as deleteDraft } from '@/app/api/submissions/[id]/route';
import { DELETE as deleteTemplate } from '@/app/api/admin/templates/[id]/route';
import { POST as fromTemplate } from '@/app/api/submissions/from-template/route';
import { POST as detach } from '@/app/api/submissions/[id]/detach-from-template/route';
import { deleteS3Object, downloadFromS3, uploadToS3 } from '@/lib/s3';
import { GET as legacyPresign } from '@/app/api/upload/presign/route';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  user: null as null | { id: string; role: string }, objects: new Map<string, Buffer>(),
}));
vi.mock('@/auth', () => ({ auth: async () => state.user ? { user: state.user } : null }));
vi.mock('@/lib/s3', async () => ({
  ...await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3'),
  getPresignedUploadUrl: vi.fn(async (key: string) => `http://localhost/fixture-put/${key}`),
  headS3Object: vi.fn(async (key: string) => state.objects.has(key) ? { size: state.objects.get(key)!.length } : null),
  downloadFromS3: vi.fn(async (key: string) => {
    const bytes = state.objects.get(key);
    if (!bytes) throw new Error('Missing fixture object');
    return Buffer.from(bytes);
  }),
  uploadToS3: vi.fn(async (key: string, bytes: Buffer) => { state.objects.set(key, Buffer.from(bytes)); }),
  deleteS3Object: vi.fn(async () => { throw new Error('Source deletion must never be called'); }),
}));
const request = (body: unknown = {}) => new Request('http://localhost/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const params = (assetId: string) => ({ params: Promise.resolve({ assetId }) });
async function uploaded() {
  const id = randomUUID();
  const s3Key = `assets/${state.user!.id}/${id}.png`;
  const bytes = await sharp({ create: { width: 12, height: 16, channels: 3, background: 'blue' } }).png().toBuffer();
  state.objects.set(s3Key, bytes);
  return { id, bytes, body: { s3Key, originalFilename: 'photo.png', mimeType: 'image/jpeg', fileSize: 1, width: 1, height: 1 } };
}
beforeEach(async () => { vi.clearAllMocks(); state.objects.clear(); state.user = await createUser(); vi.stubEnv('OPENAI_API_KEY', 'isolated-fixture-key'); });
afterEach(async () => { await cleanupFixtures(); vi.unstubAllEnvs(); });
afterAll(async () => { await prisma.$disconnect(); await db.$disconnect(); });

it('registers verified dimensions/MIME/size, using an authorized private URL', async () => {
  const source = await uploaded();
  const response = await register(request(source.body));
  expect(response.status).toBe(201);
  const { asset } = await response.json();
  expect(asset).toMatchObject({ id: source.id, width: 12, height: 16, fileSize: source.bytes.length, mimeType: 'image/png', deletedAt: null });
  expect(asset.s3Key).toContain(`/canonical/`);
  expect(asset.s3Key).not.toBe(source.body.s3Key);
  expect(state.objects.get(asset.s3Key)).toEqual(source.bytes);
  expect(asset.downloadUrl).toBe(`/api/assets/${source.id}/image`);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
it('retries preserve the first accepted ID/bytes even after the staging object is overwritten', async () => {
  const source = await uploaded();
  const original = (await (await register(request(source.body))).json()).asset;
  state.objects.set(source.body.s3Key, Buffer.from('corrupt overwritten staging object'));
  vi.mocked(downloadFromS3).mockClear();
  const retry = await register(request(source.body));
  expect(retry.status).toBe(201);
  expect((await retry.json()).asset).toMatchObject({ id: original.id, s3Key: original.s3Key, fileSize: original.fileSize });
  expect(downloadFromS3).not.toHaveBeenCalled();
  expect(state.objects.get(original.s3Key)).toEqual(source.bytes);
});
it('concurrent finalizations produce one accepted asset without replacing its source', async () => {
  const source = await uploaded();
  const responses = await Promise.all([register(request(source.body)), register(request(source.body))]);
  expect(responses.map(response => response.status)).toEqual([201, 201]);
  const assets = await Promise.all(responses.map(async response => (await response.json()).asset));
  expect(assets[0].id).toBe(assets[1].id);
  expect(assets[0].s3Key).toBe(assets[1].s3Key);
  expect(await db.asset.count({ where: { userId: state.user!.id } })).toBe(1);
  expect(state.objects.get(assets[0].s3Key)).toEqual(source.bytes);
});
it('rejects corrupt/missing objects and foreign or canonical registration keys', async () => {
  const source = await uploaded();
  state.objects.set(source.body.s3Key, Buffer.from('not an image'));
  expect((await register(request(source.body))).status).toBe(400);
  state.objects.delete(source.body.s3Key);
  expect((await register(request(source.body))).status).toBe(400);
  expect((await register(request({ ...source.body, s3Key: `assets/other/${source.id}.png` }))).status).toBe(400);
  expect((await register(request({ ...source.body, s3Key: `assets/${state.user!.id}/canonical/attempt.png` }))).status).toBe(400);
  expect(await db.asset.count({ where: { userId: state.user!.id } })).toBe(0);
  expect(uploadToS3).not.toHaveBeenCalled();
});
it('serves private/no-store bytes without wildcard sharing and denies cross-user access', async () => {
  const source = await uploaded();
  const { asset } = await (await register(request(source.body))).json();
  const response = await image(request(), params(asset.id));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(response.headers.get('content-length')).toBe(String(source.bytes.length));
  expect(Buffer.from(await response.arrayBuffer())).toEqual(source.bytes);
  state.user = await createUser();
  expect((await image(request(), params(asset.id))).status).toBe(404);
  state.user = null;
  const denied = await image(request(), params(asset.id));
  expect(denied.status).toBe(401);
  expect(denied.headers.get('cache-control')).toBe('private, no-store');
});
it('does not list or resurrect removed assets, while retaining authorized source reads', async () => {
  const source = await uploaded();
  await register(request(source.body));
  await db.asset.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
  expect((await (await list()).json()).assets).toHaveLength(0);
  expect((await register(request(source.body))).status).toBe(409);
  expect((await image(request(), params(source.id))).status).toBe(200);
  expect(state.objects.size).toBe(2);
});
it('mints only staging keys, regardless of the declared filename extension', async () => {
  const response = await presign(request({ filename: 'photo.png/nested', contentType: 'image/png' }));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.s3Key).toBe(`assets/${state.user!.id}/${result.assetId}.png`);
  expect(result.s3Key).not.toContain('/canonical/');
});

const bookParams = (id: string) => ({ params: Promise.resolve({ id }) });
async function accepted() {
  const source = await uploaded();
  const response = await register(request(source.body));
  expect(response.status).toBe(201);
  return (await response.json()).asset as { id: string; s3Key: string };
}
const imageScene = (id: string) => ({ ...createEmptyEditorScene(), elements: [imageElement(id)] });
function pinned(templateId: string, assetId: string) {
  const pages = PAGE_LABELS.map(pageLabel => ({ pageLabel, backgroundColor: '#ffffff', elements: pageLabel === 'FRONT_COVER' ? [imageElement(assetId)] : [] }));
  const manifest = buildTemplateManifest({ templateId, templateVersion: 1, pages });
  return buildPinnedTemplate({ templateId, templateVersion: 1, pages, manifest });
}

it('soft removes an unreferenced item idempotently without deleting the row or bytes', async () => {
  const asset = await accepted();
  const before = new Map(state.objects);
  expect((await remove(request(), params(asset.id))).status).toBe(200);
  const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
  expect(row.deletedAt).toBeInstanceOf(Date);
  expect(row.s3Key).toBe(asset.s3Key);
  expect((await remove(request(), params(asset.id))).status).toBe(200);
  expect(state.objects).toEqual(before);
  expect(deleteS3Object).not.toHaveBeenCalled();
  expect((await image(request(), params(asset.id))).status).toBe(200);
  expect((await (await list()).json()).assets).toHaveLength(0);
  const other = await createUser(); state.user = other;
  expect((await remove(request(), params(asset.id))).status).toBe(403);
  expect((await remove(request(), params('absent'))).status).toBe(404);
});

it('protects scenes in another draft, and rejects new uses of a removed item', async () => {
  const asset = await accepted();
  const draft = await createDraft(state.user!.id);
  await savePage(draft.id, 'PAGE_7', state.user!, imageScene(asset.id), 0);
  expect((await remove(request(), params(asset.id))).status).toBe(409);
  await savePage(draft.id, 'PAGE_7', state.user!, createEmptyEditorScene(), 1);
  expect((await remove(request(), params(asset.id))).status).toBe(200);
  await expect(savePage(draft.id, 'PAGE_2', state.user!, imageScene(asset.id), 0)).rejects.toMatchObject({ status: 400 });
  expect((await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: draft.id, pageLabel: 'PAGE_2' } } })).revision).toBe(0);
});

it.each(['scene', 'element', 'pin', 'render', 'ai-output'] as const)('fails closed on malformed retained %s references', async source => {
  const asset = await accepted();
  const draft = await createDraft(state.user!.id, source === 'element');
  if (source === 'scene') await db.submissionPage.update({ where: { submissionId_pageLabel: { submissionId: draft.id, pageLabel: 'FRONT_COVER' } }, data: { sceneJson: '{broken' } });
  if (source === 'element') await db.templateElement.create({ data: { templateId: draft.id, pageLabel: 'FRONT_COVER', order: 0, elementJson: '{broken' } });
  if (source === 'pin') await db.submission.update({ where: { id: draft.id }, data: { pinnedTemplate: { pages: [] } } });
  if (source === 'render') await db.renderJob.create({ data: { submissionId: draft.id, status: 'FAILED', inputSnapshot: Prisma.DbNull } });
  if (source === 'ai-output') await db.aiBookJob.create({ data: { userId: state.user!.id, concept: 'fixture', status: 'FAILED', stageOutput: ['uncertain'] } });
  const response = await remove(request(), params(asset.id));
  expect(response.status).toBe(409);
  expect((await response.json()).error).toContain('could not be verified');
  expect((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).deletedAt).toBeNull();
  expect(state.objects.has(asset.s3Key)).toBe(true);
});

it('protects template artwork, frozen pins, and authorized reads after template edits and detachment', async () => {
  state.user = await createUser('ADMIN'); const admin = state.user;
  const asset = await accepted();
  const template = await createDraft(admin.id, true);
  await savePage(template.id, 'FRONT_COVER', admin, imageScene(asset.id), 0);
  expect((await remove(request(), params(asset.id))).status).toBe(409);
  await db.submission.update({ where: { id: template.id }, data: { status: 'APPROVED' } });
  state.user = await createUser(); const author = state.user;
  const result = await fromTemplate(request({ templateId: template.id }));
  expect(result.status).toBe(201);
  const id = (await result.json()).submission.id as string;
  const frozen = pinned(template.id, asset.id);
  await db.submission.update({ where: { id }, data: { pinnedTemplate: frozen as unknown as Prisma.InputJsonValue } });
  await savePage(template.id, 'FRONT_COVER', admin, createEmptyEditorScene(), 1);
  await db.submission.update({ where: { id: template.id }, data: { status: 'DRAFT' } });
  expect((await image(request(), params(asset.id))).status).toBe(200);
  const copy = await duplicateAsDraft(id, author);
  expect((await db.submission.findUniqueOrThrow({ where: { id: copy } })).pinnedTemplate).toEqual(frozen);
  state.user = admin;
  expect((await remove(request(), params(asset.id))).status).toBe(409);
  state.user = author;
  expect((await detach(request({ revision: 0, pageRevisions: Object.fromEntries(PAGE_LABELS.map(label => [label, 0])) }), bookParams(id))).status).toBe(200);
  expect((await image(request(), params(asset.id))).status).toBe(200);
  state.user = await createUser();
  expect((await image(request(), params(asset.id))).status).toBe(404);
});

it('preserves authorized legacy scene-stored template artwork without granting access to unpublished unrelated templates', async () => {
  state.user = await createUser('ADMIN'); const admin = state.user;
  const asset = await accepted(); const template = await createDraft(admin.id, true);
  await db.submissionPage.update({ where: { submissionId_pageLabel: { submissionId: template.id, pageLabel: 'FRONT_COVER' } }, data: { sceneJson: JSON.stringify(imageScene(asset.id)) } });
  await db.submission.update({ where: { id: template.id }, data: { status: 'APPROVED' } });
  state.user = await createUser(); const author = state.user;
  expect((await image(request(), params(asset.id))).status).toBe(200);
  expect((await fromTemplate(request({ templateId: template.id }))).status).toBe(201);
  await db.submission.update({ where: { id: template.id }, data: { status: 'DRAFT' } });
  expect((await image(request(), params(asset.id))).status).toBe(200);
  state.user = await createUser();
  expect((await image(request(), params(asset.id))).status).toBe(404);
  state.user = author;
  await db.submissionPage.update({ where: { submissionId_pageLabel: { submissionId: template.id, pageLabel: 'FRONT_COVER' } }, data: { sceneJson: '{broken' } });
  expect((await image(request(), params(asset.id))).status).toBe(404);
});

it.each(['advance', 'continue', 'complete'] as const)('protects retained AI pins at %s, including failed/completed history', async action => {
  const asset = await accepted();
  const { jobId } = await enqueueAiBookJob(state.user!.id, 'fixture');
  const job = (await claimAiBookJob())!;
  const output = { pinnedTemplate: pinned('historical-template', asset.id) };
  if (action === 'advance') expect(await advanceStage(job, AiBookStage.CONTENT, output)).toBe(true);
  if (action === 'continue') expect(await continueAiBook(job, { patch: output })).toBe('queued');
  if (action === 'complete') expect(await completeAiBook(job, output)).toBe(true);
  await db.aiBookJob.update({ where: { id: jobId }, data: { status: 'FAILED' } });
  expect((await remove(request(), params(asset.id))).status).toBe(409);
  await db.aiBookJob.update({ where: { id: jobId }, data: { stageOutput: Prisma.DbNull } });
  expect((await remove(request(), params(asset.id))).status).toBe(200);
  await db.aiBookJob.update({ where: { id: jobId }, data: { status: 'PROCESSING', claimToken: job.claimToken, leaseExpiresAt: new Date(Date.now() + 60_000) } });
  await expect(advanceStage(job, AiBookStage.CONTENT, output)).rejects.toMatchObject({ status: 400 });
});

it('retains render snapshots and actually renders their source after mutable scenes are cleared', async () => {
  const asset = await accepted();
  const draft = await createDraft(state.user!.id);
  await savePage(draft.id, 'FRONT_COVER', state.user!, imageScene(asset.id), 0);
  await enqueueRenderJob(draft.id, state.user!, { force: true });
  const job = (await claimRenderJob())!;
  await db.submissionPage.updateMany({ where: { submissionId: draft.id }, data: { sceneJson: JSON.stringify(createEmptyEditorScene()) } });
  expect((await remove(request(), params(asset.id))).status).toBe(409);
  await processRenderJob(job);
  const stored = await db.renderJob.findUniqueOrThrow({ where: { id: job.id } });
  expect(stored.status).toBe('COMPLETED');
  expect((await PDFDocument.load(state.objects.get(stored.pdfS3Key!)!)).getPageCount()).toBe(1);
  expect((await PDFDocument.load(state.objects.get(stored.readingPdfS3Key!)!)).getPageCount()).toBe(8);
  expect((await remove(request(), params(asset.id))).status).toBe(409);
}, 30000);

it.each(['instance', 'ai-job'] as const)('applies the same dependency guard to both template deletion routes (%s)', async relation => {
  state.user = await createUser('ADMIN');
  const template = await createDraft(state.user.id, true);
  if (relation === 'instance') {
    const draft = await createDraft(state.user.id);
    await db.submission.update({ where: { id: draft.id }, data: { templateId: template.id } });
  } else await db.aiBookJob.create({ data: { userId: state.user.id, concept: 'fixture', templateId: template.id, status: 'FAILED' } });
  for (const handler of [deleteDraft, deleteTemplate]) {
    const response = await handler(request(), bookParams(template.id));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('linked books or AI jobs');
  }
  expect(await db.submission.findUnique({ where: { id: template.id } })).not.toBeNull();
});

it.each(['submission-manifest', 'render-manifest', 'legacy-source'] as const)('protects source keys retained in %s', async kind => {
  const asset = await accepted(); const draft = await createDraft(state.user!.id);
  if (kind === 'submission-manifest') await db.submission.update({ where: { id: draft.id }, data: { aiManifest: { retainedSource: asset.s3Key } } });
  if (kind === 'legacy-source') await db.submissionImage.create({ data: { submissionId: draft.id, pageLabel: 'FRONT_COVER', order: 0, s3Key: asset.s3Key, originalFilename: 'fixture.png', mimeType: 'image/png' } });
  if (kind === 'render-manifest') {
    const { jobId } = await enqueueRenderJob(draft.id, state.user!);
    await db.renderJob.update({ where: { id: jobId }, data: { status: 'FAILED', artifactManifest: { retainedSource: asset.s3Key } } });
  }
  expect((await remove(request(), params(asset.id))).status).toBe(409);
  expect((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).deletedAt).toBeNull();
});

it('rehearses the additive migration on a preexisting old-shaped row without changing its original fields', async () => {
  const asset = await accepted();
  const sql = readFileSync(resolve('prisma/migrations/20261117190000_asset_soft_removal/migration.sql'), 'utf8');
  await db.$transaction(async tx => {
    // A temporary shadow avoids altering the shared test database's application table.
    await tx.$executeRaw`CREATE TEMP TABLE "Asset" (LIKE public."Asset" INCLUDING ALL) ON COMMIT DROP`;
    await tx.$executeRaw`ALTER TABLE pg_temp."Asset" DROP COLUMN "deletedAt"`;
    await tx.$executeRaw`INSERT INTO pg_temp."Asset" SELECT (json_populate_record(NULL::pg_temp."Asset", (to_jsonb(a) - 'deletedAt')::json)).* FROM public."Asset" a WHERE a."id" = ${asset.id}`;
    const before = await tx.$queryRaw<{ row: Prisma.JsonValue }[]>`SELECT to_jsonb(a) AS row FROM pg_temp."Asset" a`;
    await tx.$executeRawUnsafe(sql);
    const after = await tx.$queryRaw<{ row: Prisma.JsonValue; removed: Date | null }[]>`SELECT to_jsonb(a) - 'deletedAt' AS row, "deletedAt" AS removed FROM pg_temp."Asset" a`;
    expect(after[0].row).toEqual(before[0].row);
    expect(after[0].removed).toBeNull();
  });
  expect((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).s3Key).toBe(asset.s3Key);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function expectFenceWaiter() {
  await vi.waitFor(async () => {
    const rows = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 741001 AND objid = 1 AND NOT granted) AS waiting`;
    expect(rows[0].waiting).toBe(true);
  }, { timeout: 3000, interval: 20 });
}

it.each(['save-first', 'remove-first'] as const)('serializes removal against saving in both lock orders (%s)', async order => {
  const asset = await accepted(); const owner = state.user!;
  const draft = await createDraft(owner.id);
  const ready = deferred(); const release = deferred();
  const first = prisma.$transaction(async tx => {
    await lockAssetReferences(tx);
    if (order === 'save-first') {
      await tx.submissionPage.update({ where: { submissionId_pageLabel: { submissionId: draft.id, pageLabel: 'FRONT_COVER' } }, data: { sceneJson: JSON.stringify(imageScene(asset.id)) } });
    } else await removeAssetFromLibrary(tx, asset.id, owner.id);
    ready.resolve(); await release.promise;
  }, { timeout: 10000 });
  await ready.promise;
  const second = order === 'save-first'
    ? remove(request(), params(asset.id)).then(response => response.status)
    : savePage(draft.id, 'FRONT_COVER', owner, imageScene(asset.id), 0).then(() => 200, error => error.status);
  try { await expectFenceWaiter(); } finally { release.resolve(); }
  await first;
  expect(await second).toBe(order === 'save-first' ? 409 : 400);
  const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
  expect(Boolean(row.deletedAt)).toBe(order === 'remove-first');
});

it('holds the source fence throughout enqueue so retained input wins over removal', async () => {
  const asset = await accepted();
  const draft = await createDraft(state.user!.id);
  await savePage(draft.id, 'FRONT_COVER', state.user!, imageScene(asset.id), 0);
  const ready = deferred(); const release = deferred();
  const enqueue = prisma.$transaction(async tx => {
    const result = await enqueueInTransaction(tx, draft.id, state.user!, { force: true });
    ready.resolve(); await release.promise;
    return result;
  }, { timeout: 10000 });
  await ready.promise;
  const removal = remove(request(), params(asset.id));
  try { await expectFenceWaiter(); } finally { release.resolve(); }
  await enqueue;
  expect((await removal).status).toBe(409);
});

it('recovers a failed canonical write without accepting a mutable staging key', async () => {
  const source = await uploaded();
  vi.mocked(uploadToS3).mockRejectedValueOnce(new Error('Injected storage write failure'));
  expect((await register(request(source.body))).status).toBe(500);
  expect(await db.asset.count({ where: { id: source.id } })).toBe(0);
  const retried = await register(request(source.body));
  expect(retried.status).toBe(201);
  const asset = (await retried.json()).asset;
  expect(asset.id).toBe(source.id);
  expect(asset.s3Key).toContain('/canonical/');
  expect(state.objects.get(asset.s3Key)).toEqual(source.bytes);
});

it('legacy presigning cannot mint the canonical namespace or trust filename extensions', async () => {
  const url = new URL('http://localhost/api/upload/presign');
  for (const [key, value] of Object.entries({ filename: 'photo.exe', contentType: 'image/png', submissionId: 'canonical', pageLabel: 'FRONT_COVER' })) url.searchParams.set(key, value);
  expect((await legacyPresign(new NextRequest(url))).status).toBe(400);
  url.searchParams.set('submissionId', 'session-fixture');
  const response = await legacyPresign(new NextRequest(url));
  expect(response.status).toBe(200);
  expect((await response.json()).s3Key).toMatch(new RegExp(`^uploads/${state.user!.id}/session-fixture/FRONT_COVER-[a-f0-9-]+\\.png$`));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

it.each(['creation-first', 'deletion-first'] as const)('serializes template instances with deletion (%s)', async order => {
  state.user = await createUser('ADMIN'); const admin = state.user;
  const template = await createDraft(admin.id, true);
  await db.submission.update({ where: { id: template.id }, data: { status: 'APPROVED' } });
  const ready = deferred(); const release = deferred();
  const first = prisma.$transaction(async tx => {
    await lockSubmission(tx, template.id);
    if (order === 'creation-first') await createInstanceWithOverrides(admin, template.id, 'fixture', {}, { tx });
    else { await requireNoTemplateDependents(tx, template.id); await tx.submission.delete({ where: { id: template.id } }); }
    ready.resolve(); await release.promise;
  }, { timeout: 10000 });
  await ready.promise;
  const second = order === 'creation-first'
    ? deleteTemplate(request(), bookParams(template.id)) : fromTemplate(request({ templateId: template.id }));
  try { await expectFenceWaiter(); } finally { release.resolve(); }
  await first;
  expect((await second).status).toBe(order === 'creation-first' ? 409 : 404);
  expect(await db.submission.count({ where: { templateId: template.id } })).toBe(order === 'creation-first' ? 1 : 0);
});
