import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getPresignedDownloadUrl } from "@/lib/s3";
import { artifactFilename, type ArtifactKind } from "@/lib/pdf/artifacts";

export const dynamic = "force-dynamic";

const KINDS: readonly ArtifactKind[] = ["print", "reading"];

/**
 * GET /api/ai/books/:id/downloads?kind=print|reading
 *
 * One authorization point for both deliverables. It checks the job belongs to
 * the caller, the book is approved and the requested artifact actually exists,
 * then redirects to a freshly signed URL. Because the link is minted per click,
 * an expired URL is fixed by clicking again instead of by re-polling.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kind = new URL(request.url).searchParams.get("kind") as ArtifactKind | null;
  if (!kind || !KINDS.includes(kind)) {
    return NextResponse.json(
      { error: 'Specify ?kind=print or ?kind=reading.' },
      { status: 400 },
    );
  }

  const { id } = await params;
  const job = await prisma.aiBookJob.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true, submissionId: true },
  });
  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const isAdmin = session.user.role === "ADMIN";
  if (job.userId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (job.status !== "COMPLETED" || !job.submissionId) {
    return NextResponse.json({ error: "This book is not finished yet." }, { status: 409 });
  }

  const submission = await prisma.submission.findUnique({
    where: { id: job.submissionId },
    select: {
      id: true,
      userId: true,
      title: true,
      status: true,
      pdfS3Key: true,
      readingPdfS3Key: true,
    },
  });
  if (!submission) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (submission.userId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Customers only ever receive approved artifacts. Admins can still fetch the
  // private proof of a book that failed approval.
  if (submission.status !== "APPROVED" && !isAdmin) {
    return NextResponse.json(
      { error: "This book has not been approved for download." },
      { status: 403 },
    );
  }

  const s3Key = kind === "print" ? submission.pdfS3Key : submission.readingPdfS3Key;
  if (!s3Key) {
    return NextResponse.json(
      {
        error:
          kind === "reading"
            ? "This book was produced before reading PDFs existed, so only the print sheet is available."
            : "The print sheet for this book is not available.",
      },
      { status: 409 },
    );
  }

  const url = await getPresignedDownloadUrl(s3Key, {
    filename: artifactFilename(kind, submission.title),
  });
  return NextResponse.redirect(url, { status: 302 });
}
