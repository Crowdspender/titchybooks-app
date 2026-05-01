import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getPresignedDownloadUrl } from "@/lib/s3";

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
    },
    orderBy: { createdAt: "desc" },
  });

  // Generate presigned URLs for PDFs
  const submissionsWithUrls = await Promise.all(
    submissions.map(async (sub) => ({
      ...sub,
      pdfDownloadUrl: sub.pdfS3Key
        ? await getPresignedDownloadUrl(sub.pdfS3Key)
        : null,
    }))
  );

  return NextResponse.json({ submissions: submissionsWithUrls });
}
