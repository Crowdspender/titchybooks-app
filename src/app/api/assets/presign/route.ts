import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { ACCEPTED_IMAGE_TYPES } from "@/lib/constants";
import { buildAssetUploadKey, getPresignedUploadUrl } from "@/lib/s3";

const createAssetPresignSchema = z.object({
  filename: z.string().min(1),
  contentType: z.enum(ACCEPTED_IMAGE_TYPES),
  usage: z.enum(["editor"]).default("editor"),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = createAssetPresignSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const assetId = crypto.randomUUID();
    const ext = parsed.data.filename.split(".").pop() || "jpg";
    const s3Key = buildAssetUploadKey(session.user.id, assetId, ext);
    const uploadUrl = await getPresignedUploadUrl(s3Key, parsed.data.contentType);

    return NextResponse.json({
      assetId,
      uploadUrl,
      s3Key,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
