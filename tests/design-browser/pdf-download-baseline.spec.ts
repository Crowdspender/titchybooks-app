import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

// Batch 2 regressions replacing Batch 0 characterization. UI is production code;
// HTTP/storage responses here are controlled fixtures, not provider acceptance.
// Full Chromium supports the inline PDF viewer; headless-shell does not.
test.use({ channel: 'chromium' });
test.beforeEach(async ({ context, request }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:3200'
    ? route.continue() : route.abort());
  await expect(await request.post('/fixtures/reset')).toBeOK();
});
async function open(page: Page, mode: string) {
  await page.goto(`/tests/browser-fixtures/design.html?pdfCase=${mode}`);
  await expect(page.getByRole('link', { name: 'Download print sheet', exact: true })).toBeVisible();
}
async function truthful(page: Page) {
  await expect(page.getByRole('status')).toContainText('Download requested—check your browser downloads');
  await expect(page.getByRole('status')).not.toContainText('Saved successfully');
  await expect(page.getByRole('link', { name: 'Download print sheet', exact: true })).toBeEnabled();
}

for (const kind of ['print', 'reading'] as const) {
  test(`${kind} native attachment saves exact bytes with the correct filename and geometry`, async ({ page, request }, info) => {
    await open(page, 'normal');
    const manifest = (await (await request.get('/fixtures/download-manifest')).json())[kind];
    const pending = page.waitForEvent('download');
    await page.getByRole('link', { name: kind === 'print' ? 'Download print sheet' : 'Download reading PDF', exact: true }).click();
    const download = await pending;
    const path = info.outputPath(`${kind}.pdf`);
    await download.saveAs(path);
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe(`controlled-pdf-download-${kind === 'print' ? 'print-sheet-a4-fold' : 'reading-74x105mm'}.pdf`);
    const bytes = await readFile(path);
    expect(bytes.length).toBe(manifest.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(kind === 'print' ? 1 : 8);
    for (const p of doc.getPages()) {
      expect(p.getWidth() * 25.4 / 72).toBeCloseTo(kind === 'print' ? 297 : 74, 3);
      expect(p.getHeight() * 25.4 / 72).toBeCloseTo(kind === 'print' ? 210 : 105, 3);
    }
    await truthful(page);
    await info.attach('transfer-evidence', { body: JSON.stringify({ manifest, filename: download.suggestedFilename(), saved: true }), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('normal-download.png'), fullPage: true });
  });
}

test('slow transfer reports only initiation, stays usable, and completes without an indefinite spinner', async ({ page }, info) => {
  await open(page, 'slow');
  const started = Date.now();
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download print sheet', exact: true }).click();
  const download = await pending;
  await truthful(page);
  await download.saveAs(info.outputPath('slow-print.pdf'));
  expect(await download.failure()).toBeNull();
  expect(Date.now() - started).toBeGreaterThan(1500);
  await truthful(page);
});

test('interrupted transfer fails in browser downloads and never claims disk-save success', async ({ page }, info) => {
  await open(page, 'interrupted');
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download print sheet', exact: true }).click();
  const failure = await (await pending).failure();
  expect(failure).not.toBeNull();
  await truthful(page);
  await expect(page.getByRole('status')).toContainText('retry the download link');
  await info.attach('interrupted-transfer', { body: JSON.stringify({ failure }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('interrupted-download.png'), fullPage: true });
});

for (const mode of ['missing', 'unauthenticated']) {
  test(`${mode} produces a visible error and retry instead of an attachment`, async ({ page }, info) => {
    await open(page, mode);
    let downloads = 0;
    page.on('download', () => downloads++);
    await page.getByRole('link', { name: 'Download print sheet', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(mode === 'missing' ? 'stored PDF is missing' : 'Sign in');
    await expect(page.getByRole('link', { name: 'Retry PDF request' })).toBeVisible();
    expect(downloads).toBe(0);
    await page.screenshot({ path: info.outputPath('http-error.png'), fullPage: true });
  });
}

test('HTTP failure is visible and a recovered retry saves a valid PDF', async ({ page, request }, info) => {
  await open(page, 'error');
  await page.getByRole('link', { name: 'Download print sheet', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be started');
  await request.post('/fixtures/recover');
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Retry PDF request' }).click();
  const download = await pending;
  await download.saveAs(info.outputPath('retry.pdf'));
  expect(await download.failure()).toBeNull();
  expect((await PDFDocument.load(await readFile(info.outputPath('retry.pdf')))).getPageCount()).toBe(1);
});

test('an inline reading retry keeps kind and disposition after recovery', async ({ page, request }) => {
  await page.goto('/api/submissions/download-fixture-error/downloads?kind=reading&disposition=inline');
  await expect(page.getByRole('alert')).toContainText('could not be started');
  const retry = page.getByRole('link', { name: 'Retry PDF request' });
  const href = await retry.getAttribute('href');
  expect(href).toContain('kind=reading');
  expect(href).toContain('disposition=inline');
  await request.post('/fixtures/recover');
  const response = await request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-disposition']).toMatch(/^inline; filename="controlled-pdf-download-reading-74x105mm\.pdf"/);
  expect((await PDFDocument.load(await response.body())).getPageCount()).toBe(8);
});

test('a hostile kind value is normalized out of the error page markup', async ({ page }) => {
  await page.goto('/api/submissions/download-fixture-error/downloads?kind=%22%3E%3Cscript%3Ealert(1)%3C/script%3E&disposition=%22onmouseover%3D%22alert(1)');
  await expect(page.getByRole('alert')).toContainText('could not be started');
  const retry = page.getByRole('link', { name: 'Retry PDF request' });
  await expect(retry).toBeVisible();
  expect(await retry.getAttribute('href')).toMatch(/\?kind=print&disposition=attachment$/);
  expect(await page.locator('script').count()).toBe(0);
});

test('preview is a separate inline native link', async ({ page, context, request }, info) => {
  await open(page, 'normal');
  const preview = page.getByRole('link', { name: 'Preview reading PDF', exact: true });
  await expect(preview).toHaveAttribute('target', '_blank');
  const href = await preview.getAttribute('href');
  expect(href).toContain('kind=reading&disposition=inline');
  const response = await request.get(href!);
  expect(response.headers()['content-disposition']).toMatch(/^inline;/);
  // Capture the popup's own navigation response: a 500 in the new tab must
  // fail the test even when the separate API request succeeds.
  const popupResponse = context.waitForEvent('response', candidate =>
    candidate.request().isNavigationRequest() && candidate.url().endsWith(href!));
  const popup = page.waitForEvent('popup');
  await preview.click();
  const opened = await popup;
  const navigation = await popupResponse;
  expect(navigation.status()).toBe(200);
  expect(navigation.headers()['content-type']).toContain('application/pdf');
  expect(navigation.headers()['content-disposition']).toMatch(/^inline;/);
  await opened.waitForURL('**/*disposition=inline', { timeout: 15000 });
  expect(opened.url()).toContain('disposition=inline');
  await opened.screenshot({ path: info.outputPath('inline-preview.png') });
});
test('historical print-only UI keeps print available and labels reading unavailable', async ({ page }) => {
  await open(page, 'legacy');
  await expect(page.getByRole('link', { name: 'Download reading PDF', exact: true })).toHaveCount(0);
  await expect(page.getByText('Reading PDF unavailable for this book.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Preview print sheet', exact: true })).toBeVisible();
});

test('download actions fit a mobile viewport without horizontal page overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, 'normal');
  await page.screenshot({ path: info.outputPath('mobile-downloads.png'), fullPage: true });
  const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(width.page).toBeLessThanOrEqual(width.viewport);
});

test('attachment download does not depend on window.open or a metadata fetch', async ({ page }, info) => {
  await open(page, 'normal');
  await page.evaluate(() => {
    window.open = () => { throw new Error('window.open must not be used'); };
    window.fetch = () => { throw new Error('Download must not fetch metadata'); };
  });
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download print sheet', exact: true }).click();
  const download = await pending;
  await download.saveAs(info.outputPath('no-popup.pdf'));
  expect(await download.failure()).toBeNull();
  await truthful(page);
});
