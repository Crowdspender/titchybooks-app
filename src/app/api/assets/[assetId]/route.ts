import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { AssetReferenceError, removeAssetFromLibrary } from '@/lib/assets/references';

export const dynamic = "force-dynamic";


export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { assetId } = await params;

  try {
    await prisma.$transaction(tx => removeAssetFromLibrary(tx, assetId, session.user.id!), { timeout: 20000 });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AssetReferenceError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Error removing asset:", error);
    return NextResponse.json(
      { error: "Failed to delete asset" },
      { status: 500 }
    );
  }
}
