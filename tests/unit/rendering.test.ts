import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { generateTitchybookPdf } from '@/lib/pdf/generate';
import { renderSceneToPdfPage } from '@/lib/pdf/vector-render';
import { parseRenderSnapshot, type RenderSnapshot } from '@/lib/pdf/snapshot';
import { PAGE_LABELS } from '@/lib/constants';
import { createEmptyEditorScene } from '@/lib/editor/schema';
import { FULL_INTERIOR_TEXT, imageElement, sceneWithText } from '../fixtures/scenes';
import { buildPinnedTemplate, buildTemplateManifest } from '@/lib/ai/template-contract';
import { interiorFlowPages, paginatePlan, prepareAiBookLayout } from '@/lib/ai/flow';
import { applyPrintPalette, selectPrintPalette } from '@/lib/ai/print-palette';
import { measureTextBlock } from '@/lib/pdf/text-layout';
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
import { DEFAULT_PRINT_PROFILE, READING_ORDER } from '@/lib/pdf/print-profile';

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

it('renders text near the bottom of all six expanded private interior pages', async () => {
  const recipe = SEED_RECIPES[0];
  const rows = elementSeeds(recipe);
  const sourcePages = PAGE_LABELS.map((pageLabel) => ({
    pageLabel, backgroundColor: backgroundFor(recipe, pageLabel),
    elements: rows.filter((row) => row.pageLabel === pageLabel).map((row) => editorElementSchema.parse(JSON.parse(row.elementJson))),
  }));
  const manifest = buildTemplateManifest({ templateId: 'full-interiors', templateVersion: 1, pages: sourcePages });
  const source = buildPinnedTemplate({ templateId: manifest.templateId, templateVersion: 1, manifest, pages: sourcePages });
  const before = JSON.stringify(source);
  const expanded = prepareAiBookLayout(source);
  const pin = applyPrintPalette(expanded, selectPrintPalette('mist', expanded));
  const flowPages = interiorFlowPages(pin.manifest);
  const pagination = paginatePlan({ manifest: pin.manifest, overrides: flowPages.map((page) => ({ templateElementId: page.flow.id, text: FULL_INTERIOR_TEXT })) });
  expect(pagination.issues).toEqual([]);
  expect(pagination.pages).toHaveLength(6);
  expect(pagination.pages.every((page) => page.filled && page.usedHeight === 798)).toBe(true);
  const overrides = new Map(pagination.overrides.map((entry) => [entry.templateElementId, entry.text]));
  const pages = pin.pages.map((page) => ({ pageLabel: page.pageLabel, scene: {
    ...createEmptyEditorScene(),
    page: { widthPx: 700, heightPx: 1000, backgroundColor: page.backgroundColor },
    elements: page.elements.map((element) => element.type === 'text' && overrides.has(element.id)
      ? { ...element, text: overrides.get(element.id)! } : element),
  } }));
  const folder = join(process.cwd(), 'test-results', 'full-interiors');
  await mkdir(folder, { recursive: true });
  for (const flow of flowPages) {
    const scene = pages.find((page) => page.pageLabel === flow.pageLabel)!.scene;
    const body = scene.elements.find((element) => element.id === flow.flow.id)!;
    if (body.type !== 'text') throw new Error('Expected body text');
    expect(body.y + body.height).toBe(940);
    expect(measureTextBlock(body.text, body.width, body).height).toBe(798);
    const inkTile = await renderSceneTile({ ...scene, page: { ...scene.page, backgroundColor: '#ffffff' }, elements: [{ ...body, color: '#000000' }] }, 700, 1000, new Map());
    const { info } = await sharp(inkTile).trim({ background: '#ffffff', threshold: 10 }).toBuffer({ resolveWithObject: true });
    const inkBottom = Math.abs(info.trimOffsetTop!) + info.height;
    expect(inkBottom).toBeGreaterThan(880);
    expect(inkBottom).toBeLessThan(940);
    if (flow.pageLabel === 'PAGE_2' || flow.pageLabel === 'PAGE_7') {
      await writeFile(join(folder, `${flow.pageLabel}.png`), await renderSceneTile(scene, 700, 1000, new Map()));
    }
  }
  const input = parseRenderSnapshot({ version: 2, submissionRevision: 0, userId: 'fixture', submissionId: 'full-interiors', title: 'A Rainy Day', templateId: pin.templateId, templateVersion: 1, renderer: 'raster', mode: 'EDITOR', assets: [], images: [], pages, printProfile: DEFAULT_PRINT_PROFILE.id, outputs: ['print-sheet', 'reading-pdf'] });
  const output = await generateTitchybookPdf(input, 'full-interiors-fixture');
  const reading = storage.objects.get(output.readingPdfS3Key)!;
  const sheet = storage.objects.get(output.pdfS3Key)!;
  expect((await PDFDocument.load(reading)).getPageCount()).toBe(8);
  expect((await PDFDocument.load(sheet)).getPageCount()).toBe(1);
  expect(output.previews).toHaveLength(8);
  expect(JSON.stringify(source)).toBe(before);
  await writeFile(join(folder, 'reading.pdf'), reading);
  await writeFile(join(folder, 'print-sheet.pdf'), sheet);
}, 30000);

it('embeds upright pages in reading order independently of scene storage order', async () => {
  const input = snapshot();
  const colors = ['#112233', '#334455', '#556677', '#778899', '#99aabb', '#bbccdd', '#dd1122', '#22dd44'];
  input.pages.forEach((page, i) => { page.scene.elements = []; page.scene.page.backgroundColor = colors[i]; });
  const before = JSON.stringify(input);
  const result = await generateTitchybookPdf(input, 'reading-order');
  const reading = await PDFDocument.load(storage.objects.get(result.readingPdfS3Key)!);
  expect(result.previews.map(page => page.pageLabel)).toEqual(READING_ORDER);
  for (const [index, page] of reading.getPages().entries()) {
    const objects = page.node.Resources()!.lookup(PDFName.of('XObject'));
    const entries = (objects as import('pdf-lib').PDFDict).entries();
    const image = entries.map(([, ref]) => reading.context.lookup(ref)).find(object => object instanceof PDFRawStream) as PDFRawStream;
    const pixels = Buffer.from(decodePDFRawStream(image).decode());
    const expected = input.pages.find(page => page.pageLabel === READING_ORDER[index])!.scene.page.backgroundColor;
    expect(pixels.subarray(0, 3).toString('hex')).toBe(expected.slice(1));
    expect(page.getRotation().angle).toBe(0);
    expect(page.getWidth()).toBeCloseTo(mmToPoints(74));
    expect(page.getHeight()).toBeCloseTo(mmToPoints(105));
  }
  expect(JSON.stringify(input)).toBe(before);
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
