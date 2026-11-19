import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { pdfErrorResponse, submissionPdfResponse } from '@/lib/pdf/download';

export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

/**
 * GET /api/ai/books/:id/downloads?kind=print|reading
 *
 * One authorization point for both deliverables. It checks the job belongs to
 * the caller, the book is approved and the requested artifact actually exists,
 * then delegates the transfer to the shared submission PDF service. Existing
 * AI links stay compatible and authorize every new request.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return pdfErrorResponse(request, 401, 'Sign in to request this PDF.');
    }

    const { id } = await params;
    const job = await prisma.aiBookJob.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, submissionId: true },
    });
    if (!job) {
      return pdfErrorResponse(request, 404, 'This book could not be found.');
    }
    const isAdmin = session.user.role === "ADMIN";
    if (job.userId !== session.user.id && !isAdmin) {
      return pdfErrorResponse(request, 403, 'You do not have access to this book.');
    }
    if (job.status !== "COMPLETED" || !job.submissionId) {
      return pdfErrorResponse(request, 409, 'This book is not finished yet.');
    }

    return await submissionPdfResponse(request, job.submissionId, { id: session.user.id, role: session.user.role });
  } catch {
    return pdfErrorResponse(request, 503, 'The PDF request could not be started. Please retry.');
  }
}
