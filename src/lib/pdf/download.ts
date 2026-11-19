import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { headS3Object, openS3Object } from '@/lib/s3';
import { artifactFilename, parseArtifactManifest, type ArtifactKind } from './artifacts';

export const privatePdfHeaders = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Accept',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
type Actor = { id: string; role?: string };
class PdfDownloadError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Native link failures are visible pages, not JSON files accidentally saved as PDFs. */
export function pdfErrorResponse(request: Request, status: number, message: string): NextResponse {
  if (!request.headers.get('accept')?.includes('text/html')) {
    return NextResponse.json({ error: message }, { status, headers: privatePdfHeaders });
  }
  const url = new URL(request.url);
  const retry = escapeHtml(url.pathname + url.search);
  return new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PDF unavailable — Titchybooks</title><style>body{font:16px system-ui;color:#182333;background:#f5fafb;margin:0;padding:2rem}main{max-width:40rem;margin:4rem auto;background:white;border:1px solid #dbe6eb;border-radius:1rem;padding:2rem}a{display:inline-block;margin:1rem 1rem 0 0;color:#008ca8}h1{font-size:1.5rem}</style></head><body><main><h1>PDF unavailable</h1><p role="alert">${escapeHtml(message)}</p><p>No completed download is confirmed. If a transfer failed, check your browser downloads and retry.</p><a href="${retry}">Retry PDF request</a><a href="/dashboard">Back to dashboard</a>${status === 401 ? '<a href="/login">Sign in</a>' : ''}</main></body></html>`, {
    status,
    headers: {
      ...privatePdfHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    },
  });
}

function options(request: Request): { kind: ArtifactKind; disposition: 'inline' | 'attachment' } {
  const query = new URL(request.url).searchParams;
  const kind = query.get('kind');
  if (kind !== 'print' && kind !== 'reading') throw new PdfDownloadError(400, 'Specify ?kind=print or ?kind=reading.');
  const disposition = query.get('disposition') ?? 'attachment';
  if (disposition !== 'attachment' && disposition !== 'inline') throw new PdfDownloadError(400, 'Specify attachment download or inline preview.');
  return { kind, disposition };
}

/**
 * Validate transfer options before any lookup so a malformed query fails fast
 * with 400 instead of surfacing as a job/book state error. Returns null when
 * the query is valid.
 */
export function pdfQueryErrorResponse(request: Request): NextResponse | null {
  try { options(request); return null; }
  catch (cause) {
    if (cause instanceof PdfDownloadError) return pdfErrorResponse(request, cause.status, cause.message);
    throw cause;
  }
}

function pdfSuccessHeaders(kind: ArtifactKind, disposition: 'inline' | 'attachment', size: number, title: string | null) {
  return {
    ...privatePdfHeaders,
    'Content-Type': 'application/pdf',
    'Content-Length': String(size),
    'Content-Disposition': `${disposition}; filename="${artifactFilename(kind, title)}"`,
  };
}

/** Fresh authorization for every transfer; approved masters are only read, never regenerated. */
export async function submissionPdfResponse(request: Request, id: string, actor: Actor | null, method: 'GET' | 'HEAD' = 'GET'): Promise<NextResponse> {
  let body: Awaited<ReturnType<typeof openS3Object>>['body'] | undefined;
  try {
    if (!actor?.id) throw new PdfDownloadError(401, 'Sign in to request this PDF.');
    const { kind, disposition } = options(request);
    const submission = await prisma.submission.findUnique({
      where: { id },
      select: { id: true, userId: true, title: true, status: true, revision: true, pdfS3Key: true, readingPdfS3Key: true, artifactManifest: true },
    });
    if (!submission) throw new PdfDownloadError(404, 'This book could not be found.');
    const admin = actor.role === 'ADMIN';
    if (submission.userId !== actor.id && !admin) throw new PdfDownloadError(403, 'You do not have access to this book.');
    if (submission.status !== 'APPROVED' && !admin) throw new PdfDownloadError(403, 'This book has not been approved for download.');
    const key = kind === 'print' ? submission.pdfS3Key : submission.readingPdfS3Key;
    if (!key) throw new PdfDownloadError(409, kind === 'print'
      ? 'The print sheet is not available for this book.'
      : 'The reading PDF is unavailable for this book. Its print sheet, if available, can still be downloaded.');
    const manifest = parseArtifactManifest(submission.artifactManifest);
    // Null manifests are historical facts. A malformed or mismatched manifest is not.
    if (submission.artifactManifest !== null && (!manifest || manifest.submissionId !== id || manifest.submissionRevision !== submission.revision || manifest[kind].s3Key !== key)) {
      throw new PdfDownloadError(409, 'The PDF does not match its published artifact record. Please contact support.');
    }
    const descriptor = manifest?.[kind];
    if (method === 'HEAD') {
      // Metadata-only transfer: HEAD must never open the object body, or every
      // probe would pull the whole PDF out of storage.
      const head = await headS3Object(key);
      if (!head) throw new PdfDownloadError(404, 'The stored PDF is missing. Please contact support; retrying will not regenerate or replace an approved master.');
      if (!Number.isSafeInteger(head.size) || !head.size || head.size < 0 || (descriptor && head.size !== descriptor.bytes)) {
        throw new PdfDownloadError(502, 'The stored PDF length could not be verified. Please retry or contact support.');
      }
      return new NextResponse(null, { headers: pdfSuccessHeaders(kind, disposition, head.size, submission.title) });
    }
    let object: Awaited<ReturnType<typeof openS3Object>>;
    try { object = await openS3Object(key, request.signal); }
    catch (cause) {
      const error = cause as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        throw new PdfDownloadError(404, 'The stored PDF is missing. Please contact support; retrying will not regenerate or replace an approved master.');
      }
      throw cause;
    }
    body = object.body;
    if (!Number.isSafeInteger(object.size) || !object.size || object.size < 0 || (descriptor && object.size !== descriptor.bytes)) {
      throw new PdfDownloadError(502, 'The stored PDF length could not be verified. Please retry or contact support.');
    }
    const size = object.size;
    const source = object.body;
    const iterator = source[Symbol.asyncIterator]();
    const hash = descriptor ? createHash('sha256') : null;
    let received = 0;
    let pending: Uint8Array | undefined;
    let finished = false;
    const stop = () => { source.destroy(); };
    request.signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => { request.signal.removeEventListener('abort', stop); source.destroy(); };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (request.signal.aborted) throw new Error('PDF request canceled');
          // Hold the final chunk until length and (when known) checksum pass.
          // A corrupt or interrupted source must not look like a complete HTTP transfer.
          while (!finished) {
            const next = await iterator.next();
            if (finished) return; // Consumer cancellation can occur while awaiting storage.
            if (request.signal.aborted) throw new Error('PDF request canceled');
            if (next.done) {
              finished = true;
              if (received !== size || (descriptor && hash!.digest('hex') !== descriptor.sha256)) throw new Error('Incomplete or changed PDF transfer');
              if (pending) controller.enqueue(pending);
              controller.close();
              cleanup();
              return;
            }
            const bytes = new Uint8Array(next.value);
            received += bytes.byteLength;
            if (received > size) throw new Error('PDF transfer exceeds its advertised length');
            hash?.update(bytes);
            const previous = pending;
            pending = bytes;
            if (previous) { controller.enqueue(previous); return; }
          }
        } catch {
          finished = true;
          cleanup();
          console.error(JSON.stringify({ event: 'pdf-transfer-failed', submissionId: id, kind }));
          controller.error(new Error('The PDF transfer failed. Check browser downloads and retry.'));
        }
      },
      cancel() { finished = true; cleanup(); },
    }, { highWaterMark: 0 });
    return new NextResponse(stream, { headers: pdfSuccessHeaders(kind, disposition, size, submission.title) });
  } catch (cause) {
    body?.destroy();
    if (cause instanceof PdfDownloadError) return pdfErrorResponse(request, cause.status, cause.message);
    console.error(JSON.stringify({ event: 'pdf-request-failed', submissionId: id }));
    return pdfErrorResponse(request, 503, 'The PDF request could not be started. Please retry.');
  }
}
