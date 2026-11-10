import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getPresignedUploadUrl, buildUploadKey } from "@/lib/s3";
import { consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { ACCEPTED_IMAGE_TYPES, PAGE_LABELS } from "@/lib/constants";

// Upload-session grouping id (client-generated UUID): the Submission row does
// not exist yet at upload time. Keep it to a benign, bounded token so it cannot
// smuggle path characters or create confusing/oversized S3 keys.
const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Durable bucket: presigning is the entry point for storage writes. 8 pages
  // per book already cost 8 calls, so 60 per 5 minutes is generous headroom
  // while still bounding abuse.
  const rl = await consumeRateLimit(`presign:user:${session.user.id}`, {
    limit: 60,
    windowMs: 5 * 60_000,
  });
  if (!rl.allowed) {
    return tooManyRequests(rl, "Too many upload requests - please try again shortly.");
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

  // Key-segment validation. Cross-user writes are already impossible because
  // the key namespace is the session user's id (never a client-supplied one),
  // and POST /api/submissions re-verifies the uploads/<userId>/ prefix; these
  // checks stop malformed/garbage segments from ever reaching S3.
  if (!SUBMISSION_ID_PATTERN.test(submissionId)) {
    return NextResponse.json({ error: "Invalid upload session id" }, { status: 400 });
  }
  if (!(PAGE_LABELS as readonly string[]).includes(pageLabel)) {
    return NextResponse.json({ error: "Invalid page label" }, { status: 400 });
  }
  const ext = (filename.split(".").pop() || "jpg").toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(ext)) {
    return NextResponse.json({ error: "Invalid file extension" }, { status: 400 });
  }

  // NOTE: ContentType is part of the signature, so S3 enforces the declared
  // image type on the PUT. Object size cannot be constrained by a presigned
  // PUT; it is verified server-side when the submission is created (see
  // api/submissions POST -> headS3Object + MAX_FILE_SIZE).
  //
  // The object id is minted here, not derived from the page: a new upload
  // session must never overwrite an image that an existing book references.
  const s3Key = buildUploadKey(session.user.id, submissionId, pageLabel, ext, randomUUID());
  const uploadUrl = await getPresignedUploadUrl(s3Key, contentType);

  return NextResponse.json({ uploadUrl, s3Key });
}
