import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getPresignedUploadUrl, buildUploadKey } from "@/lib/s3";
import { ACCEPTED_IMAGE_TYPES } from "@/lib/constants";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const filename = searchParams.get("filename");
  const contentType = searchParams.get("contentType");
  const submissionId = searchParams.get("submissionId");
  const pageLabel = searchParams.get("pageLabel");

  if (!filename || !contentType || !submissionId || !pageLabel) {
    return NextResponse.json(
      { error: "Missing required parameters: filename, contentType, submissionId, pageLabel" },
      { status: 400 }
    );
  }

  if (!ACCEPTED_IMAGE_TYPES.includes(contentType as typeof ACCEPTED_IMAGE_TYPES[number])) {
    return NextResponse.json(
      { error: "Invalid file type. Accepted: JPG, PNG, WebP" },
      { status: 400 }
    );
  }

  const ext = filename.split(".").pop() || "jpg";
  const s3Key = buildUploadKey(session.user.id, submissionId, pageLabel, ext);
  const uploadUrl = await getPresignedUploadUrl(s3Key, contentType);

  return NextResponse.json({ uploadUrl, s3Key });
}
