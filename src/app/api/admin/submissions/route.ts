import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { SubmissionStatus, VALID_STATUSES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { artifactAvailability } from "@/lib/pdf/artifacts";
import { getPresignedDownloadUrl } from "@/lib/s3";

export const dynamic = "force-dynamic";


export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const requestedStatus = searchParams.get("status");
  // Spot-check view: AI books that were auto-approved and sampled for review.
  const spotCheck = searchParams.get("spotCheck") === "true";

  // Reject unknown filters instead of letting Prisma fail on the enum column.
  const status = requestedStatus
    ? VALID_STATUSES.find((value) => value === requestedStatus)
    : undefined;
  if (requestedStatus && !status) {
    return NextResponse.json(
      { error: "Unknown status", allowed: VALID_STATUSES },
      { status: 400 }
    );
  }

  const where: Prisma.SubmissionWhereInput = spotCheck
    ? { qaSampled: true, status: SubmissionStatus.APPROVED }
    : status
      ? { status }
      : {};

  const submissions = await prisma.submission.findMany({
    where,
    include: {
      user: { select: { id: true, email: true, name: true } },
      images: { orderBy: { order: "asc" } },
      pages: { orderBy: { order: "asc" }, select: { pageLabel: true, order: true, previewS3Key: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Generate presigned URLs for PDFs and page previews
  const submissionsWithUrls = await Promise.all(
    submissions.map(async (sub) => {
      // Advertise only artifacts the download route's manifest rules accept;
      // raw key presence alone can promise a transfer that would 409.
      const artifacts = artifactAvailability(sub);
      const pdfDownloadUrl = artifacts.printSheet
        ? `/api/submissions/${encodeURIComponent(sub.id)}/downloads?kind=print`
        : null;

      const pagePreviews = await Promise.all(
        sub.pages.map(async (page) => ({
          pageLabel: page.pageLabel,
          order: page.order,
          previewUrl: page.previewS3Key
            ? await getPresignedDownloadUrl(page.previewS3Key)
            : null,
        }))
      );

      return {
        ...sub,
        pdfDownloadUrl,
        pagePreviews,
        artifacts: { printSheet: artifacts.printSheet, readingPdf: artifacts.readingPdf },
      };
    })
  );

  return NextResponse.json({ submissions: submissionsWithUrls }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
}
