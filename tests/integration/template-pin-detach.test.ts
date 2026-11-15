import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { cleanupFixtures, createApprovedTemplateWithText, createUser, db } from '../fixtures/database';
import { textElement } from '../fixtures/scenes';
import { buildPinnedTemplate, buildTemplateManifest, type PinnedTemplate } from '@/lib/ai/template-contract';
import { createInstanceWithOverrides, duplicateAsDraft, mergedPages, savePage } from '@/lib/editor/submission-store';
import { prisma } from '@/lib/prisma';
import { captureSnapshot } from '@/lib/pdf/snapshot';
import { editorSceneSchema } from '@/lib/editor/schema';
import { POST as detachFromTemplate } from '@/app/api/submissions/[id]/detach-from-template/route';

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string } }));
vi.mock('@/auth', () => ({ auth: async () => session.user ? { user: session.user } : null }));

const COVER_SLOT = 'cover-title';
const GENERATED_TITLE = 'The Lonely Lighthouse';

beforeEach(async () => {
  session.user = await createUser();
});
afterEach(async () => {
  await cleanupFixtures();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await prisma.$disconnect();
  await db.$disconnect();
});

/**
 * An AI book exactly as the pipeline composes it: an instance of a published
 * template that carries its own frozen copy of the template scenes (the pin)
 * and the generated text as a per-page override.
 */
async function pinnedAiBook(ownerId: string, roomyCover = false) {
  const template = await createApprovedTemplateWithText(ownerId, [
    { pageLabel: 'FRONT_COVER', id: COVER_SLOT, text: 'Placeholder title' },
  ]);
  const elements = [{ ...textElement(COVER_SLOT, 'Placeholder title'), ...(roomyCover ? { width: 580, height: 240 } : {}) }];
  const manifest = buildTemplateManifest({
    templateId: template.id,
    templateVersion: template.version,
    pages: [{ pageLabel: 'FRONT_COVER', elements }],
  });
  const pinned = buildPinnedTemplate({
    templateId: template.id,
    templateVersion: template.version,
    manifest,
    pages: [{ pageLabel: 'FRONT_COVER', elements }],
  });
  const id = await createInstanceWithOverrides(
    { id: ownerId, role: 'USER' },
    template.id,
    'The Lighthouse',
    { FRONT_COVER: { [COVER_SLOT]: GENERATED_TITLE } },
    { pinnedTemplate: pinned },
  );
  return { template, pinned, id };
}

/** The render snapshot for every page — what the editor and the PDF writer see. */
async function mergedFor(id: string) {
  const submission = await db.submission.findUniqueOrThrow({ where: { id } });
  return prisma.$transaction((tx) => mergedPages(tx, submission));
}

function elementIds(merged: Awaited<ReturnType<typeof mergedFor>>) {
  return merged.flatMap((page) => page.scene.elements.map((element) => element.id));
}

/** Drive the real detach route with the revisions it insists on. */
async function detach(id: string) {
  const submission = await db.submission.findUniqueOrThrow({ where: { id }, include: { pages: true } });
  const body = {
    revision: submission.revision,
    pageRevisions: Object.fromEntries(submission.pages.map((page) => [page.pageLabel, page.revision])),
  };
  return detachFromTemplate(
    new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** Put a detached book back into the state the old detach route left behind. */
async function restoreStalePin(id: string, pinned: PinnedTemplate) {
  await db.submission.update({
    where: { id },
    data: { templateId: null, pinnedTemplate: pinned as unknown as Prisma.InputJsonValue },
  });
}

describe('pinned template layer', () => {
  it('is replaced by the materialized scenes when a book is detached', async () => {
    const { pinned, id } = await pinnedAiBook(session.user!.id);

    // While attached, the pin supplies the locked layer and the override the copy.
    const attached = await mergedFor(id);
    expect(elementIds(attached)).toEqual([COVER_SLOT]);
    const cover = attached.find((page) => page.pageLabel === 'FRONT_COVER')!;
    expect(cover.scene.elements.find((element) => element.id === COVER_SLOT))
      .toMatchObject({ type: 'text', text: GENERATED_TITLE });
    // While attached the generated text lives in the override map, not the slot.
    const sourcePage = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
    expect(JSON.parse(sourcePage.sceneJson).templateTextOverrides).toEqual({ [COVER_SLOT]: GENERATED_TITLE });

    const response = await detach(id);
    expect(response.status).toBe(200);
    const { submission: updated } = await response.json() as {
      submission: { templateId: string | null; pinnedTemplate: unknown };
    };
    expect(updated.templateId).toBeNull();
    // An active pin on top of the materialized pages would duplicate every element.
    expect(updated.pinnedTemplate).toBeNull();

    const detached = await mergedFor(id);
    expect(elementIds(detached)).toEqual([COVER_SLOT]);
    const detachedCover = detached.find((page) => page.pageLabel === 'FRONT_COVER')!;
    // The generated text survived detaching because it was baked into the element.
    expect(detachedCover.scene.elements.find((element) => element.id === COVER_SLOT))
      .toMatchObject({ type: 'text', text: GENERATED_TITLE });
    // The override map is gone: the text is now part of the element itself.
    expect(detachedCover.scene.templateTextOverrides).toBeUndefined();
    expect(pinned.pages[0].elements).toHaveLength(1);
  });

  it('is ignored when a detached book still carries a stale pin', async () => {
    const { pinned, id } = await pinnedAiBook(session.user!.id);
    expect((await detach(id)).status).toBe(200);
    await restoreStalePin(id, pinned);

    // The bug: mergedPages() used to apply the pin on top of the materialized
    // pages, yielding two `cover-title` elements per page.
    const merged = await mergedFor(id);
    const ids = elementIds(merged);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([COVER_SLOT]);
  });

  it('is not copied onto a new draft when the source is detached', async () => {
    const { pinned, id } = await pinnedAiBook(session.user!.id);
    expect((await detach(id)).status).toBe(200);
    await restoreStalePin(id, pinned);

    const copyId = await duplicateAsDraft(id, { id: session.user!.id, role: 'USER' });
    const copy = await db.submission.findUniqueOrThrow({ where: { id: copyId } });
    expect(copy.templateId).toBeNull();
    expect(copy.pinnedTemplate).toBeNull();
    const ids = elementIds(await mergedFor(copyId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('saves strict styling, preserves it through copying and detaches it exactly once', async () => {
    const { id } = await pinnedAiBook(session.user!.id, true);
    const actor = { id: session.user!.id, role: 'USER' };
    const page = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
    const source = editorSceneSchema.parse(JSON.parse(page.sceneJson));
    const styled = { ...source, design: { version: 1 as const, presetId: 'classic' as const, presetVersion: 1 as const }, templateStyleOverrides: { [COVER_SLOT]: { fontSize: 40, italic: true } } };
    await expect(savePage(id, 'FRONT_COVER', actor, { ...styled, templateStyleOverrides: { [COVER_SLOT]: { x: 999 } } }, page.revision)).rejects.toThrow();
    await expect(savePage(id, 'PAGE_2', actor, styled, 0)).rejects.toThrow();
    await savePage(id, 'FRONT_COVER', actor, styled, page.revision);
    await expect(savePage(id, 'FRONT_COVER', actor, styled, page.revision)).rejects.toThrow();
    const attached = await mergedFor(id);
    expect(attached[0].scene.elements[0]).toMatchObject({ italic: true, fontSize: 40, typographyVersion: 1, text: GENERATED_TITLE });
    const copyId = await duplicateAsDraft(id, actor);
    expect(await mergedFor(copyId)).toEqual(attached);
    const submission = await db.submission.findUniqueOrThrow({ where: { id } });
    const { input } = await prisma.$transaction(tx => captureSnapshot(tx, submission, actor));
    expect(input.version === 2 && input.typography?.version).toBe(1);
    expect((await detach(id)).status).toBe(200);
    expect(await mergedFor(id)).toEqual(attached);
    const detachedPage = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
    expect(JSON.parse(detachedPage.sceneJson).templateStyleOverrides).toBeUndefined();
  });

  it('blocks guided overflow even with image-DPI force enabled', async () => {
    const { id } = await pinnedAiBook(session.user!.id);
    const actor = { id: session.user!.id, role: 'USER' };
    const page = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
    const source = editorSceneSchema.parse(JSON.parse(page.sceneJson));
    await savePage(id, 'FRONT_COVER', actor, { ...source, templateStyleOverrides: { [COVER_SLOT]: { fontSize: 120 } }, templateTextOverrides: { [COVER_SLOT]: 'A very long title '.repeat(30) } }, page.revision);
    const submission = await db.submission.findUniqueOrThrow({ where: { id } });
    await expect(prisma.$transaction(tx => captureSnapshot(tx, submission, actor, true))).rejects.toThrow('overflows');
  });

  it('reports an unqualified guided font as a print validation error', async () => {
    const { id } = await pinnedAiBook(session.user!.id, true);
    expect((await detach(id)).status).toBe(200);
    const actor = { id: session.user!.id, role: 'USER' };
    const page = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
    const source = editorSceneSchema.parse(JSON.parse(page.sceneJson));
    const elements = source.elements.map(element => element.type === 'text'
      ? { ...element, typographyVersion: 1 as const, fontFamily: 'Unqualified' } : element);
    await savePage(id, 'FRONT_COVER', actor, { ...source, elements }, page.revision);
    const submission = await db.submission.findUniqueOrThrow({ where: { id } });
    await expect(prisma.$transaction(tx => captureSnapshot(tx, submission, actor, true)))
      .rejects.toMatchObject({ status: 422, message: 'Unqualified font: Unqualified' });
  });

  it('is copied onto a new draft when the source is still attached', async () => {
    const { template, id } = await pinnedAiBook(session.user!.id);

    const copyId = await duplicateAsDraft(id, { id: session.user!.id, role: 'USER' });
    const copy = await db.submission.findUniqueOrThrow({ where: { id: copyId } });
    expect(copy.templateId).toBe(template.id);
    expect(copy.pinnedTemplate).not.toBeNull();

    const merged = await mergedFor(copyId);
    const ids = elementIds(merged);
    expect(new Set(ids).size).toBe(ids.length);
    expect(merged.find((page) => page.pageLabel === 'FRONT_COVER')!
      .scene.elements.find((element) => element.id === COVER_SLOT))
      .toMatchObject({ type: 'text', text: GENERATED_TITLE });
  });
});
