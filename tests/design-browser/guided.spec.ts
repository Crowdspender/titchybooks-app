import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { renderSceneTile } from '../../src/lib/pdf/editor-render';
import type { EditorScene } from '../../src/lib/editor/schema';
import { layoutDesignText } from '../../src/lib/editor/design-text-layout';
import { loadServerDesignFonts } from '../../src/lib/pdf/design-fonts-server';

const url = '/tests/browser-fixtures/design.html';
const saved = (page: Page) => expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
const sources = (page: Page) => page.evaluate(() => window.designFixture.book.pages.map(page => JSON.parse(page.sceneJson)));
async function open(page: Page, suffix = '') {
  await page.goto(url + suffix);
  await expect(page.getByRole('heading', { name: 'Book Design', exact: true })).toBeVisible();
  await expect(page.locator('.konvajs-content canvas').first()).toBeVisible();
}
async function preset(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await saved(page);
}
async function selectCover(page: Page) {
  await page.getByRole('button', { name: /The Lantern and the Sea.*editable text/ }).click();
  await expect(page.getByLabel('Font family', { exact: true })).toBeVisible();
}

async function compareTextRaster(dataUrl: string, scene: EditorScene) {
  const actual = Buffer.from(dataUrl.split(',')[1], 'base64');
  const { width, height } = await sharp(actual).metadata();
  const expected = await renderSceneTile(scene, width!, height!, new Map());
  const text = scene.elements.find(element => element.type === 'text' && element.typographyVersion);
  if (!text || text.type !== 'text') throw new Error('Expected a guided text fixture');
  const bounds = layoutDesignText(text).bounds;
  const scale = Math.min(width! / scene.page.widthPx, height! / scene.page.heightPx);
  const left = Math.max(0, Math.floor((text.x + bounds.x1) * scale) - 2);
  const top = Math.max(0, Math.floor((text.y + bounds.y1) * scale) - 2);
  const crop = { left, top, width: Math.min(width! - left, Math.ceil((bounds.x2 - bounds.x1) * scale) + 4), height: Math.min(height! - top, Math.ceil((bounds.y2 - bounds.y1) * scale) + 4) };
  const pixels = async (buffer: Buffer) => sharp(buffer).extract(crop).removeAlpha().blur(0.5).raw().toBuffer();
  const a = await pixels(actual), b = await pixels(expected);
  expect(a.length).toBe(b.length);
  const meanError = a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
  expect(meanError).toBeLessThan(width! < 200 ? 12 : 5);
}

test.beforeEach(async ({ context, page }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:3200' ? route.continue() : route.abort());
  page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', error => { throw error; });
});

test('presets preserve content, undo all pages, reload, and share server glyph geometry', async ({ page }, info) => {
  await open(page);
  const evidence = join(info.project.outputDir, 'evidence');
  await mkdir(evidence, { recursive: true });
  await page.locator('.konvajs-content').screenshot({ path: join(evidence, 'before-cover.png') });
  await page.getByRole('button', { name: 'Edit Page 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.locator('.konvajs-content').screenshot({ path: join(evidence, 'before-interior.png') });
  await page.getByRole('button', { name: 'Edit Front Cover', exact: true }).click();
  const before = await sources(page);
  await page.getByLabel('Design scope', { exact: true }).selectOption('book');
  await preset(page, 'Classic Story');
  await expect.poll(async () => (await sources(page)).every(scene => scene.design?.presetId === 'classic')).toBe(true);
  await expect(page.getByText('Loading qualified fonts', { exact: false })).toHaveCount(0);
  await page.locator('.konvajs-content').screenshot({ path: join(evidence, 'after-cover.png') });
  await page.screenshot({ path: join(evidence, 'design-panel.png'), fullPage: true });
  await page.getByRole('button', { name: 'Edit Page 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.locator('.konvajs-content').screenshot({ path: join(evidence, 'after-interior.png') });
  const browser = await page.evaluate(() => window.designFixture.layouts());
  for (const entry of browser) {
    loadServerDesignFonts(entry.scene.elements);
    for (const measured of entry.layouts) {
      const element = entry.scene.elements.find(element => element.id === measured?.id);
      if (element?.type === 'text' && measured) expect(layoutDesignText(element)).toEqual(measured.layout);
    }
  }
  const interior = browser.find(entry => entry.pageLabel === 'PAGE_2')!.scene;
  await compareTextRaster(await page.locator('.konvajs-content canvas').first().evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL()), interior);
  const thumbnail = page.getByRole('img', { name: 'Page 2 preview', exact: true });
  await expect(thumbnail).toBeVisible();
  await compareTextRaster((await thumbnail.getAttribute('src'))!, interior);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await saved(page);
  expect(await sources(page)).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await saved(page);
  await preset(page, 'Modern Minimal');
  await preset(page, 'Playful');
  const after = await sources(page);
  expect(after.map(scene => scene.templateTextOverrides)).toEqual(before.map(scene => scene.templateTextOverrides));
  expect(after.map(scene => scene.elements)).toEqual(before.map(scene => scene.elements));
  await page.reload();
  await expect(page.getByRole('button', { name: /^Playful/ })).toHaveAttribute('aria-pressed', 'true');
});

test('whole-box typography, one-gesture undo, bulk overrides, and reset', async ({ page }) => {
  await open(page);
  await preset(page, 'Classic Story');
  await selectCover(page);
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const tracking = page.getByRole('slider', { name: 'Tracking (em)' });
  await tracking.focus();
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowRight');
  await page.keyboard.up('ArrowRight');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tracking).toHaveValue('0');
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Reset box formatting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByLabel('Typography scope', { exact: true }).selectOption('book');
  await tracking.press('Home');
  for (let step = 0; step < 4; step++) await tracking.press('ArrowRight');
  await expect(tracking).toHaveValue('0.02');
  await tracking.press('ArrowRight');
  await tracking.press('ArrowRight');
  await expect(tracking).toHaveValue('0.04');
  await page.getByLabel('Design scope', { exact: true }).selectOption('book');
  await page.getByRole('button', { name: 'Reset book formatting', exact: true }).click();
  await saved(page);
  expect((await sources(page)).every(scene => !scene.design && !scene.templateStyleOverrides)).toBe(true);
});

test('partial book autosave retains recovery and does not report Saved', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.designFixture.failPage = 'PAGE_3'; });
  await page.getByLabel('Design scope', { exact: true }).selectOption('book');
  await page.getByRole('button', { name: /^Modern Minimal/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Save failed$/ })).toBeVisible();
  expect((await sources(page)).filter(scene => scene.design?.presetId === 'modern')).toHaveLength(7);
  const recovery = await page.evaluate(() => localStorage.getItem('titchybook-recovery:fixture-user:fixture'));
  expect(JSON.parse(recovery!).parts.PAGE_3).toBeDefined();
  await page.reload();
  await saved(page);
  expect((await sources(page)).every(scene => scene.design?.presetId === 'modern')).toBe(true);
});

test('missing fonts are explicit, block printing, and can be retried', async ({ page }) => {
  await open(page, '?failFonts');
  await page.getByRole('button', { name: /^Classic Story/ }).click();
  await expect(page.getByText(/Could not load lora/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit For PDF', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.designFixture.failFonts = false; });
  await page.getByRole('button', { name: 'Retry fonts', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Classic Story text preview', exact: true })).toBeVisible();
  await expect(page.getByText(/Could not load lora/)).toHaveCount(0);
});

test('missing characters require an explicit whole-box font choice', async ({ page }) => {
  await open(page);
  await preset(page, 'Classic Story');
  await selectCover(page);
  await page.getByLabel('Element text', { exact: true }).fill('A story with ĸ');
  await expect(page.getByText(/Choose Source Sans 3 for this whole text box/).first()).toBeVisible();
  await expect(page.getByLabel('Font family', { exact: true })).toHaveValue('Lora');
  await expect(page.getByRole('button', { name: 'Submit For PDF', exact: true })).toBeDisabled();
  await page.getByLabel('Font family', { exact: true }).selectOption('Source Sans 3');
  await expect(page.getByText(/Choose Source Sans 3 for this whole text box/)).toHaveCount(0);
  await saved(page);
  expect(Object.values((await sources(page))[0].templateTextOverrides)).toContain('A story with ĸ');
});

test('overflow blocks print but preserves all text in a saved draft', async ({ page }) => {
  await open(page);
  await preset(page, 'Classic Story');
  await selectCover(page);
  const content = 'A very long title with Émilie and her lantern. '.repeat(30);
  await page.getByLabel('Element text', { exact: true }).fill(content);
  await expect(page.getByText(/Text overflows its frame/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit For PDF', exact: true })).toBeDisabled();
  await saved(page);
  expect(Object.values((await sources(page))[0].templateTextOverrides)).toContain(content);
});
