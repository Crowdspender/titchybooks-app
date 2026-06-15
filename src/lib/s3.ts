import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
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

export async function getPresignedDownloadUrl(s3Key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
  });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
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

export function buildUploadKey(
  userId: string,
  submissionId: string,
  pageLabel: string,
  ext: string
): string {
  return `uploads/${userId}/${submissionId}/${pageLabel}.${ext}`;
}

export function buildAssetUploadKey(
  userId: string,
  assetId: string,
  ext: string
): string {
  return `assets/${userId}/${assetId}.${ext}`;
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
