import type { Prisma, Submission } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { editorElementSchema, editorSceneSchema, type EditorScene } from './schema';
import { PAGE_LABELS, type PageLabel } from '@/lib/constants';

export type Actor = { id: string; role: string };
export type Transaction = Prisma.TransactionClient;
export class SubmissionError extends Error {
  constructor(public status: number, message: string, public details: Record<string, unknown> = {}) {
    super(message);
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof SubmissionError) {
    return Response.json({ error: error.message, ...error.details }, { status: error.status });
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return Response.json({ error: 'Invalid editor content' }, { status: 400 });
  }
  console.error('Submission operation failed');
  return Response.json({ error: 'Unable to save this operation. Please retry.' }, { status: 500 });
}

// All scene and lifecycle writers take this lock before reading mutable state.
export async function lockSubmission(tx: Transaction, id: string, actor?: Actor) {
  await tx.$queryRaw`SELECT "id" FROM "Submission" WHERE "id" = ${id} FOR UPDATE`;
  const submission = await tx.submission.findUnique({ where: { id } });
  if (!submission) throw new SubmissionError(404, 'Submission not found');
  if (actor && submission.userId !== actor.id && actor.role !== 'ADMIN') {
    throw new SubmissionError(403, 'Forbidden');
  }
  return submission;
}
export function requireEditable(submission: Submission) {
  if (!submission.isTemplate && submission.status !== 'DRAFT') {
    throw new SubmissionError(409, 'This submission is no longer editable');
  }
}
export function requireRevision(actual: number, expected: number) {
  if (actual !== expected) throw new SubmissionError(409,
    'A newer version was saved in another tab. Your local edits have been preserved. Reload to reconcile.',
    { revision: actual });
}

export async function canAccessAssetViaTemplate(tx: Transaction, assetId: string, userId: string) {
  const usages = await tx.templateElement.findMany({
    where: { template: { isTemplate: true, OR: [
      { status: 'APPROVED' }, { instances: { some: { userId } } },
    ] } },
    select: { elementJson: true },
  });
  return usages.some(({ elementJson }) => {
    try {
      const parsed = editorElementSchema.safeParse(JSON.parse(elementJson));
      return parsed.success && parsed.data.type === 'image' && parsed.data.assetId === assetId;
    } catch { return false; }
  });
}

export async function validateSceneAssets(tx: Transaction, scenes: EditorScene[], actor: Actor) {
  const ids = [...new Set(scenes.flatMap(scene => scene.elements.flatMap(el => el.type === 'image' ? [el.assetId] : [])))];
  const assets = await tx.asset.findMany({ where: { id: { in: ids } } });
  if (assets.length !== ids.length) throw new SubmissionError(400, 'An image is missing. Replace it before saving.');
  for (const asset of assets) {
    if (asset.userId !== actor.id && actor.role !== 'ADMIN' &&
        !await canAccessAssetViaTemplate(tx, asset.id, actor.id)) {
      throw new SubmissionError(403, 'An image is not accessible to this account');
    }
  }
  return assets;
}

export async function mergedPages(tx: Transaction, submission: Submission) {
  const pages = await tx.submissionPage.findMany({ where: { submissionId: submission.id }, orderBy: { order: 'asc' } });
  if (pages.length !== 8 || PAGE_LABELS.some(label => !pages.some(page => page.pageLabel === label))) {
    throw new SubmissionError(400, 'All eight unique pages are required');
  }
  const templateId = submission.isTemplate ? submission.id : submission.templateId;
  // Lock the template too, so a multi-page edit cannot change the frozen input mid-snapshot.
  if (templateId && templateId !== submission.id) await lockSubmission(tx, templateId);
  const rows = templateId ? await tx.templateElement.findMany({ where: { templateId }, orderBy: { order: 'asc' } }) : [];
  return pages.map(page => {
    const scene = editorSceneSchema.parse(JSON.parse(page.sceneJson));
    const elements = rows.filter(row => row.pageLabel === page.pageLabel).map(row => editorElementSchema.parse(JSON.parse(row.elementJson)));
    const overrides = scene.templateTextOverrides ?? {};
    for (const key of Object.keys(overrides)) {
      if (!elements.some(el => el.id === key && el.type === 'text')) throw new SubmissionError(400, 'Template text has changed; reopen this draft.');
    }
    const merged = editorSceneSchema.parse({ ...scene, elements: [
      ...elements.map(el => el.type === 'text' && overrides[el.id] !== undefined ? { ...el, text: overrides[el.id] } : el),
      ...scene.elements,
    ] });
    if (new Set(merged.elements.map(el => el.id)).size !== merged.elements.length) {
      throw new SubmissionError(400, 'Duplicate element identifiers');
    }
    return { pageLabel: page.pageLabel as PageLabel, scene: merged };
  });
}

export async function saveTitle(id: string, actor: Actor, title: string | null, revision: number) {
  return prisma.$transaction(async tx => {
    const submission = await lockSubmission(tx, id, actor);
    requireEditable(submission);
    requireRevision(submission.revision, revision);
    return tx.submission.update({ where: { id }, data: { title, revision: { increment: 1 } } });
  });
}

export async function savePage(id: string, label: PageLabel, actor: Actor, input: unknown, revision: number) {
  const scene = editorSceneSchema.parse(input);
  if (new Set(scene.elements.map(el => el.id)).size !== scene.elements.length) throw new SubmissionError(400, 'Duplicate element identifiers');
  return prisma.$transaction(async tx => {
    const submission = await lockSubmission(tx, id, actor);
    requireEditable(submission);
    if (submission.mode !== 'EDITOR' && !submission.isTemplate) throw new SubmissionError(400, 'Not an editor draft');
    const page = await tx.submissionPage.findUnique({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: label } } });
    if (!page) throw new SubmissionError(404, 'Page not found');
    requireRevision(page.revision, revision);
    await validateSceneAssets(tx, [scene], actor);
    let stored = scene;
    if (submission.isTemplate) {
      await tx.templateElement.deleteMany({ where: { templateId: id, pageLabel: label } });
      await tx.templateElement.createMany({ data: scene.elements.map((el, order) => ({
        templateId: id, pageLabel: label, order, elementJson: JSON.stringify(el),
      })) });
      stored = { version: scene.version, page: scene.page, elements: [] };
      await tx.submission.update({ where: { id }, data: { version: { increment: 1 } } });
    } else if (submission.templateId) {
      await lockSubmission(tx, submission.templateId);
      const rows = await tx.templateElement.findMany({ where: { templateId: submission.templateId, pageLabel: label } });
      const elements = rows.map(row => editorElementSchema.parse(JSON.parse(row.elementJson)));
      if (elements.length + scene.elements.length > 100 || scene.elements.some(el => elements.some(te => te.id === el.id))) {
        throw new SubmissionError(400, 'Template element collision or per-page limit exceeded');
      }
      for (const key of Object.keys(scene.templateTextOverrides ?? {})) {
        if (!elements.some(el => el.id === key && el.type === 'text')) throw new SubmissionError(400, 'Invalid template text override');
      }
    } else {
      stored = { version: scene.version, page: scene.page, elements: scene.elements };
    }
    return tx.submissionPage.update({ where: { id: page.id }, data: {
      sceneJson: JSON.stringify(stored), revision: { increment: 1 },
    } });
  }, { timeout: 15000 });
}
