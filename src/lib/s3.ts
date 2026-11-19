import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { Readable } from 'node:stream';

export const s3Client = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
  // The SDK ships with both timeouts disabled: a stalled storage socket would
  // otherwise hang a streaming download forever. socketTimeout is inactivity-
  // based, so large PDFs that keep delivering bytes are never cut off.
  requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, socketTimeout: 30_000 }),
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

/** Open the object without buffering the PDF in application memory. */
export async function openS3Object(s3Key: string, signal?: AbortSignal): Promise<{
  body: Readable; size: number | undefined; contentType: string | undefined;
}> {
  const response = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }), { abortSignal: signal });
  const body = response.Body as Readable | undefined;
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new Error('S3 object body is unavailable');
  return { body, size: response.ContentLength, contentType: response.ContentType };
}

export class S3ObjectSizeError extends Error {}

export async function downloadFromS3(s3Key: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
  });
  const response = await s3Client.send(command);
  const stream = response.Body as NodeJS.ReadableStream & { destroy?: () => void };
  if (!stream) throw new Error('S3 object body is unavailable');
  const limit = options.maxBytes ?? Infinity;
  if ((response.ContentLength ?? 0) > limit) {
    stream.destroy?.();
    throw new S3ObjectSizeError('S3 object exceeds the bounded read limit');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new S3ObjectSizeError('S3 object exceeds the bounded read limit');
      chunks.push(bytes);
    }
    if (options.maxBytes !== undefined && response.ContentLength !== undefined && size !== response.ContentLength) {
      throw new Error('S3 object transfer was incomplete or had an inconsistent length');
    }
    return Buffer.concat(chunks);
  } catch (error) {
    stream.destroy?.();
    throw error;
  }
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
