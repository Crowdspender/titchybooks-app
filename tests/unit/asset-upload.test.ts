import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { MAX_FILE_SIZE } from '@/lib/constants';
import { finalizeImageUpload, ImageUploadError, verifyImageBytes } from '@/lib/assets/upload';
import { downloadFromS3, headS3Object, uploadToS3 } from '@/lib/s3';

const storage = vi.hoisted(() => ({ bytes: Buffer.alloc(0), accepted: new Map<string, Buffer>() }));
vi.mock('@/lib/s3', async () => ({
  ...await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3'),
  headS3Object: vi.fn(async () => ({ size: storage.bytes.length, contentType: 'application/octet-stream' })),
  downloadFromS3: vi.fn(async () => Buffer.from(storage.bytes)),
  uploadToS3: vi.fn(async (key: string, bytes: Buffer) => { storage.accepted.set(key, Buffer.from(bytes)); }),
}));
beforeEach(async () => {
  vi.clearAllMocks(); storage.accepted.clear();
  storage.bytes = await sharp({ create: { width: 8, height: 12, channels: 3, background: 'red' } }).png().toBuffer();
});
afterEach(() => vi.restoreAllMocks());

it.each(['jpeg', 'png', 'webp'] as const)('fully decodes %s and returns actual metadata', async format => {
  const bytes = await sharp(storage.bytes).toFormat(format).toBuffer();
  expect(await verifyImageBytes(bytes)).toMatchObject({ width: 8, height: 12, mimeType: `image/${format}`, fileSize: bytes.length });
});
it('uses oriented dimensions for an EXIF-rotated JPEG', async () => {
  const bytes = await sharp(storage.bytes).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  expect(await verifyImageBytes(bytes)).toMatchObject({ width: 12, height: 8 });
});
it.each([Buffer.alloc(0), Buffer.alloc(MAX_FILE_SIZE + 1), Buffer.from('not an image'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>')])('rejects empty, oversized, corrupt, or unsupported bytes', async bytes => {
  await expect(verifyImageBytes(bytes)).rejects.toBeInstanceOf(ImageUploadError);
});
it('rejects truncated image data even when dimensions can be read', async () => {
  const bytes = await sharp(storage.bytes).jpeg().toBuffer();
  await expect(verifyImageBytes(bytes.subarray(0, bytes.length - 16))).rejects.toBeInstanceOf(ImageUploadError);
});
it('rejects a dimension over 20,000 px', async () => {
  const bytes = await sharp({ create: { width: 20_001, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  await expect(verifyImageBytes(bytes)).rejects.toThrow('20,000');
});
it('rejects over 40 megapixels even when both dimensions are within 20,000 px', async () => {
  const bytes = await sharp({ create: { width: 6400, height: 6300, channels: 3, background: 'white' } }).png().toBuffer();
  expect(bytes.length).toBeLessThan(MAX_FILE_SIZE);
  await expect(verifyImageBytes(bytes)).rejects.toBeInstanceOf(ImageUploadError);
}, 20000);
it('rejects a genuine animated WebP', async () => {
  const pixels = Buffer.concat([Buffer.alloc(8 * 12 * 4, 255), Buffer.alloc(8 * 12 * 4, 0)]);
  const bytes = await sharp(pixels, { raw: { width: 8, height: 24, channels: 4, pageHeight: 12 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  expect((await sharp(bytes, { animated: true }).metadata()).pages).toBe(2);
  await expect(verifyImageBytes(bytes)).rejects.toThrow('Animated');
});
it('rejects an APNG animation-control chunk', async () => {
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8, 0); animation.write('acTL', 4, 'ascii');
  animation.writeUInt32BE(2, 8);
  const bytes = Buffer.concat([storage.bytes.subarray(0, 33), animation, storage.bytes.subarray(33)]);
  await expect(verifyImageBytes(bytes)).rejects.toBeInstanceOf(ImageUploadError);
});
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}
it('rejects a valid two-frame animated PNG', async () => {
  const chunks: Array<{ type: string; data: Buffer }> = [];
  for (let offset = 8; offset < storage.bytes.length;) {
    const length = storage.bytes.readUInt32BE(offset);
    chunks.push({ type: storage.bytes.toString('ascii', offset + 4, offset + 8), data: storage.bytes.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  const ihdr = chunks.find(chunk => chunk.type === 'IHDR')!.data;
  const idat = chunks.find(chunk => chunk.type === 'IDAT')!.data;
  const frameControl = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(8, 4); data.writeUInt32BE(12, 8);
    data.writeUInt16BE(100, 20); data.writeUInt16BE(1000, 22);
    return data;
  };
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(2, 0);
  const secondFrame = Buffer.alloc(4 + idat.length);
  secondFrame.writeUInt32BE(2, 0); idat.copy(secondFrame, 4);
  const bytes = Buffer.concat([
    storage.bytes.subarray(0, 8), pngChunk('IHDR', ihdr), pngChunk('acTL', animationControl),
    pngChunk('fcTL', frameControl(0)), pngChunk('IDAT', idat),
    pngChunk('fcTL', frameControl(1)), pngChunk('fdAT', secondFrame), pngChunk('IEND', Buffer.alloc(0)),
  ]);
  // This sharp build does not report APNG page counts, so prove the fixture
  // is a well-formed image by decoding it; the acTL chunk walker is the
  // animation defense under test.
  expect((await sharp(bytes).metadata()).format).toBe('png');
  expect((await sharp(bytes).raw().toBuffer()).length).toBe(8 * 12 * 3);
  await expect(verifyImageBytes(bytes)).rejects.toThrow('Animated');
});
it('finalizes exact verified bytes, and preserves the accepted key after an upload overwrite', async () => {
  const firstBytes = Buffer.from(storage.bytes);
  const first = await finalizeImageUpload('assets/user/upload.png', 'assets/user/canonical');
  expect(first).toMatchObject({ width: 8, height: 12, fileSize: firstBytes.length, mimeType: 'image/png' });
  expect(first.s3Key).toMatch(/^assets\/user\/canonical\/[a-f0-9]{64}\/[a-f0-9]{64}\.png$/);
  expect(uploadToS3).toHaveBeenCalledWith(first.s3Key, firstBytes, 'image/png');
  expect(downloadFromS3).toHaveBeenCalledWith('assets/user/upload.png', { maxBytes: MAX_FILE_SIZE });
  expect((await finalizeImageUpload('assets/user/upload.png', 'assets/user/canonical')).s3Key).toBe(first.s3Key);
  storage.bytes = await sharp(storage.bytes).jpeg().toBuffer();
  const second = await finalizeImageUpload('assets/user/upload.png', 'assets/user/canonical');
  expect(second.s3Key).not.toBe(first.s3Key);
  expect(storage.accepted.get(first.s3Key)).toEqual(firstBytes);
});
it.each([null, { size: 0 }, { size: MAX_FILE_SIZE + 1 }])('rejects invalid HEAD metadata before reading bytes', async head => {
  vi.mocked(headS3Object).mockResolvedValueOnce(head);
  await expect(finalizeImageUpload('source', 'canonical')).rejects.toBeInstanceOf(ImageUploadError);
  expect(downloadFromS3).not.toHaveBeenCalled();
  expect(uploadToS3).not.toHaveBeenCalled();
});

it('bounds the actual S3 stream before EOF even when the advertised size is smaller', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3');
  let releaseEof!: () => void;
  const eof = new Promise<void>(resolve => { releaseEof = resolve; });
  let emitted = 0;
  const body = new Readable({
    read() {
      if (emitted < 2) { this.push(Buffer.alloc(emitted === 0 ? 4 : 5)); emitted += 1; return; }
      void eof.then(() => this.push(null)); // Stay open until the test permits EOF.
    },
  });
  const destroy = vi.spyOn(body, 'destroy');
  vi.spyOn(actual.s3Client, 'send').mockResolvedValueOnce({ Body: body, ContentLength: 1 } as never);
  try {
    await expect(actual.downloadFromS3('source', { maxBytes: 8 })).rejects.toBeInstanceOf(actual.S3ObjectSizeError);
    expect(destroy).toHaveBeenCalled();
    expect(body.readableEnded).toBe(false); // The size check fired before EOF was permitted.
  } finally { releaseEof(); body.destroy(); }
});
it('rejects a short S3 transfer rather than accepting a misleading encoded size', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3');
  const body = Readable.from([Buffer.alloc(4)]);
  const destroy = vi.spyOn(body, 'destroy');
  vi.spyOn(actual.s3Client, 'send').mockResolvedValueOnce({ Body: body, ContentLength: 8 } as never);
  await expect(actual.downloadFromS3('source', { maxBytes: 8 })).rejects.toThrow('incomplete');
  expect(destroy).toHaveBeenCalled();
});
it('rejects an oversized Content-Length and closes the body before consumption', async () => {
  const actual = await vi.importActual<typeof import('@/lib/s3')>('@/lib/s3');
  const body = Readable.from([Buffer.alloc(9)]);
  const destroy = vi.spyOn(body, 'destroy');
  vi.spyOn(actual.s3Client, 'send').mockResolvedValueOnce({ Body: body, ContentLength: 9 } as never);
  await expect(actual.downloadFromS3('source', { maxBytes: 8 })).rejects.toBeInstanceOf(actual.S3ObjectSizeError);
  expect(destroy).toHaveBeenCalled();
});
