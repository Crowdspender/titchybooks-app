import { auth } from '@/auth';
import { pdfErrorResponse, submissionPdfResponse } from '@/lib/pdf/download';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    const { id } = await params;
    return await submissionPdfResponse(request, id, session?.user?.id ? { id: session.user.id, role: session.user.role } : null);
  } catch {
    return pdfErrorResponse(request, 503, 'The PDF request could not be started. Please retry.');
  }
}

// Explicit HEAD: without it Next delegates to GET and streams the whole PDF
// out of storage just to discard the body.
export async function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    const { id } = await params;
    return await submissionPdfResponse(request, id, session?.user?.id ? { id: session.user.id, role: session.user.role } : null, 'HEAD');
  } catch {
    return pdfErrorResponse(request, 503, 'The PDF request could not be started. Please retry.');
  }
}
