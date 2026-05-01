import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";

// GET /api/templates/public - List published templates for users
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const templates = await prisma.submission.findMany({
    where: {
      isTemplate: true,
      status: SubmissionStatus.APPROVED,
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const result = templates.map((t) => ({
    id: t.id,
    title: t.title,
    previewImage: null as string | null, // TODO: generate preview images
    createdAt: t.createdAt.toISOString(),
  }));

  return NextResponse.json({ templates: result });
}
