import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";
import { s3Client } from "@/lib/s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export const dynamic = "force-dynamic";


// Authorization ladder (any of the following grants access):
//   1. Caller owns the asset.
//   2. Caller is an ADMIN.
//   3. The asset is referenced by a TemplateElement whose parent template is
//      APPROVED (publicly usable) or the caller owns an instance of it.
// This mirrors the access model of /api/templates/[id]/elements so that
// template image elements authored by an admin can be rendered by any user
// who is legitimately viewing the template.
async function canAccessAssetViaTemplate(
  assetId: string,
  userId: string,
): Promise<boolean> {
  // SQLite substring match on the JSON payload of TemplateElement.
  const usages = await prisma.templateElement.findMany({
    where: {
      elementJson: { contains: `"assetId":"${assetId}"` },
    },
    select: {
      templateId: true,
      template: { select: { status: true, isTemplate: true } },
    },
  });

  if (usages.length === 0) return false;

  const templateIds = new Set<string>();
  for (const usage of usages) {
    if (!usage.template?.isTemplate) continue;
    if (usage.template.status === SubmissionStatus.APPROVED) {
      return true;
    }
    templateIds.add(usage.templateId);
  }

  if (templateIds.size === 0) return false;

  const ownedInstance = await prisma.submission.findFirst({
    where: {
      userId,
      templateId: { in: Array.from(templateIds) },
    },
    select: { id: true },
  });

  return !!ownedInstance;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { assetId } = await params;

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
  });

  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const isOwner = asset.userId === session.user.id;
  const isAdmin = session.user.role === "ADMIN";

  if (!isOwner && !isAdmin) {
    const allowedViaTemplate = await canAccessAssetViaTemplate(
      assetId,
      session.user.id,
    );
    if (!allowedViaTemplate) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  try {
    // Fetch from S3
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: asset.s3Key,
    });

    const response = await s3Client.send(command);
    const stream = response.Body as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    const buffer = Buffer.concat(chunks);

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": asset.mimeType || "image/jpeg",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("Error serving asset:", error);
    return NextResponse.json({ error: "Failed to load asset" }, { status: 500 });
  }
}
