import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { canAccessAssetViaTemplate as templateAssetAccess } from "@/lib/editor/submission-store";
import { downloadFromS3 } from "@/lib/s3";
import { MAX_FILE_SIZE } from "@/lib/constants";

export const dynamic = "force-dynamic";
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' };


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
  return templateAssetAccess(prisma, assetId, userId);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: privateHeaders });
  }

  const { assetId } = await params;

  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
  });

  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: privateHeaders });
  }

  const isOwner = asset.userId === session.user.id;
  const isAdmin = session.user.role === "ADMIN";

  if (!isOwner && !isAdmin) {
    const allowedViaTemplate = await canAccessAssetViaTemplate(
      assetId,
      session.user.id,
    );
    if (!allowedViaTemplate) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: privateHeaders });
    }
  }

  try {
    // Fetch from S3
    const buffer = await downloadFromS3(asset.s3Key, { maxBytes: MAX_FILE_SIZE });

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        ...privateHeaders,
        "Content-Type": asset.mimeType || "image/jpeg",
        "Content-Length": String(buffer.length),
      },
    });
  } catch (error) {
    console.error("Error serving asset:", error);
    return NextResponse.json({ error: "Failed to load asset" }, { status: 500, headers: privateHeaders });
  }
}
