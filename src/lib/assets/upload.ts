import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { MAX_FILE_SIZE } from '@/lib/constants';
import { downloadFromS3, headS3Object, S3ObjectSizeError, uploadToS3 } from '@/lib/s3';

export const MAX_IMAGE_DIMENSION = 20_000;
// Bound a complete RGBA decode to 160 MB; legacy pages are finalized serially.
export const MAX_DECODE_PIXELS = 40_000_000;
export class ImageUploadError extends Error {}
const formats = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

function isAnimatedPng(bytes: Buffer) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new ImageUploadError('Corrupt PNG image.');
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}

export async function verifyImageBytes(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_FILE_SIZE) {
    throw new ImageUploadError('Images must contain between 1 byte and 10 MiB.');
  }
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_DECODE_PIXELS, animated: true });
    const metadata = await image.metadata();
    if (!metadata.format || !(metadata.format in formats)) {
      throw new ImageUploadError('Only decoded JPEG, PNG, and WebP images are accepted.');
    }
    if ((metadata.pages ?? 1) !== 1 || isAnimatedPng(bytes)) {
      throw new ImageUploadError('Animated images are not accepted.');
    }
    const { width, height } = metadata;
    if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_DECODE_PIXELS) {
      throw new ImageUploadError('Images must be at most 20,000 px per dimension and 40 megapixels.');
    }
    // Force a complete decode, including orientation, rather than trusting headers.
    const decoded = await image.rotate().toColourspace('srgb').ensureAlpha().raw().timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
    return {
      width: decoded.info.width, height: decoded.info.height, fileSize: bytes.length,
      mimeType: formats[metadata.format as keyof typeof formats],
      extension: metadata.format === 'jpeg' ? 'jpg' : metadata.format,
    };
  } catch (error) {
    if (error instanceof ImageUploadError) throw error;
    throw new ImageUploadError('The image is corrupt, incomplete, or exceeds the decode limits.');
  }
}

/** Verify one bounded read, then publish those exact bytes to a non-presignable key. */
export async function finalizeImageUpload(sourceKey: string, canonicalPrefix: string) {
  const head = await headS3Object(sourceKey);
  if (!head) throw new ImageUploadError('The uploaded image is missing or unavailable. Please retry.');
  if (!Number.isSafeInteger(head.size) || head.size < 1 || head.size > MAX_FILE_SIZE) {
    throw new ImageUploadError('Images must contain between 1 byte and 10 MiB.');
  }
  let bytes: Buffer;
  try { bytes = await downloadFromS3(sourceKey, { maxBytes: MAX_FILE_SIZE }); }
  catch (error) {
    if (error instanceof S3ObjectSizeError) throw new ImageUploadError('The image exceeds the 10 MiB read limit.');
    throw error;
  }
  const verified = await verifyImageBytes(bytes);
  const sourceDigest = createHash('sha256').update(sourceKey).digest('hex');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const s3Key = `${canonicalPrefix}/${sourceDigest}/${digest}.${verified.extension}`;
  // Repeating the same finalization writes identical bytes; changed uploads get a different key.
  await uploadToS3(s3Key, bytes, verified.mimeType);
  return { s3Key, mimeType: verified.mimeType, fileSize: verified.fileSize, width: verified.width, height: verified.height };
}
