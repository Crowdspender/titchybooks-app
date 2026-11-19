import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { ACCEPTED_IMAGE_TYPES } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { finalizeImageUpload, ImageUploadError } from "@/lib/assets/upload";
import { lockAssetReferences } from '@/lib/assets/references';
import { deleteS3Object } from '@/lib/s3';

export const dynamic = "force-dynamic";


const createAssetSchema = z.object({
  s3Key: z.string().min(1),
  originalFilename: z.string().min(1),
  mimeType: z.enum(ACCEPTED_IMAGE_TYPES),
  fileSize: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const assets = await prisma.asset.findMany({
    where: { userId: session.user.id, deletedAt: null },
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

  return NextResponse.json({ assets: assetsWithUrls }, { headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } });
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

    const prefix = `assets/${session.user.id}/`;
    const uploadId = parsed.data.s3Key.startsWith(prefix)
      ? /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpe?g|png|webp)$/i.exec(parsed.data.s3Key.slice(prefix.length))?.[1]
      : undefined;
    if (!uploadId) {
      return NextResponse.json(
        { error: "Invalid asset storage key" },
        { status: 400 }
      );
    }

    // A retry returns the first accepted source; it never re-reads a mutable PUT key.
    let asset = await prisma.asset.findUnique({ where: { id: uploadId } }) ??
      await prisma.asset.findUnique({ where: { s3Key: parsed.data.s3Key } });
    if (!asset) {
      const verified = await finalizeImageUpload(parsed.data.s3Key, `${prefix}canonical`);
      asset = await prisma.$transaction(async tx => {
        await lockAssetReferences(tx);
        return tx.asset.upsert({
          where: { id: uploadId }, update: {},
          create: { id: uploadId, userId: session.user.id!, originalFilename: parsed.data.originalFilename, ...verified },
        });
      });
      // A competing completion may have won the upsert with different staged
      // bytes. The losing canonical key is content-addressed and referenced by
      // no row, so it can be removed without touching the winner or the source.
      if (asset.s3Key !== verified.s3Key) {
        await deleteS3Object(verified.s3Key).catch(error => console.error('Failed to clean up losing canonical upload:', error));
      }
    }
    if (asset.userId !== session.user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (asset.deletedAt) return NextResponse.json({ error: 'This image was removed from the library.' }, { status: 409 });
    const downloadUrl = `/api/assets/${asset.id}/image`;

    return NextResponse.json(
      { asset: { ...asset, downloadUrl } },
      { status: 201, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } }
    );
  } catch (error) {
    if (error instanceof ImageUploadError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
