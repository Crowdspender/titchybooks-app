import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";

export const dynamic = "force-dynamic";


// POST /api/admin/templates/[id]/publish - Publish a template
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const existing = await prisma.submission.findUnique({
    where: { id },
    select: { id: true, isTemplate: true, status: true, version: true },
  });

  if (!existing || !existing.isTemplate) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const template = await prisma.submission.update({
    where: { id },
    data: {
      status: SubmissionStatus.APPROVED,
      publishedAt: new Date(),
      version: existing.version + 1,
    },
  });

  return NextResponse.json({
    template: {
      id: template.id,
      status: template.status,
      version: template.version,
    },
  });
}
