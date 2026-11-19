import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, createApprovedTemplateWithText, createUser, cleanupFixtures } from '../fixtures/database';
import { createEmptyEditorScene } from '@/lib/editor/schema';
import { createInstanceWithOverrides, mergedPages, savePage } from '@/lib/editor/submission-store';
import { textElement } from '../fixtures/scenes';
import { prisma } from '@/lib/prisma';
import { POST as duplicate } from '@/app/api/submissions/[id]/duplicate/route';

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string } }));
vi.mock('@/auth', () => ({ auth: async () => session.user ? { user: session.user } : null }));
vi.mock('@/lib/s3', () => ({ getPresignedDownloadUrl: vi.fn(async () => 'https://storage.example.invalid/test.pdf') }));

const request = () => new Request('http://localhost/test', { method: 'POST' });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  session.user = await createUser();
});
afterEach(async () => { await cleanupFixtures(); vi.unstubAllGlobals(); });
afterAll(async () => { await prisma.$disconnect(); await db.$disconnect(); });

/**
 * A finished AI book: an instance of a published template that QA approved,
 * with the artifacts an order would point at.
 */
async function approvedAiBook(ownerId: string) {
  const template = await createApprovedTemplateWithText(ownerId, [
    { pageLabel: 'FRONT_COVER', id: 'cover-title', text: 'Placeholder' },
  ]);
  const id = await createInstanceWithOverrides(
    { id: ownerId, role: 'USER' },
    template.id,
    'The Lighthouse',
    {},
  );
  const scene = { ...createEmptyEditorScene(), templateTextOverrides: { 'cover-title': 'The Lonely Lighthouse' } };
  await db.submissionPage.updateMany({
    where: { submissionId: id, pageLabel: 'FRONT_COVER' },
    data: { sceneJson: JSON.stringify(scene) },
  });
  await db.submission.update({ where: { id }, data: {
    status: 'APPROVED',
    pdfS3Key: 'renders/print.pdf',
    readingPdfS3Key: 'renders/reading.pdf',
    artifactManifest: { schemaVersion: 1 },
    revision: 4,
  } });
  return { template, id };
}

describe('POST /api/submissions/[id]/duplicate', () => {
  it('copies an approved book into a fresh draft and leaves the original intact', async () => {
    const { template, id } = await approvedAiBook(session.user!.id);

    const response = await duplicate(request(), params(id));
    expect(response.status).toBe(201);
    const { submission } = await response.json() as { submission: { id: string } };
    expect(submission.id).not.toBe(id);

    const copy = await db.submission.findUniqueOrThrow({
      where: { id: submission.id },
      include: { pages: { orderBy: { order: 'asc' } } },
    });
    expect(copy.status).toBe('DRAFT');
    expect(copy.userId).toBe(session.user!.id);
    expect(copy.title).toBe('The Lighthouse (copy)');
    expect(copy.templateId).toBe(template.id);
    expect(copy.aiGenerated).toBe(true);
    // Never inherit the approved artifacts: the copy has not been rendered.
    expect(copy.pdfS3Key).toBeNull();
    expect(copy.readingPdfS3Key).toBeNull();
    expect(copy.artifactManifest).toBeNull();
    expect(copy.revision).toBe(0);
    expect(copy.pages).toHaveLength(8);
    expect(JSON.parse(copy.pages.find(page => page.pageLabel === 'FRONT_COVER')!.sceneJson))
      .toMatchObject({ templateTextOverrides: { 'cover-title': 'The Lonely Lighthouse' } });

    const original = await db.submission.findUniqueOrThrow({ where: { id } });
    expect(original.status).toBe('APPROVED');
    expect(original.pdfS3Key).toBe('renders/print.pdf');
    expect(original.revision).toBe(4);
  });

  it('refuses a book owned by another account', async () => {
    const { id } = await approvedAiBook((await createUser()).id);

    const response = await duplicate(request(), params(id));
    expect(response.status).toBe(403);
    expect(await db.submission.count({ where: { title: 'The Lighthouse (copy)' } })).toBe(0);
  });

  it('refuses to copy a template', async () => {
    const { template } = await approvedAiBook(session.user!.id);

    const response = await duplicate(request(), params(template.id));
    expect(response.status).toBe(400);
  });

  it('copies an instance whose live template text slots changed so stale overrides can be fixed', async () => {
    const { template, id } = await approvedAiBook(session.user!.id);
    // The admin replaces the cover text slot; the instance override now points
    // at an element that no longer exists in the live template.
    const admin = await createUser('ADMIN');
    await savePage(template.id, 'FRONT_COVER', admin, {
      ...createEmptyEditorScene(),
      elements: [textElement('replacement-slot', 'A new cover slot')],
    }, 0);
    const source = await db.submission.findUniqueOrThrow({ where: { id } });
    // The merged render rejects the stale override...
    await expect(prisma.$transaction(tx => mergedPages(tx, source))).rejects.toMatchObject({ status: 400 });
    // ...but opening a copy to repair it must not be blocked by that check.
    const response = await duplicate(request(), params(id));
    expect(response.status).toBe(201);
    const copyId = (await response.json() as { submission: { id: string } }).submission.id;
    const copyCover = await db.submissionPage.findUniqueOrThrow({
      where: { submissionId_pageLabel: { submissionId: copyId, pageLabel: 'FRONT_COVER' } },
    });
    expect(JSON.parse(copyCover.sceneJson).templateTextOverrides).toEqual({ 'cover-title': 'The Lonely Lighthouse' });
    expect((await db.submission.findUniqueOrThrow({ where: { id } })).status).toBe('APPROVED');
  });
});
