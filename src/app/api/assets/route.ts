import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { ACCEPTED_IMAGE_TYPES, MAX_FILE_SIZE } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { getPresignedDownloadUrl } from "@/lib/s3";

const createAssetSchema = z.object({
  s3Key: z.string().min(1),
  originalFilename: z.string().min(1),
  mimeType: z.enum(ACCEPTED_IMAGE_TYPES),
  fileSize: z.number().int().positive().max(MAX_FILE_SIZE),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const assets = await prisma.asset.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  const assetsWithUrls = await Promise.all(
    assets.map(async (asset) => ({
      ...asset,
      // Use our proxy endpoint to avoid CORS issues
      downloadUrl: `/api/assets/${asset.id}/image`,
      previewUrl: `/api/assets/${asset.id}/image`,
    }))
  );

  return NextResponse.json({ assets: assetsWithUrls });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = createAssetSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    if (!parsed.data.s3Key.startsWith(`assets/${session.user.id}/`)) {
      return NextResponse.json(
        { error: "Invalid asset storage key" },
        { status: 400 }
      );
    }

    const asset = await prisma.asset.create({
      data: {
        userId: session.user.id,
        s3Key: parsed.data.s3Key,
        originalFilename: parsed.data.originalFilename,
        mimeType: parsed.data.mimeType,
        fileSize: parsed.data.fileSize,
        width: parsed.data.width,
        height: parsed.data.height,
      },
    });

    const downloadUrl = await getPresignedDownloadUrl(asset.s3Key);

    return NextResponse.json(
      { asset: { ...asset, downloadUrl } },
      { status: 201 }
    );
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
