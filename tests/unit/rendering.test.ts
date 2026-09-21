import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { generateTitchybookPdf } from '@/lib/pdf/generate';
import { renderSceneToPdfPage } from '@/lib/pdf/vector-render';
import { parseRenderSnapshot, type RenderSnapshot } from '@/lib/pdf/snapshot';
import { PAGE_LABELS } from '@/lib/constants';
import { createEmptyEditorScene } from '@/lib/editor/schema';
import { imageElement, sceneWithText } from '../fixtures/scenes';
import { mmToPoints } from '@/lib/pdf/layout';

const storage = vi.hoisted(() => ({ objects: new Map<string, Buffer>() }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/s3', () => ({
  downloadFromS3: async (key: string) => {
    const data = storage.objects.get(key);
    if (!data) throw new Error('Missing object');
    return data;
  },
  uploadToS3: async (key: string, data: Buffer) => { storage.objects.set(key, data); },
}));
function snapshot(): RenderSnapshot {
  return { version: 1, userId: 'test', submissionId: 'test', renderer: 'raster', mode: 'EDITOR',
    assets: [], images: [], pages: PAGE_LABELS.map(pageLabel => ({ pageLabel, scene: sceneWithText(pageLabel) })) };
}
afterEach(() => storage.objects.clear());

it('renders eight raster panels using in-memory assets onto one A4 landscape PDF', async () => {
  const source = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ff0000' } }).png().toBuffer();
  storage.objects.set('source.png', source);
  const input = snapshot();
  input.assets = [{ id: 'image', s3Key: 'source.png', mimeType: 'image/png', width: 400, height: 400 }];
  input.pages[0].scene.elements.push(imageElement('image'));
  const result = await generateTitchybookPdf(input, 'attempt-1');
  const pdf = await PDFDocument.load(storage.objects.get(result.pdfS3Key)!);
  expect(pdf.getPageCount()).toBe(1);
  expect(pdf.getPage(0).getWidth()).toBeCloseTo(mmToPoints(297));
  expect(pdf.getPage(0).getHeight()).toBeCloseTo(mmToPoints(210));
  expect(result.previews).toHaveLength(8);
  expect(new Set(result.previews.map(p => p.pageLabel))).toEqual(new Set(PAGE_LABELS));
  for (const preview of result.previews) expect((await sharp(storage.objects.get(preview.s3Key)!).metadata()).width).toBe(200);
}, 30000);

it('fails explicitly on missing source objects instead of publishing an incomplete PDF', async () => {
  const input = snapshot();
  input.assets = [{ id: 'missing', s3Key: 'missing.png', mimeType: 'image/png', width: 100, height: 100 }];
  input.pages[0].scene.elements.push(imageElement('missing'));
  await expect(generateTitchybookPdf(input, 'failed')).rejects.toThrow('Missing object');
  expect(storage.objects.has('failed/titchybook.pdf')).toBe(false);
});

it('rejects duplicate labels, unsupported versions, and missing descriptors', () => {
  const input = snapshot();
  input.pages[7].pageLabel = input.pages[0].pageLabel;
  expect(() => parseRenderSnapshot(input)).toThrow();
  expect(() => parseRenderSnapshot({ ...snapshot(), version: 2 })).toThrow();
  const missing = snapshot();
  missing.pages[0].scene.elements.push(imageElement('missing'));
  expect(() => parseRenderSnapshot(missing)).toThrow();
});

it('does not swallow missing vector assets', async () => {
  const scene = { ...createEmptyEditorScene(), elements: [imageElement('missing')] };
  await expect(renderSceneToPdfPage(scene, 200, 300, new Map())).rejects.toThrow('Failed to render element');
});
