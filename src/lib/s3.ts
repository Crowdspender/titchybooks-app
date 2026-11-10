import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME!;

export async function getPresignedUploadUrl(
  s3Key: string,
  contentType: string
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    ContentType: contentType,
  });
  return getSignedUrl(s3Client, command, { expiresIn: 600 });
}

export async function getPresignedDownloadUrl(
  s3Key: string,
  options: { filename?: string; expiresIn?: number } = {}
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    // A download the customer can recognise in their downloads folder. Quotes
    // and control characters are stripped: they would break the header.
    ...(options.filename
      ? {
          ResponseContentDisposition: `attachment; filename="${options.filename.replace(/["\\\r\n]/g, "")}"`,
        }
      : {}),
  });
  return getSignedUrl(s3Client, command, { expiresIn: options.expiresIn ?? 3600 });
}

export async function downloadFromS3(s3Key: string): Promise<Buffer> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
  });
  const response = await s3Client.send(command);
  const stream = response.Body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function uploadToS3(
  s3Key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    Body: body,
    ContentType: contentType,
  });
  await s3Client.send(command);
}

/**
 * Object key for a source image uploaded before its Submission exists.
 *
 * `objectId` makes every presigned object distinct: without it, uploading the
 * same page twice (a new session, a retry, a re-render) would overwrite bytes
 * that an existing book still references.
 */
export function buildUploadKey(
  userId: string,
  submissionId: string,
  pageLabel: string,
  ext: string,
  objectId: string
): string {
  return `uploads/${userId}/${submissionId}/${pageLabel}-${objectId}.${ext}`;
}

export function buildAssetUploadKey(
  userId: string,
  assetId: string,
  ext: string
): string {
  return `assets/${userId}/${assetId}.${ext}`;
}

export function buildRenderAttemptPrefix(userId: string, submissionId: string, jobId: string, attempt: number, token: string): string {
  return `renders/${userId}/${submissionId}/${jobId}/${attempt}-${token}`;
}

export function buildPdfKey(
  userId: string,
  submissionId: string
): string {
  return `pdfs/${userId}/${submissionId}/titchybook.pdf`;
}

export function buildPagePreviewKey(
  userId: string,
  submissionId: string,
  pageLabel: string
): string {
  return `previews/${userId}/${submissionId}/${pageLabel}.png`;
}

export async function deleteS3Object(s3Key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
  });
  await s3Client.send(command);
}

/** Returns true when the object exists in the bucket. */
export async function objectExists(s3Key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: s3Key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Object metadata for verification: returns the stored size and content type,
 * or null when the object does not exist (or HEAD fails).
 */
export async function headS3Object(
  s3Key: string
): Promise<{ size: number; contentType?: string } | null> {
  try {
    const head = await s3Client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: s3Key })
    );
    return { size: head.ContentLength ?? 0, contentType: head.ContentType };
  } catch {
    return null;
  }
}
