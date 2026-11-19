import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';
import { imageElement, sceneWithText, textElement } from '../fixtures/scenes';
import { PAGE_LABELS } from '@/lib/constants';
import { createEmptyEditorScene } from '@/lib/editor/schema';
import { canAccessAssetViaTemplate, savePage, saveTitle } from '@/lib/editor/submission-store';
import { claimRenderJob, enqueueRenderJob, failRender, heartbeat, processRenderJob, publishRender } from '@/lib/pdf/render-job';
import { parseRenderSnapshot } from '@/lib/pdf/snapshot';
import type { RenderArtifacts } from '@/lib/pdf/render-output';
import { prisma } from '@/lib/prisma';
import { uploadToS3 } from '@/lib/s3';
import { PRINT_SHEET_FILENAME, READING_PDF_FILENAME, parseArtifactManifest, verifyArtifact } from '@/lib/pdf/artifacts';
import { POST as create } from '@/app/api/submissions/route';
import { GET as load, PATCH as title } from '@/app/api/submissions/[id]/route';
import { PUT as page } from '@/app/api/submissions/[id]/pages/[pageLabel]/route';
import { POST as submit } from '@/app/api/submissions/[id]/submit/route';
import { POST as retry } from '@/app/api/submissions/[id]/pdf/route';
import { POST as detach } from '@/app/api/submissions/[id]/detach-from-template/route';
import { GET as status } from '@/app/api/submissions/[id]/render-status/route';
import { PATCH as moderate } from '@/app/api/admin/submissions/[id]/route';
import { DELETE as deleteTemplate } from '@/app/api/admin/templates/[id]/route';

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string } }));
vi.mock('@/auth', () => ({ auth: async () => session.user ? { user: session.user } : null }));
vi.mock('@/lib/s3', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3');
  const { default: sharp } = await import('sharp');
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
  return {
  ...actual,
  downloadFromS3: vi.fn(async () => image),
  uploadToS3: vi.fn(async () => {}),
  getPresignedDownloadUrl: vi.fn(async () => 'https://storage.example.invalid/test.pdf'),
  // POST /api/submissions HEAD-verifies every uploaded key before accepting
  // it; tests default to a small, present object (individual cases override).
  headS3Object: vi.fn(async () => ({ size: 1024, contentType: 'image/png' })),
  buildRenderAttemptPrefix: (user: string, submission: string, job: string, attempt: number, token: string) =>
    `renders/${user}/${submission}/${job}/${attempt}-${token}`,
  };
});
vi.mock('@/lib/email', () => ({ sendWelcomeEmail: vi.fn(), sendPasswordResetEmail: vi.fn() }));
const request = (body?: unknown) => new Request('http://localhost/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const pageParams = (id: string, pageLabel = 'FRONT_COVER') => ({ params: Promise.resolve({ id, pageLabel }) });
const descriptor = (s3Key: string) => ({
  s3Key,
  bytes: 1024,
  sha256: 'a'.repeat(64),
  contentType: 'application/pdf',
  pageCount: 1,
  widthPt: 841.89,
  heightPt: 595.28,
});
const artifacts: RenderArtifacts = {
  pdfS3Key: 'test/output.pdf',
  readingPdfS3Key: 'test/reading.pdf',
  previews: [{ pageLabel: 'FRONT_COVER' as const, s3Key: 'test/front.png' }],
  artifactManifest: {
    schemaVersion: 1,
    submissionId: 'test-submission',
    submissionRevision: 0,
    renderJobId: 'test-render-job',
    printProfile: 'titchybook-single-sheet-rgb-v2',
    templateId: null,
    templateVersion: null,
    title: null,
    createdAt: new Date(0).toISOString(),
    print: descriptor('test/output.pdf'),
    reading: descriptor('test/reading.pdf'),
  },
};

beforeEach(async () => {
  expect(await db.renderJob.count({ where: { status: { in: ['QUEUED', 'PROCESSING'] } } })).toBe(0);
  session.user = await createUser();
  vi.mocked(uploadToS3).mockImplementation(async () => {});
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External HTTP is forbidden in integration tests'); }));
});
afterEach(async () => { await cleanupFixtures(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await prisma.$disconnect(); await db.$disconnect(); });

async function queued() {
  const draft = await createDraft(session.user!.id);
  const result = await enqueueRenderJob(draft.id, session.user!);
  return { draft, result };
}
async function expire(id: string) {
  await db.renderJob.update({ where: { id }, data: { leaseExpiresAt: new Date(0) } });
}
async function due(id: string) {
  await db.renderJob.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
}

describe('editor API and transactional submission', () => {
  it.each([undefined, '', '   ', 'short', 'x'.repeat(1001)])('requires bounded correction guidance before rejection (%s)', async rejectionReason => {
    const draft = await createDraft(session.user!.id);
    await db.submission.update({ where: { id: draft.id }, data: { status: 'PENDING', pdfS3Key: 'retained/master.pdf' } });
    session.user = await createUser('ADMIN');
    expect((await moderate(request({ action: 'REJECT', rejectionReason }), params(draft.id))).status).toBe(400);
    expect((await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('PENDING');
  });

  it('serializes conflicting approval/rejection and preserves review/artifact evidence on replay', async () => {
    const draft = await createDraft(session.user!.id);
    await db.submission.update({ where: { id: draft.id }, data: { status: 'PENDING', pdfS3Key: 'retained/master.pdf', readingPdfS3Key: 'retained/reading.pdf' } });
    session.user = await createUser('ADMIN');
    const results = await Promise.all([
      moderate(request({ action: 'APPROVE' }), params(draft.id)),
      moderate(request({ action: 'REJECT', rejectionReason: '  Please correct the cover text.  ' }), params(draft.id)),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const reviewed = await db.submission.findUniqueOrThrow({ where: { id: draft.id } });
    expect(reviewed.rejectionReason).toBe(reviewed.status === 'REJECTED' ? 'Please correct the cover text.' : null);
    expect((await moderate(request({ action: 'REJECT', rejectionReason: 'Replace original review evidence' }), params(draft.id))).status).toBe(409);
    expect(await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(reviewed);
    expect(reviewed.pdfS3Key).toBe('retained/master.pdf');
    expect(reviewed.readingPdfS3Key).toBe('retained/reading.pdf');
  });

  it('rejects a downgraded administrator despite the stale ADMIN session claim', async () => {
    const draft = await createDraft(session.user!.id);
    await db.submission.update({ where: { id: draft.id }, data: { status: 'PENDING', pdfS3Key: 'retained/master.pdf' } });
    session.user = await createUser('ADMIN');
    await db.user.update({ where: { id: session.user.id }, data: { role: 'USER' } });
    expect((await moderate(request({ action: 'APPROVE' }), params(draft.id))).status).toBe(403);
    expect((await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('PENDING');
  });

  it('creates eight pages, saves unique content, reloads, and freezes on submit', async () => {
    const created = await create(request({ mode: 'EDITOR', title: 'Eight pages' }));
    expect(created.status).toBe(201);
    const id = (await created.json()).submission.id as string;
    for (const label of PAGE_LABELS) {
      const saved = await page(request({ scene: sceneWithText(label), revision: 0 }), pageParams(id, label));
      expect(saved.status).toBe(200);
      expect((await saved.json()).page.revision).toBe(1);
    }
    const savedTitle = await title(request({ title: 'Complete', revision: 0 }), params(id));
    expect(savedTitle.status).toBe(200);
    const reopened = await (await load(request(), params(id))).json();
    expect(reopened.submission.title).toBe('Complete');
    expect(reopened.submission.pages).toHaveLength(8);
    for (const p of reopened.submission.pages) expect(p.scene).toEqual(sceneWithText(p.pageLabel));
    expect((await page(request({ scene: sceneWithText('stale'), revision: 0 }), pageParams(id))).status).toBe(409);
    expect((await title(request({ title: 'stale', revision: 0 }), params(id))).status).toBe(409);
    const submitted = await submit(request(), params(id));
    expect(submitted.status).toBe(202);
    const jobId = (await submitted.json()).jobId;
    expect((await (await submit(request(), params(id))).json()).jobId).toBe(jobId);
    expect(await db.renderJob.count({ where: { submissionId: id } })).toBe(1);
    expect((await page(request({ scene: sceneWithText('late'), revision: 1 }), pageParams(id))).status).toBe(409);
    expect((await title(request({ title: 'late', revision: 1 }), params(id))).status).toBe(409);
    expect((await detach(request({ revision: 1, pageRevisions: Object.fromEntries(PAGE_LABELS.map(label => [label, 1])) }), params(id))).status).toBe(409);
    session.user = await createUser('ADMIN');
    expect((await moderate(request({ action: 'APPROVE' }), params(id))).status).toBe(409);
  });

  it('rejects unauthenticated/foreign writes and retry, and inaccessible images', async () => {
    const owner = session.user!;
    const draft = await createDraft(owner.id);
    const other = await createUser();
    const asset = await db.asset.create({ data: { userId: other.id, s3Key: `test/${other.id}`, originalFilename: 'test.png', mimeType: 'image/png', fileSize: 100, width: 2000, height: 2000 } });
    const scene = { ...createEmptyEditorScene(), elements: [imageElement(asset.id)] };
    expect((await page(request({ scene, revision: 0 }), pageParams(draft.id))).status).toBe(403);
    session.user = other;
    expect((await page(request({ scene: createEmptyEditorScene(), revision: 0 }), pageParams(draft.id))).status).toBe(403);
    expect((await retry(request(), params(draft.id))).status).toBe(403);
    expect((await status(request(), params(draft.id))).status).toBe(403);
    session.user = null;
    expect((await submit(request(), params(draft.id))).status).toBe(401);
  });

  it('rolls back invalid eight-page input without enqueueing', async () => {
    const draft = await createDraft(session.user!.id);
    await db.submissionPage.delete({ where: { submissionId_pageLabel: { submissionId: draft.id, pageLabel: 'PAGE_7' } } });
    expect((await submit(request(), params(draft.id))).status).toBe(400);
    expect(await db.renderJob.count()).toBe(0);
    expect((await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
  });

  it('enforces scene limits and requires confirmation for hard DPI failures', async () => {
    const draft = await createDraft(session.user!.id);
    const oversized = { ...createEmptyEditorScene(), elements: Array.from({ length: 101 }, (_, i) => textElement(`text-${i}`)) };
    expect((await page(request({ scene: oversized, revision: 0 }), pageParams(draft.id))).status).toBe(400);
    const asset = await db.asset.create({ data: { userId: session.user!.id, s3Key: `test/${draft.id}`, originalFilename: 'tiny.png', mimeType: 'image/png', width: 10, height: 10, fileSize: 100 } });
    await savePage(draft.id, 'FRONT_COVER', session.user!, { ...createEmptyEditorScene(), elements: [imageElement(asset.id)] }, 0);
    const blocked = await submit(request(), params(draft.id));
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).canForce).toBe(true);
    expect(await db.renderJob.count({ where: { submissionId: draft.id } })).toBe(0);
    expect((await submit(request({ force: true }), params(draft.id))).status).toBe(202);
  });

  it('preserves a referenced template on deletion and ignores malformed unrelated asset usages', async () => {
    const admin = await createUser('ADMIN');
    const template = await createDraft(admin.id, true);
    await db.submission.update({ where: { id: template.id }, data: { status: 'APPROVED' } });
    await db.templateElement.create({ data: { templateId: template.id, pageLabel: 'FRONT_COVER', order: 0, elementJson: 'not json' } });
    const draft = await createDraft(session.user!.id);
    await db.submission.update({ where: { id: draft.id }, data: { templateId: template.id } });
    expect(await db.$transaction(tx => canAccessAssetViaTemplate(tx, 'missing', session.user!.id))).toBe(false);
    session.user = admin;
    expect((await deleteTemplate(request(), params(template.id))).status).toBe(409);
    expect(await db.templateElement.count({ where: { templateId: template.id } })).toBe(1);
  });

  it('serializes save against submit, so the snapshot cannot diverge', async () => {
    const draft = await createDraft(session.user!.id);
    const changed = sceneWithText('racing save');
    const [save, enqueue] = await Promise.allSettled([
      savePage(draft.id, 'FRONT_COVER', session.user!, changed, 0),
      enqueueRenderJob(draft.id, session.user!),
    ]);
    expect(enqueue.status).toBe('fulfilled');
    const stored = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: draft.id, pageLabel: 'FRONT_COVER' } } });
    const job = await db.renderJob.findFirstOrThrow({ where: { submissionId: draft.id } });
    expect(parseRenderSnapshot(job.inputSnapshot).pages[0].scene).toEqual(JSON.parse(stored.sceneJson));
    if (save.status === 'rejected') expect(save.reason.status).toBe(409);
  });

  it('freezes authorized template assets and text overrides across later edits', async () => {
    const admin = await createUser('ADMIN');
    const template = await createDraft(admin.id, true);
    const asset = await db.asset.create({ data: { userId: admin.id, s3Key: `test/${admin.id}`, originalFilename: 'test.png', mimeType: 'image/png', fileSize: 100, width: 2000, height: 2000 } });
    await savePage(template.id, 'FRONT_COVER', admin, { ...createEmptyEditorScene(), elements: [textElement('template-text', 'Original'), imageElement(asset.id)] }, 0);
    await db.submission.update({ where: { id: template.id }, data: { status: 'APPROVED' } });
    const draft = await createDraft(session.user!.id);
    await db.submission.update({ where: { id: draft.id }, data: { templateId: template.id, templateVersion: 2 } });
    await savePage(draft.id, 'FRONT_COVER', session.user!, { ...createEmptyEditorScene(), templateTextOverrides: { 'template-text': 'Personalized' } }, 0);
    const result = await enqueueRenderJob(draft.id, session.user!);
    await savePage(template.id, 'FRONT_COVER', admin, sceneWithText('Changed template'), 1);
    const input = parseRenderSnapshot((await db.renderJob.findUniqueOrThrow({ where: { id: result.jobId } })).inputSnapshot);
    expect(input.pages[0].scene.elements[0]).toMatchObject({ text: 'Personalized' });
    expect(input.assets).toHaveLength(1);
    expect(input.assets[0].s3Key).toBe(asset.s3Key);
  });

  it('applies overrides when detaching and advances all revisions', async () => {
    const template = await createDraft(session.user!.id, true);
    await savePage(template.id, 'FRONT_COVER', session.user!, sceneWithText('heading'), 0);
    const draft = await createDraft(session.user!.id);
    await db.submission.update({ where: { id: draft.id }, data: { templateId: template.id } });
    await savePage(draft.id, 'FRONT_COVER', session.user!, { ...createEmptyEditorScene(), templateTextOverrides: { heading: 'Detached text' } }, 0);
    const pageRevisions = Object.fromEntries(PAGE_LABELS.map(label => [label, label === 'FRONT_COVER' ? 1 : 0]));
    const response = await detach(request({ revision: 0, pageRevisions }), params(draft.id));
    expect(response.status).toBe(200);
    const reopened = await (await load(request(), params(draft.id))).json();
    expect(reopened.submission.templateId).toBeNull();
    expect(reopened.submission.revision).toBe(1);
    expect(reopened.submission.pages[0].scene.elements[0].text).toBe('Detached text');
    expect(reopened.submission.pages.every((p: { revision: number }) => p.revision > 0)).toBe(true);
  });
});

describe('durable worker', () => {
  it('deduplicates enqueue and claims concurrently without duplication', async () => {
    const { draft } = await queued();
    const results = await Promise.all(Array.from({ length: 5 }, () => enqueueRenderJob(draft.id, session.user!)));
    expect(new Set(results.map(result => result.jobId)).size).toBe(1);
    await queued();
    const claims = await Promise.all([claimRenderJob(), claimRenderJob(), claimRenderJob()]);
    expect(claims.filter(Boolean)).toHaveLength(2);
    expect(new Set(claims.filter(Boolean).map(job => job!.id)).size).toBe(2);
    expect(claims.filter(Boolean).every(job => job!.attempts === 1)).toBe(true);
  });

  it('recovers expired leases and fences stale heartbeat, publication, and failure', async () => {
    await queued();
    const old = (await claimRenderJob())!;
    expect(await heartbeat(old)).toBe(true);
    await expire(old.id);
    expect(await publishRender(old, artifacts)).toBe(false);
    const current = (await claimRenderJob())!;
    expect(current.attempts).toBe(2);
    expect(current.claimToken).not.toBe(old.claimToken);
    expect(await heartbeat(old)).toBe(false);
    expect(await failRender(old)).toBe(false);
    expect(await publishRender(current, artifacts)).toBe(true);
    expect(await publishRender(old, { ...artifacts, pdfS3Key: 'stale.pdf' })).toBe(false);
    const submission = await db.submission.findUniqueOrThrow({ where: { id: old.submissionId } });
    expect(submission.status).toBe('PENDING');
    expect(submission.pdfS3Key).toBe(artifacts.pdfS3Key);
    const visible = await (await status(request(), params(submission.id))).json();
    expect(visible).toMatchObject({ submissionStatus: 'PENDING', jobStatus: 'COMPLETED', pdfUrl: null });
    session.user = await createUser('ADMIN');
    expect((await moderate(request({ action: 'APPROVE' }), params(submission.id))).status).toBe(200);
    expect((await (await status(request(), params(submission.id))).json()).pdfUrl).toBe(`/api/submissions/${submission.id}/downloads?kind=print`);
  });

  it.each([READING_PDF_FILENAME, PRINT_SHEET_FILENAME])('never publishes when %s upload fails, then retries under a new fence', async failedFilename => {
    const { draft } = await queued();
    const uploaded = new Map<string, Buffer>();
    vi.mocked(uploadToS3).mockImplementation(async (key, bytes) => {
      if (key.endsWith(failedFilename)) throw new Error('Injected storage failure');
      uploaded.set(key, Buffer.from(bytes));
    });
    const first = (await claimRenderJob())!;
    await processRenderJob(first);
    const incomplete = await db.submission.findUniqueOrThrow({ where: { id: draft.id }, include: { pages: true } });
    expect(incomplete).toMatchObject({ status: 'PROCESSING', pdfS3Key: null, readingPdfS3Key: null, artifactManifest: null });
    expect(incomplete.pages.every(page => page.previewS3Key === null)).toBe(true);
    expect((await db.renderJob.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('QUEUED');
    expect((await (await status(request(), params(draft.id))).json()).ready).toBe(false);
    if (failedFilename === PRINT_SHEET_FILENAME) expect([...uploaded.keys()].some(key => key.endsWith(READING_PDF_FILENAME))).toBe(true);
    vi.mocked(uploadToS3).mockImplementation(async (key, bytes) => { uploaded.set(key, Buffer.from(bytes)); });
    await due(first.id);
    const second = (await claimRenderJob())!;
    expect(second.claimToken).not.toBe(first.claimToken);
    expect(second.inputSnapshot).toEqual(first.inputSnapshot);
    await processRenderJob(second);
    const completed = await db.submission.findUniqueOrThrow({ where: { id: draft.id }, include: { pages: true } });
    expect(completed.status).toBe('PENDING');
    expect(completed.pdfS3Key).toContain(`/2-${second.claimToken}/`);
    expect(completed.readingPdfS3Key).toContain(`/2-${second.claimToken}/`);
    expect(completed.pages.every(page => page.previewS3Key?.includes(`/2-${second.claimToken}/`))).toBe(true);
    const published = parseArtifactManifest(completed.artifactManifest)!;
    expect(published.submissionId).toBe(draft.id);
    expect(published.renderJobId).toBe(second.id);
    expect(await verifyArtifact('print', published.print, uploaded.get(completed.pdfS3Key!)!)).toEqual([]);
    expect(await verifyArtifact('reading', published.reading, uploaded.get(completed.readingPdfS3Key!)!)).toEqual([]);
    expect(await failRender(first)).toBe(false);
    expect(await publishRender(first, artifacts)).toBe(false);
    expect((await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).pdfS3Key).toBe(completed.pdfS3Key);
  }, 60000);

  it.each(['pdfS3Key', 'readingPdfS3Key'])('rejects incomplete publication with missing %s', async key => {
    const { draft } = await queued();
    const job = (await claimRenderJob())!;
    await expect(publishRender(job, { ...artifacts, [key]: '' })).rejects.toThrow('incomplete artifact set');
    expect((await db.renderJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PROCESSING');
    expect((await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).pdfS3Key).toBeNull();
  });

  it('preserves low-DPI blocking, explicit force, and the retained source snapshot', async () => {
    const draft = await createDraft(session.user!.id);
    const asset = await db.asset.create({ data: { userId: session.user!.id, s3Key: `assets/${session.user!.id}/low.png`, mimeType: 'image/png', originalFilename: 'low.png', fileSize: 100, width: 8, height: 8 } });
    const scene = createEmptyEditorScene();
    scene.elements.push(imageElement(asset.id));
    await savePage(draft.id, 'FRONT_COVER', session.user!, scene, 0);
    await expect(enqueueRenderJob(draft.id, session.user!)).rejects.toMatchObject({ status: 422 });
    expect(await db.renderJob.count({ where: { submissionId: draft.id } })).toBe(0);
    const forced = await enqueueRenderJob(draft.id, session.user!, { force: true });
    expect(forced.dpiWarnings).toEqual([expect.objectContaining({ severity: 'error' })]);
    const frozen = parseRenderSnapshot((await db.renderJob.findUniqueOrThrow({ where: { id: forced.jobId } })).inputSnapshot);
    expect(frozen.assets).toEqual([expect.objectContaining({ id: asset.id, s3Key: asset.s3Key, width: 8, height: 8 })]);
  });

  it('delays retries, exhausts three attempts, and opens a deduplicated new cycle', async () => {
    const { draft } = await queued();
    const render = vi.fn().mockRejectedValue(new Error('provider secret must not escape'));
    let originalInput: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = (await claimRenderJob())!;
      originalInput = job.inputSnapshot;
      await processRenderJob(job, render);
      const stored = await db.renderJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(stored.attempts).toBe(attempt);
      expect(stored.errorMessage).not.toContain('provider secret');
      if (attempt < 3) {
        expect(stored.status).toBe('QUEUED');
        expect(stored.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(attempt === 1 ? 3000 : 28000);
        expect(await claimRenderJob()).toBeNull();
        await due(job.id);
      } else expect(stored.status).toBe('FAILED');
    }
    expect((await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('FAILED');
    const responses = await Promise.all([retry(request(), params(draft.id)), retry(request(), params(draft.id))]);
    expect(responses.every(response => response.status === 202)).toBe(true);
    const ids = await Promise.all(responses.map(async response => (await response.json()).jobId));
    expect(ids[0]).toBe(ids[1]);
    const newest = await db.renderJob.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(newest.attempts).toBe(0);
    expect(newest.inputSnapshot).toEqual(originalInput);
  });

  it('fails a crashed final attempt without rendering a fourth time', async () => {
    const { result } = await queued();
    await db.renderJob.update({ where: { id: result.jobId }, data: { attempts: 3, status: 'PROCESSING', leaseExpiresAt: new Date(0) } });
    const job = (await claimRenderJob())!;
    expect(job.exhausted).toBe(true);
    const render = vi.fn();
    await processRenderJob(job, render);
    expect(render).not.toHaveBeenCalled();
    expect((await db.renderJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
  });

  it('captures historical interrupted input once and leaves completed history alone', async () => {
    const { result } = await queued();
    await db.renderJob.update({ where: { id: result.jobId }, data: { inputSnapshot: Prisma.DbNull } });
    const render = vi.fn<NonNullable<Parameters<typeof processRenderJob>[1]>>(async () => artifacts);
    await processRenderJob((await claimRenderJob())!, render);
    expect(render).toHaveBeenCalledOnce();
    const stored = await db.renderJob.findUniqueOrThrow({ where: { id: result.jobId } });
    expect(parseRenderSnapshot(stored.inputSnapshot).pages).toHaveLength(8);
    expect(await claimRenderJob()).toBeNull();
  });

  it('treats malformed historical scenes as terminal input errors', async () => {
    const { draft, result } = await queued();
    await db.renderJob.update({ where: { id: result.jobId }, data: { inputSnapshot: Prisma.DbNull } });
    await db.submissionPage.update({ where: { submissionId_pageLabel: { submissionId: draft.id, pageLabel: 'FRONT_COVER' } }, data: { sceneJson: 'invalid' } });
    const render = vi.fn();
    await processRenderJob((await claimRenderJob())!, render);
    expect(render).not.toHaveBeenCalled();
    expect((await db.renderJob.findUniqueOrThrow({ where: { id: result.jobId } })).status).toBe('FAILED');
  });

  it('terminates invalid immutable input and uses unique output attempt prefixes', async () => {
    const { result } = await queued();
    await db.renderJob.update({ where: { id: result.jobId }, data: { inputSnapshot: { version: 99 } } });
    const render = vi.fn<NonNullable<Parameters<typeof processRenderJob>[1]>>(async () => artifacts);
    await processRenderJob((await claimRenderJob())!, render);
    expect(render).not.toHaveBeenCalled();
    expect((await db.renderJob.findUniqueOrThrow({ where: { id: result.jobId } })).status).toBe('FAILED');
    await queued();
    const job = (await claimRenderJob())!;
    await processRenderJob(job, render);
    expect(render.mock.calls[0][1]).toContain(`${job.id}/1-${job.claimToken}`);
  });

  it('queues legacy uploads atomically and keeps them raster in vector mode', async () => {
    vi.stubEnv('VECTOR_RENDER', 'true');
    const images = PAGE_LABELS.map((pageLabel, order) => ({ pageLabel, order, s3Key: `uploads/${session.user!.id}/${order}.png`, originalFilename: 'test.png', mimeType: 'image/png' }));
    const created = await create(request({ images }));
    expect(created.status).toBe(202);
    const job = (await claimRenderJob())!;
    const input = parseRenderSnapshot(job.inputSnapshot);
    expect(input.mode).toBe('LEGACY_UPLOAD');
    expect(input.renderer).toBe('raster');
    expect(input.images).toHaveLength(8);
    expect(input.images.every(image => image.s3Key.startsWith(`uploads/${session.user!.id}/canonical/`))).toBe(true);
    expect((await create(request({ images: images.map(image => ({ ...image, s3Key: 'uploads/other/key' })) }))).status).toBe(403);
    await expect(saveTitle(job.submissionId, session.user!, 'changed', 0)).rejects.toMatchObject({ status: 409 });
  });
});
