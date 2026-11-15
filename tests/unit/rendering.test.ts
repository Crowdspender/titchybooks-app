import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { generateTitchybookPdf } from '@/lib/pdf/generate';
import { renderSceneToPdfPage } from '@/lib/pdf/vector-render';
import { parseRenderSnapshot, type RenderSnapshot } from '@/lib/pdf/snapshot';
import { PAGE_LABELS } from '@/lib/constants';
import { createEmptyEditorScene } from '@/lib/editor/schema';
import { imageElement, sceneWithText } from '../fixtures/scenes';
import { A4_LANDSCAPE_HEIGHT_MM, mmToPoints, PANELS } from '@/lib/pdf/layout';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { editorElementSchema } from '@/lib/editor/schema';
import { SEED_RECIPES, elementSeeds, backgroundFor } from '../../prisma/seed-recipes';
import { FONT_MANIFEST, requiredDesignFonts } from '@/lib/editor/design-fonts';
import { layoutDesignText } from '@/lib/editor/design-text-layout';
import { preflightDesign } from '@/lib/editor/design-preflight';
import { loadServerDesignFonts } from '@/lib/pdf/design-fonts-server';
import { renderEditorSceneForPanel, renderSceneTile, renderEditorSceneForReading } from '@/lib/pdf/editor-render';
import { DEFAULT_PRINT_PROFILE } from '@/lib/pdf/print-profile';

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

it('renders guided reading and folded fixtures with identical outlines and unchanged imposition', async () => {
  const recipe = SEED_RECIPES.find(recipe => recipe.key === 'seed-story-guided-v1')!;
  const rows = elementSeeds(recipe);
  const pages = PAGE_LABELS.map(pageLabel => {
    const scene = createEmptyEditorScene();
    scene.page.backgroundColor = backgroundFor(recipe, pageLabel);
    scene.elements = rows.filter(row => row.pageLabel === pageLabel).map(row => {
      const element = editorElementSchema.parse(JSON.parse(row.elementJson));
      if (element.type !== 'text' || element.locked) return element;
      return { ...element, italic: pageLabel === 'PAGE_3', text: pageLabel === 'FRONT_COVER' ? 'The Lantern and the Sea' : 'Émilie watched the lantern dance upon the waves. Beyond the quiet harbor, a small boat waited for the tide.\n\nShe opened her notebook and began a new story.' };
    });
    loadServerDesignFonts(scene.elements);
    for (const element of scene.elements) if (element.type === 'text' && element.typographyVersion) {
      expect(layoutDesignText(element).path).not.toMatch(/NaN|Infinity|undefined/);
    }
    expect(preflightDesign(scene, pageLabel).filter(issue => issue.severity === 'error')).toEqual([]);
    return { pageLabel, scene };
  });
  for (const { scene } of pages) {
    for (const element of scene.elements) if (element.type === 'text' && element.typographyVersion) {
      const layout = layoutDesignText(element);
      const tile = await renderSceneTile({ ...scene, page: { ...scene.page, backgroundColor: '#ffffff' }, elements: [{ ...element, color: '#000000' }] }, 700, 1000, new Map());
      const { info } = await sharp(tile).trim({ background: '#ffffff', threshold: 10 }).toBuffer({ resolveWithObject: true });
      expect(Math.abs(Math.abs(info.trimOffsetLeft!) - (element.x + layout.bounds.x1))).toBeLessThan(2);
      expect(Math.abs(Math.abs(info.trimOffsetTop!) - (element.y + layout.bounds.y1))).toBeLessThan(2);
      expect(Math.abs(info.width - (layout.bounds.x2 - layout.bounds.x1))).toBeLessThan(2);
      expect(Math.abs(info.height - (layout.bounds.y2 - layout.bounds.y1))).toBeLessThan(2);
    }
  }
  const ids = requiredDesignFonts(pages.flatMap(page => page.scene.elements));
  const input = parseRenderSnapshot({ version: 2, submissionRevision: 1, userId: 'fixture', submissionId: 'guided', title: 'The Lantern and the Sea', templateId: null, templateVersion: null, renderer: 'raster', mode: 'EDITOR', assets: [], images: [], pages, printProfile: DEFAULT_PRINT_PROFILE.id, outputs: ['print-sheet', 'reading-pdf'], typography: { version: 1, fonts: Object.fromEntries(ids.map(id => [id, FONT_MANIFEST[id].map(asset => asset.sha256)])) } });
  const output = await generateTitchybookPdf(input, 'guided-fixture');
  const reading = storage.objects.get(output.readingPdfS3Key)!;
  const sheet = storage.objects.get(output.pdfS3Key)!;
  const readingPdf = await PDFDocument.load(reading);
  expect(readingPdf.getPageCount()).toBe(8);
  for (const page of readingPdf.getPages()) {
    expect(page.getWidth()).toBeCloseTo(mmToPoints(74));
    expect(page.getHeight()).toBeCloseTo(mmToPoints(105));
  }
  const sheetPdf = await PDFDocument.load(sheet);
  expect(sheetPdf.getPageCount()).toBe(1);
  expect(sheetPdf.getPage(0).getWidth()).toBeCloseTo(mmToPoints(297));
  expect(sheetPdf.getPage(0).getHeight()).toBeCloseTo(mmToPoints(210));
  const streams = sheetPdf.getPage(0).node.Contents() as PDFArray;
  const operators = Array.from({ length: streams.size() }, (_, index) => Buffer.from(decodePDFRawStream(streams.lookup(index, PDFRawStream)).decode()).toString()).join('\n');
  expect(operators.match(/\/Image-[^\s]+ Do/g)).toHaveLength(8);
  for (const panel of PANELS) {
    expect(operators).toContain(`1 0 0 1 ${mmToPoints(panel.x)} ${mmToPoints(A4_LANDSCAPE_HEIGHT_MM - panel.y - panel.height)} cm`);
    expect(operators).toContain(`${mmToPoints(panel.width)} 0 0 ${mmToPoints(panel.height)} 0 0 cm`);
    const scene = pages.find(page => page.pageLabel === panel.pageLabel)!.scene;
    const upright = await renderSceneTile(scene, Math.round(panel.width / 25.4 * 300), Math.round(panel.height / 25.4 * 300), new Map());
    const expected = panel.rotation === 180 ? await sharp(upright).rotate(180).png().toBuffer() : upright;
    expect(await renderEditorSceneForPanel(scene, panel, new Map())).toEqual(expected);
  }
  const folder = join(process.cwd(), 'test-results', 'design-render');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'reading.pdf'), reading);
  await writeFile(join(folder, 'print-sheet.pdf'), sheet);
  for (const label of ['FRONT_COVER', 'PAGE_2'] as const) {
    const scene = pages.find(page => page.pageLabel === label)!.scene;
    await writeFile(join(folder, `${label}.png`), await renderEditorSceneForReading(scene, new Map()));
  }
  await writeFile(join(folder, 'geometry.json'), JSON.stringify(pages.map(page => ({ label: page.pageLabel, elements: page.scene.elements.filter(element => element.type === 'text').map(element => element.type === 'text' ? { id: element.id, layout: layoutDesignText(element) } : null) }))));
}, 60000);

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
