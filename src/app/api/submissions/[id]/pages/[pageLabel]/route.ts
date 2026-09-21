import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { editorPageLabelSchema, parseEditorScene } from '@/lib/editor/schema';
import { errorResponse, savePage, SubmissionError } from '@/lib/editor/submission-store';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string; pageLabel: string }> };

export async function GET(_request: Request, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { id, pageLabel } = await params;
    const label = editorPageLabelSchema.parse(pageLabel);
    const submission = await prisma.submission.findUnique({ where: { id } });
    if (!submission) throw new SubmissionError(404, 'Not found');
    if (submission.userId !== session.user.id && session.user.role !== 'ADMIN') throw new SubmissionError(403, 'Forbidden');
    const page = await prisma.submissionPage.findUnique({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: label } } });
    if (!page) throw new SubmissionError(404, 'Page not found');
    const templateId = submission.isTemplate ? id : submission.templateId;
    const templateElements = templateId ? await prisma.templateElement.findMany({
      where: { templateId, pageLabel: label }, orderBy: { order: 'asc' },
      select: { pageLabel: true, elementJson: true },
    }) : [];
    return NextResponse.json({ page: { ...page, scene: parseEditorScene(page.sceneJson) }, templateElements });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { id, pageLabel } = await params;
    const label = editorPageLabelSchema.parse(pageLabel);
    const body = z.object({ scene: z.unknown(), revision: z.number().int().nonnegative() }).parse(await request.json());
    const page = await savePage(id, label, { id: session.user.id, role: session.user.role }, body.scene, body.revision);
    return NextResponse.json({ page });
  } catch (error) { return errorResponse(error); }
}
