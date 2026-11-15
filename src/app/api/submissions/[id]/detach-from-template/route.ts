import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { PAGE_LABELS } from '@/lib/constants';
import { errorResponse, lockSubmission, requireEditable, requireRevision, mergedPages, SubmissionError } from '@/lib/editor/submission-store';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { id } = await params;
    const body = z.object({ revision: z.number().int().nonnegative(), pageRevisions: z.record(z.enum(PAGE_LABELS), z.number().int().nonnegative()) }).parse(await request.json());
    const submission = await prisma.$transaction(async tx => {
      const current = await lockSubmission(tx, id, { id: session.user.id!, role: session.user.role });
      requireEditable(current);
      requireRevision(current.revision, body.revision);
      if (!current.templateId) throw new SubmissionError(400, 'This submission has no template');
      const pages = await mergedPages(tx, current);
      for (const page of pages) {
        const existing = await tx.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: page.pageLabel } } });
        requireRevision(existing.revision, body.pageRevisions[page.pageLabel]);
        const scene = { version: page.scene.version, page: page.scene.page, elements: page.scene.elements };
        await tx.submissionPage.update({ where: { id: existing.id }, data: { sceneJson: JSON.stringify(scene), revision: { increment: 1 } } });
      }
      // The pages now carry every element, so the pin is dead weight — and an
      // active one: applying it on top of the materialized scenes would render
      // each element twice.
      return tx.submission.update({ where: { id }, data: {
        templateId: null, templateVersion: null, pinnedTemplate: Prisma.JsonNull, revision: { increment: 1 },
      }, include: { pages: true } });
    });
    return NextResponse.json({ success: true, submission });
  } catch (error) { return errorResponse(error); }
}
