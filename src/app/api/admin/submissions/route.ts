import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getPresignedDownloadUrl } from "@/lib/s3";

export const dynamic = "force-dynamic";


export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  const where = status ? { status } : {};

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
      const pdfDownloadUrl = sub.pdfS3Key
        ? await getPresignedDownloadUrl(sub.pdfS3Key)
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
      };
    })
  );

  return NextResponse.json({ submissions: submissionsWithUrls });
}
