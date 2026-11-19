import { expect, test, type Page } from '@playwright/test';
import { hash } from 'bcryptjs';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';
import { PAGE_LABEL_DISPLAY, PAGE_LABELS } from '@/lib/constants';
import { parseRenderSnapshot } from '@/lib/pdf/snapshot';
import sharp from 'sharp';
import { Prisma } from '@prisma/client';
import { imageElement, textElement } from '../fixtures/scenes';
import { buildPinnedTemplate, buildTemplateManifest } from '@/lib/ai/template-contract';

const password = 'Isolated-test-password-42!';
let userId: string;
async function openDraft(page: Page) {
  const draft = await createDraft(userId);
  await page.goto(`/create?submissionId=${draft.id}`);
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  return draft.id;
}
async function addText(page: Page, text: string) {
  await page.getByRole('button', { name: 'Add Text Box', exact: true }).click();
  await page.getByRole('textbox', { name: 'Element text', exact: true }).fill(text);
}

test.beforeEach(async ({ page, context }) => {
  const user = await createUser('USER', await hash(password, 10));
  userId = user.id;
  // No storage, email, or AI provider requests are permitted from the browser.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
test.afterEach(async ({ page }) => {
  // Stop autosaves before cleaning only this test's owned fixtures.
  await page.close();
  await cleanupFixtures();
});
test.afterAll(async () => { await db.$disconnect(); });

for (const status of [401, 403, 503, 404]) {
  test(`resume retains pointer and recovery after HTTP ${status}, then retries the same draft`, async ({ page }, testInfo) => {
    const id = await openDraft(page);
    const recoveryKey = `titchybook-recovery:${userId}:${id}`;
    const recovery = JSON.stringify({ version: 1, parts: { title: { value: 'Retained resume work', revision: 0 } } });
    await page.evaluate(({ recoveryKey, recovery }) => localStorage.setItem(recoveryKey, recovery), { recoveryKey, recovery });
    await page.route(`**/api/submissions/${id}`, route => route.request().method() === 'GET'
      ? route.fulfill({ status, contentType: 'application/json', body: '{"error":"Injected draft load failure"}' }) : route.continue());
    let creates = 0;
    page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/submissions') creates++; });
    await page.goto('/create');
    await expect(page.getByRole('button', { name: 'Retry loading draft', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Book title' })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('titchybook-active-editor-draft'))).toBe(id);
    expect(await page.evaluate(key => localStorage.getItem(key), recoveryKey)).toBe(recovery);
    expect(creates).toBe(0);
    expect(await db.submission.count({ where: { userId } })).toBe(1);
    if (status === 404) await expect(page.getByRole('button', { name: 'Create a separate draft', exact: true })).toBeVisible();
    else await expect(page.getByRole('button', { name: 'Create a separate draft', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`batch6-resume-${status}.png`), fullPage: true });
    await page.unroute(`**/api/submissions/${id}`);
    await page.getByRole('button', { name: 'Retry loading draft', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Book title' })).toHaveValue('Retained resume work');
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
    expect(creates).toBe(0);
    expect((await db.submission.findUniqueOrThrow({ where: { id } })).title).toBe('Retained resume work');
  });
}

test('noneditable resume requires an explicit separate-draft decision and preserves the original', async ({ page }) => {
  const id = await openDraft(page);
  await db.submission.update({ where: { id }, data: { status: 'PENDING', pdfS3Key: 'retained/review.pdf' } });
  const original = await db.submission.findUniqueOrThrow({ where: { id } });
  await page.goto('/create');
  await expect(page.getByRole('heading', { name: 'Draft unavailable' })).toBeVisible();
  expect(await db.submission.count({ where: { userId } })).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('titchybook-active-editor-draft'))).toBe(id);
  await page.getByRole('button', { name: 'Create a separate draft', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  expect(await db.submission.count({ where: { userId } })).toBe(2);
  expect(await db.submission.findUniqueOrThrow({ where: { id } })).toEqual(original);
});

test('a newly issued draft is reused when its first load fails', async ({ page }) => {
  let creates = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/submissions') creates++; });
  await page.route(/\/api\/submissions\/[^/]+$/, route => route.request().method() === 'GET'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Injected load failure"}' }) : route.continue());
  await page.goto('/create?new=true');
  await expect(page.getByRole('button', { name: 'Retry loading draft', exact: true })).toBeVisible();
  const id = await page.evaluate(() => localStorage.getItem('titchybook-active-editor-draft'));
  expect(id).toBeTruthy(); expect(creates).toBe(1);
  await page.unroute(/\/api\/submissions\/[^/]+$/);
  await page.getByRole('button', { name: 'Retry loading draft', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  expect(creates).toBe(1);
  expect(await db.submission.count({ where: { userId } })).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('titchybook-active-editor-draft'))).toBe(id);
});

test('offline saving is truthful and reconnect flushes retained changes', async ({ page, context }) => {
  const id = await openDraft(page);
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('textbox', { name: 'Book title' }).fill('Offline retained title');
  await expect(page.getByRole('status').filter({ hasText: 'Offline — unsaved changes' })).toBeVisible();
  expect((await db.submission.findUniqueOrThrow({ where: { id } })).title).not.toBe('Offline retained title');
  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  expect((await db.submission.findUniqueOrThrow({ where: { id } })).title).toBe('Offline retained title');
});

test('protects unsaved image uses before any removal request and surfaces retained-reference denials', async ({ page }, testInfo) => {
  const bytes = await sharp({ create: { width: 24, height: 32, channels: 3, background: 'blue' } }).png().toBuffer();
  const asset = await db.asset.create({ data: { userId, s3Key: `assets/${userId}/fixture.png`, originalFilename: 'Protected photo.png', mimeType: 'image/png', fileSize: bytes.length, width: 24, height: 32 } });
  await page.route(`**/api/assets/${asset.id}/image`, route => route.fulfill({ contentType: 'image/png', body: bytes }));
  const id = await openDraft(page);
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected offline save' }) }) : route.continue());
  let removals = 0;
  page.on('request', request => { if (request.method() === 'DELETE' && request.url().endsWith(`/api/assets/${asset.id}`)) removals++; });
  await page.getByRole('button', { name: /Protected photo\.png/ }).click();
  await page.getByTitle('Remove asset from library', { exact: true }).click();
  await expect(page.getByText('This image is used in the current book, including unsaved pages. Remove its uses before removing it from the library.', { exact: true })).toBeVisible();
  expect(removals).toBe(0);
  expect((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).deletedAt).toBeNull();
  await page.screenshot({ path: testInfo.outputPath('unsaved-asset-protected.png'), fullPage: true });
  await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
  await page.unroute(`**/api/submissions/${id}/pages/*`);
  await page.getByRole('button', { name: 'Retry saving', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  // A different draft is not represented by local UI scenes; the API must guard it.
  const empty = await createDraft(userId);
  await page.goto(`/create?submissionId=${empty.id}`);
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.getByTitle('Remove asset from library', { exact: true }).click();
  await expect(page.getByText('This image is used by saved content or a retained generation. Remove its uses before removing it from the library.', { exact: true })).toBeVisible();
  expect(removals).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('saved-asset-protected.png'), fullPage: true });
});

test('removes an unused library item through the authenticated API while preserving its source identity', async ({ page }) => {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).png().toBuffer();
  const asset = await db.asset.create({ data: { userId, s3Key: `assets/${userId}/unused.png`, originalFilename: 'Unused photo.png', mimeType: 'image/png', fileSize: bytes.length, width: 8, height: 8 } });
  await page.route(`**/api/assets/${asset.id}/image`, route => route.fulfill({ contentType: 'image/png', body: bytes }));
  await openDraft(page);
  await page.getByTitle('Remove asset from library', { exact: true }).click();
  await expect(page.getByText('Image removed from the library. Source bytes retained.', { exact: true })).toBeVisible();
  const row = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
  expect(row.deletedAt).not.toBeNull();
  expect(row.s3Key).toBe(asset.s3Key);
  await expect(page.getByRole('button', { name: /Unused photo\.png/ })).toHaveCount(0);
});

test('renders a frozen template source absent from the author library after the live template changes', async ({ page }, testInfo) => {
  const admin = await createUser('ADMIN');
  const bytes = await sharp({ create: { width: 24, height: 32, channels: 3, background: 'blue' } }).png().toBuffer();
  const asset = await db.asset.create({ data: { userId: admin.id, s3Key: `assets/${admin.id}/pinned.png`, originalFilename: 'Frozen source.png', mimeType: 'image/png', fileSize: bytes.length, width: 24, height: 32 } });
  const template = await createDraft(admin.id, true);
  const pages = [{ pageLabel: 'FRONT_COVER' as const, elements: [imageElement(asset.id)] }];
  const manifest = buildTemplateManifest({ templateId: template.id, templateVersion: 1, pages });
  const pin = buildPinnedTemplate({ templateId: template.id, templateVersion: 1, pages, manifest });
  const draft = await createDraft(userId);
  await db.submission.update({ where: { id: draft.id }, data: { templateId: template.id, pinnedTemplate: pin as unknown as Prisma.InputJsonValue } });
  // Image bytes are mocked; authentication, pin loading, and library lookup use real local APIs.
  await page.route(`**/api/assets/${asset.id}/image`, route => route.fulfill({ contentType: 'image/png', body: bytes }));
  await page.goto(`/create?submissionId=${draft.id}`);
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  expect((await (await page.request.get('/api/assets')).json()).assets).toHaveLength(0);
  const canvas = page.locator('.konvajs-content canvas').first();
  await expect.poll(async () => canvas.evaluate(node => {
    const image = node as HTMLCanvasElement;
    const pixel = image.getContext('2d')!.getImageData(Math.round(image.width * 100 / 700), Math.round(image.height * 80 / 1000), 1, 1).data;
    return pixel[0] < 20 && pixel[1] < 20 && pixel[2] > 230;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('retained-pin-source.png'), fullPage: true });
});

test('saves all eight pages, reopens exact scenes, and submits with the worker paused', async ({ page }) => {
  const id = await openDraft(page);
  await page.getByRole('textbox', { name: 'Book title' }).fill('Eight-page browser regression');
  for (const label of PAGE_LABELS) {
    const pageButton = page.getByRole('button', { name: `Edit ${PAGE_LABEL_DISPLAY[label]}`, exact: true });
    await pageButton.click();
    // Switching pages awaits the outgoing autosave before it commits, and a
    // switch click is ignored while one is already in flight. Wait for
    // aria-current so the elements below cannot land on the page being left,
    // which is what happens when the database is slow enough to widen the gap.
    await expect(pageButton).toHaveAttribute('aria-current', 'page');
    await addText(page, `Unique text ${label}`);
    await page.getByRole('button', { name: 'Add Shape' }).hover();
    await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  }
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const before = await db.submissionPage.findMany({ where: { submissionId: id }, orderBy: { order: 'asc' } });
  expect(before).toHaveLength(8);
  for (const p of before) {
    const elements = JSON.parse(p.sceneJson).elements;
    expect(elements).toHaveLength(2);
    expect(elements[0].text).toBe(`Unique text ${p.pageLabel}`);
    expect(elements[1].type).toBe('shape');
  }
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toHaveValue('Eight-page browser regression');
  const reopened = await page.request.get(`/api/submissions/${id}`);
  expect(reopened.ok()).toBe(true);
  expect((await reopened.json()).submission.pages.map((p: { sceneJson: string }) => p.sceneJson)).toEqual(before.map(p => p.sceneJson));
  await page.getByRole('button', { name: 'Submit For PDF', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('Queued for rendering…', { exact: false })).toBeVisible();
  const job = await db.renderJob.findFirstOrThrow({ where: { submissionId: id } });
  expect(job.status).toBe('QUEUED');
  expect(job.attempts).toBe(0);
  expect(parseRenderSnapshot(job.inputSnapshot).pages.map(p => p.scene)).toEqual(before.map(p => JSON.parse(p.sceneJson)));
});

test('persists guided book styling through authenticated APIs and freezes qualified fonts', async ({ page }) => {
  const id = await openDraft(page);
  await addText(page, 'Émilie and the sea');
  await page.getByLabel('Design scope', { exact: true }).selectOption('book');
  await page.getByRole('button', { name: /^Modern Minimal/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const pages = await db.submissionPage.findMany({ where: { submissionId: id } });
  expect(pages).toHaveLength(8);
  expect(pages.every(p => JSON.parse(p.sceneJson).design?.presetId === 'modern')).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Modern Minimal/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Submit For PDF', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Submit For PDF', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const job = await db.renderJob.findFirstOrThrow({ where: { submissionId: id } });
  const input = parseRenderSnapshot(job.inputSnapshot);
  expect(input.version).toBe(2);
  if (input.version !== 2) throw new Error('Expected a qualified snapshot');
  expect(Object.keys(input.typography!.fonts)).toContain('source-sans-3-400-normal');
  expect(input.pages.find(p => p.pageLabel === 'FRONT_COVER')!.scene.elements[0]).toMatchObject({ text: 'Émilie and the sea', fontFamily: 'Source Sans 3', typographyVersion: 1 });
});

test('failed saves block navigation and submission and recover after retry', async ({ page }) => {
  const id = await openDraft(page);
  let submitRequests = 0;
  page.on('request', request => { if (request.url().endsWith(`/api/submissions/${id}/submit`)) submitRequests++; });
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected save failure' }) }) : route.continue());
  await addText(page, 'Keep this unsaved text');
  await page.getByRole('button', { name: 'Edit Page 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: 'Element text' })).toHaveValue('Keep this unsaved text');
  await page.getByRole('button', { name: 'Submit For PDF', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
  expect(submitRequests).toBe(0);
  expect(await db.renderJob.count({ where: { submissionId: id } })).toBe(0);
  await page.unroute(`**/api/submissions/${id}/pages/*`);
  // A successful retry unmounts this button immediately; dispatch directly so
  // Playwright does not retry the click against a detached element.
  await page.getByRole('button', { name: 'Retry saving', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Keep this unsaved text');
});

test('a stale tab cannot overwrite a newer title and retains its local edits', async ({ page, context }) => {
  const id = await openDraft(page);
  const second = await context.newPage();
  try {
    await second.goto(`/create?submissionId=${id}`);
    await expect(second.getByRole('textbox', { name: 'Book title' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Book title' }).fill('Newer server title');
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
    await second.getByRole('textbox', { name: 'Book title' }).fill('Stale tab local title');
    await expect(second.getByRole('status').filter({ hasText: 'Save conflict' })).toBeVisible();
    expect((await db.submission.findUniqueOrThrow({ where: { id } })).title).toBe('Newer server title');
    await expect(second.getByRole('textbox', { name: 'Book title' })).toHaveValue('Stale tab local title');
    const recovery = await second.evaluate(key => localStorage.getItem(key), `titchybook-recovery:${userId}:${id}`);
    expect(JSON.parse(recovery!).parts.title.value).toBe('Stale tab local title');
    await second.getByRole('button', { name: 'Review recovery copy', exact: true }).click();
    const copy = JSON.parse(await second.getByRole('textbox', { name: 'Local recovery JSON' }).inputValue());
    expect(copy.parts.title.value).toBe('Stale tab local title');
    expect(copy.parts.title.revision).toBe(0);
    const download = second.waitForEvent('download');
    await second.getByRole('button', { name: 'Download recovery JSON', exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`titchybook-${id}-recovery.json`);
    const stream = await file.createReadStream();
    if (!stream) throw new Error('Download stream unavailable');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const downloaded = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(downloaded.parts.title).toEqual({ value: 'Stale tab local title', revision: 0 });
    await second.getByRole('button', { name: 'Submit For PDF', exact: true }).click();
    await expect(second.getByRole('status').filter({ hasText: 'Save conflict' })).toBeVisible();
    // Retry stays enabled while conflicted: the per-part 409 fence keeps the
    // stale title out of every write, so retrying can never overwrite the
    // newer server title.
    await second.getByRole('button', { name: 'Retry saving', exact: true }).dispatchEvent('click');
    await expect(second.getByRole('status').filter({ hasText: 'Save conflict' })).toBeVisible();
    expect(await db.renderJob.count({ where: { submissionId: id } })).toBe(0);
    expect((await db.submission.findUniqueOrThrow({ where: { id } })).title).toBe('Newer server title');
  } finally { await second.close(); }
});

test('applies AI text across pages only after the outgoing save succeeds', async ({ page }) => {
  const id = await openDraft(page);
  const suggestion = JSON.stringify({ message: 'Suggested text', suggestions: [{ id: 'ai-one', label: 'Page two text', targetPage: 'PAGE_2', text: 'AI text for page two' }] });
  await page.route('**/api/ai/chat', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ token: suggestion })}\n\ndata: {"done":true}\n\n` }));
  await page.route(`**/api/submissions/${id}/pages/FRONT_COVER`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Injected failure"}' }) : route.continue());
  await addText(page, 'Outgoing text');
  await page.getByRole('button', { name: 'AI Assistant', exact: true }).click();
  await page.getByPlaceholder('Ask me to write something...').fill('Write page two');
  await page.getByPlaceholder('Ask me to write something...').press('Enter');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.unroute(`**/api/submissions/${id}/pages/FRONT_COVER`);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Applied', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const pages = await db.submissionPage.findMany({ where: { submissionId: id }, orderBy: { order: 'asc' } });
  expect(JSON.parse(pages[0].sceneJson).elements[0].text).toBe('Outgoing text');
  expect(JSON.parse(pages[2].sceneJson).elements[0].text).toBe('AI text for page two');
});

test('restores local unsaved edits after reload without creating another draft', async ({ page }) => {
  const id = await openDraft(page);
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
    ? route.abort() : route.continue());
  await addText(page, 'Recover after reload');
  await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.unroute(`**/api/submissions/${id}/pages/*`);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Recover after reload');
  expect(await db.submission.count({ where: { userId } })).toBe(1);
});

test('arrow buttons navigate in reading order and commit the outgoing save', async ({ page }) => {
  const id = await openDraft(page);
  await addText(page, 'Arrow navigation text');
  await expect(page.getByText('Page 1 of 8', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Page 2 of 8', { exact: true })).toBeVisible();
  // The switch only commits after the outgoing page flushed successfully.
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Arrow navigation text');
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  // The filmstrip jumps anywhere; Next is disabled at the reading-order end.
  await page.getByRole('button', { name: 'Edit Back Cover', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Back Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Page 8 of 8', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
});

test('keyboard arrows navigate pages but never while typing in a field', async ({ page }) => {
  await openDraft(page);
  const front = page.getByRole('button', { name: 'Edit Front Cover', exact: true });
  const second = page.getByRole('button', { name: 'Edit Page 2', exact: true });
  await page.getByRole('button', { name: 'Next page', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(second).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ArrowLeft');
  await expect(front).toHaveAttribute('aria-current', 'page');
  // Arrow keys belong to the caret while the title field has focus.
  await page.getByRole('textbox', { name: 'Book title' }).fill('Keyboard guard');
  await page.keyboard.press('ArrowRight');
  await expect(front).toHaveAttribute('aria-current', 'page');
  // Same inside the element text field.
  await addText(page, 'Typing guard');
  await page.keyboard.press('ArrowRight');
  await expect(front).toHaveAttribute('aria-current', 'page');
  // PageDown/PageUp mirror the arrows outside form controls.
  await page.getByRole('button', { name: 'Next page', exact: true }).focus();
  await page.keyboard.press('PageDown');
  await expect(second).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('PageUp');
  await expect(front).toHaveAttribute('aria-current', 'page');
});

test.describe('touch swipe navigation', () => {
  test.use({ hasTouch: true });

  async function swipe(page: Page, fromX: number, fromY: number, dx: number) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY }] });
    for (let step = 1; step <= 6; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX + (dx * step) / 6, y: fromY }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  test('swiping the stage background navigates and a failed save blocks it', async ({ page }) => {
    const id = await openDraft(page);
    const stage = page.locator('.konvajs-content');
    await expect(stage).toBeVisible();
    const box = (await stage.boundingBox())!;
    // Gesture stays on empty background well below any placed element.
    const y = box.y + box.height * 0.85;
    const distance = Math.min(200, box.width * 0.6);
    await swipe(page, box.x + box.width * 0.8, y, -distance);
    await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
    await swipe(page, box.x + box.width * 0.2, y, distance);
    await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
    // An injected save failure blocks the swipe exactly like a click.
    await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected save failure' }) }) : route.continue());
    await addText(page, 'Swipe blocked text');
    await swipe(page, box.x + box.width * 0.8, y, -distance);
    await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Element text' })).toHaveValue('Swipe blocked text');
  });
});

test('booklet preview shows all eight pages and jumps straight to a page', async ({ page }) => {
  await openDraft(page);
  await page.getByRole('textbox', { name: 'Book title' }).fill('Preview overview book');
  await addText(page, 'Front cover words');
  await page.getByRole('button', { name: 'Preview booklet', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Preview overview book' })).toBeVisible();
  for (const label of PAGE_LABELS) {
    await expect(dialog.getByRole('button', { name: `Go to ${PAGE_LABEL_DISPLAY[label]}`, exact: true })).toBeVisible();
    await expect(dialog.getByAltText(`${PAGE_LABEL_DISPLAY[label]} booklet preview`)).toBeVisible();
  }
  await dialog.getByRole('button', { name: 'Go to Page 4', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Page 4', exact: true })).toHaveAttribute('aria-current', 'page');
  // Escape closes the dialog and focus returns to the trigger button.
  await page.getByRole('button', { name: 'Preview booklet', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Preview booklet', exact: true })).toBeFocused();
});

test('canvas stays visible while the tools rail scrolls independently', async ({ page }) => {
  await openDraft(page);
  await addText(page, 'Rail scroll visibility');
  const rail = page.getByTestId('editor-tools-rail');
  const stage = page.locator('.konvajs-content');
  const viewport = page.viewportSize()!;
  // At xl the rail owns its overflow; the document itself must not scroll.
  expect(await rail.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await rail.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // The deepest rail content is reachable inside the viewport...
  const deepHint = rail.getByText('Click any thumbnail to place another copy on the current page.');
  const hintBox = (await deepHint.boundingBox())!;
  expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(viewport.height);
  // ...while the canvas remains fully in view at the same time.
  const box = (await stage.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  // Editing a property auto-scrolls the rail, never the page or the canvas.
  await page.getByRole('textbox', { name: 'Element text', exact: true }).fill('Edited from the rail');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await stage.boundingBox()).toEqual(box);
});

test('save-error banner shrinks the frame instead of pushing the rail off-screen', async ({ page }) => {
  const id = await openDraft(page);
  await addText(page, 'Banner frame text');
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected save failure' }) }) : route.continue());
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  // The failed flush blocks navigation and mounts the alert banner.
  await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('alert').filter({ hasText: 'Injected save failure' })).toBeVisible();
  const rail = page.getByTestId('editor-tools-rail');
  const viewport = page.viewportSize()!;
  // The banner lives inside the height-constrained frame, so the document
  // still does not scroll and the deepest rail content stays reachable.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await rail.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const deepHint = rail.getByText('Click any thumbnail to place another copy on the current page.');
  const hintBox = (await deepHint.boundingBox())!;
  expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(viewport.height);
  const stageBox = (await page.locator('.konvajs-content').boundingBox())!;
  expect(stageBox.y).toBeGreaterThanOrEqual(0);
  expect(stageBox.y + stageBox.height).toBeLessThanOrEqual(viewport.height);
});

async function startInlineEdit(page: Page, text: string) {
  await page.getByRole('button', { name: 'Add Text Box', exact: true }).click();
  const box = (await page.locator('.konvajs-content').boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * 0.15, box.y + box.height * 0.105);
  const inline = page.getByRole('textbox', { name: 'Edit text on page' });
  await expect(inline).toBeVisible();
  await inline.fill(text);
  return inline;
}

for (const path of ['filmstrip', 'arrow', 'preview', 'header', 'submit'] as const) {
  test(`inline typing survives ${path} navigation before blur`, async ({ page }, testInfo) => {
    const id = await openDraft(page);
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
    await startInlineEdit(page, `Retained inline ${path}`);
    const recovery = await page.evaluate(key => localStorage.getItem(key), `titchybook-recovery:${userId}:${id}`);
    expect(JSON.parse(JSON.parse(recovery!).parts.FRONT_COVER.value).elements[0].text).toBe(`Retained inline ${path}`);
    if (path === 'filmstrip') await page.getByRole('button', { name: 'Edit Page 2', exact: true }).dispatchEvent('click');
    if (path === 'arrow') await page.getByRole('button', { name: 'Next page', exact: true }).dispatchEvent('click');
    if (path === 'preview') {
      await page.getByRole('button', { name: 'Preview booklet', exact: true }).dispatchEvent('click');
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('batch6-inline-preview.png'), fullPage: true });
    }
    if (path === 'header') await page.getByRole('link', { name: 'Dashboard', exact: true }).dispatchEvent('click');
    if (path === 'submit') await page.getByRole('button', { name: 'Submit For PDF', exact: true }).dispatchEvent('click');
    if (path === 'filmstrip' || path === 'arrow') await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
    if (path === 'header' || path === 'submit') await expect(page).toHaveURL(/\/dashboard$/);
    if (path === 'preview') await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
    const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
    expect(JSON.parse(saved.sceneJson).elements[0].text).toBe(`Retained inline ${path}`);
    if (path === 'submit') {
      const job = await db.renderJob.findFirstOrThrow({ where: { submissionId: id } });
      expect(parseRenderSnapshot(job.inputSnapshot).pages.find(p => p.pageLabel === 'FRONT_COVER')!.scene.elements[0]).toMatchObject({ text: `Retained inline ${path}` });
    }
  });
}

test('failed inline saves block header navigation and logout, retaining a recovery copy', async ({ page }) => {
  const id = await openDraft(page);
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Injected save failure"}' }) : route.continue());
  await startInlineEdit(page, 'Inline retained before leaving');
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/create\\?submissionId=${id}`));
  let signouts = 0;
  page.on('request', request => { if (request.url().includes('/api/auth/signout')) signouts++; });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
  expect(signouts).toBe(0);
  await page.getByRole('button', { name: 'Review recovery copy', exact: true }).click();
  const copy = JSON.parse(await page.getByRole('textbox', { name: 'Local recovery JSON' }).inputValue());
  expect(JSON.parse(copy.parts.FRONT_COVER.value).elements[0].text).toBe('Inline retained before leaving');
  await page.unroute(`**/api/submissions/${id}/pages/*`);
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('inline typing survives reload without a blur or successful save', async ({ page }) => {
  const id = await openDraft(page);
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await startInlineEdit(page, 'Inline recovered after reload');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.unroute(`**/api/submissions/${id}/pages/*`);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Inline recovered after reload');
  expect(await db.submission.count({ where: { userId } })).toBe(1);
});

test('slow inline saving coalesces current text and blocks navigation until acknowledged', async ({ page }) => {
  const id = await openDraft(page);
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  await page.route(`**/api/submissions/${id}/pages/*`, async route => {
    if (route.request().method() === 'PUT' && first) { first = false; await held; }
    await route.continue();
  });
  const inline = await startInlineEdit(page, 'First slow inline text');
  await expect(page.getByRole('status').filter({ hasText: /^Saving/ })).toBeVisible();
  await inline.fill('Latest slow inline text');
  await page.getByRole('button', { name: 'Next page', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('button', { name: 'Edit Front Cover', exact: true })).toHaveAttribute('aria-current', 'page');
  release();
  await expect(page.getByRole('button', { name: 'Edit Page 2', exact: true })).toHaveAttribute('aria-current', 'page');
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Latest slow inline text');
});

test('storage denial retains typing in the open tab, blocks failed leaving, and permits server retry', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new Error('Injected recovery storage denial'); };
    Storage.prototype.removeItem = () => { throw new Error('Injected recovery storage denial'); };
  });
  const id = await openDraft(page);
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await startInlineEdit(page, 'Retained without storage');
  await expect(page.getByText('Local recovery storage is unavailable. Keep this tab open until changes are saved.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/create');
  await page.getByRole('button', { name: 'Review recovery copy', exact: true }).click();
  const copy = JSON.parse(await page.getByRole('textbox', { name: 'Local recovery JSON' }).inputValue());
  expect(JSON.parse(copy.parts.FRONT_COVER.value).elements[0].text).toBe('Retained without storage');
  await page.unroute(`**/api/submissions/${id}/pages/*`);
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Retained without storage');
});

test('browser back and forward retain unsaved inline recovery', async ({ page }) => {
  const id = await openDraft(page);
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('link', { name: 'Continue editing', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.route(`**/api/submissions/${id}/pages/*`, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await startInlineEdit(page, 'Inline retained through browser history');
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  const recovery = await page.evaluate(key => localStorage.getItem(key), `titchybook-recovery:${userId}:${id}`);
  expect(JSON.parse(JSON.parse(recovery!).parts.FRONT_COVER.value).elements[0].text).toBe('Inline retained through browser history');
  await page.goForward();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.unroute(`**/api/submissions/${id}/pages/*`);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const saved = await db.submissionPage.findUniqueOrThrow({ where: { submissionId_pageLabel: { submissionId: id, pageLabel: 'FRONT_COVER' } } });
  expect(JSON.parse(saved.sceneJson).elements[0].text).toBe('Inline retained through browser history');
});

test('rejected correction copies and resubmits pages while retaining the original review and PDFs', async ({ page }, testInfo) => {
  const id = await openDraft(page);
  await addText(page, 'Original rejected text');
  await page.getByRole('textbox', { name: 'Book title' }).fill('Correction source');
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  const admin = await createUser('ADMIN');
  const template = await createDraft(admin.id, true);
  const pinnedText = { ...textElement('frozen-correction-design', 'Frozen template design'), x: 30, y: 600, width: 600, height: 100, locked: true };
  const pinPages = [{ pageLabel: 'FRONT_COVER' as const, elements: [pinnedText] }];
  const manifest = buildTemplateManifest({ templateId: template.id, templateVersion: 1, pages: pinPages });
  const pin = buildPinnedTemplate({ templateId: template.id, templateVersion: 1, pages: pinPages, manifest });
  await db.submission.update({ where: { id }, data: { status: 'REJECTED', rejectionReason: 'Please correct the first page text.', pdfS3Key: 'retained/original.pdf', readingPdfS3Key: 'retained/original-reading.pdf', templateId: template.id, templateVersion: 1, pinnedTemplate: pin as unknown as Prisma.InputJsonValue } });
  // A changed live source must not replace the original or correction's frozen pin.
  await db.submission.update({ where: { id: template.id }, data: { version: 2, title: 'Changed live template' } });
  const original = await db.submission.findUniqueOrThrow({ where: { id }, include: { pages: { orderBy: { order: 'asc' } } } });
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Make a correction copy', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Book title' })).toHaveValue('Correction source (copy)');
  const copyId = new URL(page.url()).searchParams.get('submissionId')!;
  const copyPages = await db.submissionPage.findMany({ where: { submissionId: copyId }, orderBy: { order: 'asc' } });
  expect(copyPages.map(p => p.sceneJson)).toEqual(original.pages.map(p => p.sceneJson));
  const copied = await db.submission.findUniqueOrThrow({ where: { id: copyId } });
  expect(copied).toMatchObject({ templateId: template.id, templateVersion: 1, pinnedTemplate: original.pinnedTemplate });
  const stage = (await page.locator('.konvajs-content').boundingBox())!;
  await page.mouse.click(stage.x + stage.width * 0.15, stage.y + stage.height * 0.105);
  await page.getByRole('textbox', { name: 'Element text', exact: true }).fill('Corrected text for review');
  await page.getByRole('button', { name: 'Submit For PDF', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const job = await db.renderJob.findFirstOrThrow({ where: { submissionId: copyId } });
  expect(parseRenderSnapshot(job.inputSnapshot).pages[0].scene.elements).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: 'Corrected text for review' }),
    expect.objectContaining({ id: 'frozen-correction-design', text: 'Frozen template design' }),
  ]));
  expect(await db.submission.findUniqueOrThrow({ where: { id }, include: { pages: { orderBy: { order: 'asc' } } } })).toEqual(original);
  await page.screenshot({ path: testInfo.outputPath('batch6-correction-original-retained.png'), fullPage: true });
});

test('double-click edits text directly inside the canvas text box', async ({ page }) => {
  await openDraft(page);
  await page.getByRole('button', { name: 'Add Text Box', exact: true }).click();
  const stage = page.locator('.konvajs-content');
  const box = (await stage.boundingBox())!;
  // The default text box starts at scene (72, 88) on a 700x1000 page; aim
  // at the first line's glyphs because Konva hit-testing is pixel-based.
  const textPoint = { x: box.x + box.width * 0.15, y: box.y + box.height * 0.105 };
  const inline = page.getByRole('textbox', { name: 'Edit text on page' });
  const railText = page.getByRole('textbox', { name: 'Element text', exact: true });
  await page.mouse.dblclick(textPoint.x, textPoint.y);
  await expect(inline).toBeVisible();
  await expect(inline).toHaveValue('Add your story here');
  await inline.fill('Typed directly on the page');
  await inline.press('Control+Enter');
  await expect(inline).toHaveCount(0);
  await expect(railText).toHaveValue('Typed directly on the page');
  // A whole editing session is a single undo step.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(railText).toHaveValue('Add your story here');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(railText).toHaveValue('Typed directly on the page');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  // Escape cancels without touching the stored text.
  await page.mouse.dblclick(textPoint.x, textPoint.y);
  await expect(inline).toBeVisible();
  await inline.fill('Discarded edit');
  await inline.press('Escape');
  await expect(inline).toHaveCount(0);
  await expect(railText).toHaveValue('Add your story here');
  // Clicking away (blur) commits the edit.
  await page.mouse.dblclick(textPoint.x, textPoint.y);
  await expect(inline).toBeVisible();
  await inline.fill('Committed by blur');
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.9);
  await expect(inline).toHaveCount(0);
  // The background click also deselects; reselect to inspect the commit.
  await page.mouse.click(textPoint.x, textPoint.y);
  await expect(railText).toHaveValue('Committed by blur');
  // Ending the inline session must bring the resize controls back: dragging
  // the top-left Transformer anchor resizes the box instead of moving it.
  const widthInput = page.locator('label:has(span:text-is("Width")) + input');
  const widthBefore = await widthInput.inputValue();
  const scale = box.width / 700;
  const corner = { x: box.x + 72 * scale, y: box.y + 88 * scale };
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 60, corner.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(widthInput).not.toHaveValue(widthBefore);
});

test('Add Shape menu paints above the background color picker', async ({ page }) => {
  await openDraft(page);
  // The status label affects toolbar geometry; measure the settled saved layout.
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  // Below md the page-info row stacks left-aligned, putting the picker
  // trigger under the toolbar's Add Shape menu. Zooming out lets the
  // toolbar fit one row (media queries stay viewport-based), which brings
  // the open menu down over the picker exactly like a zoomed-out window.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = '0.75'; });
  await page.getByRole('button', { name: 'Add Shape' }).hover();
  const menu = page.getByTestId('add-shape-menu');
  await expect(menu).toBeVisible();
  const menuBox = (await menu.boundingBox())!;
  const triggerBoxes = [
    await page.getByRole('button', { name: /Open color picker/ }).boundingBox(),
    await page.getByPlaceholder('#000000').boundingBox(),
  ];
  const centers = triggerBoxes
    .filter((box): box is NonNullable<typeof box> => Boolean(box))
    .map(box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 }));
  const overlap = centers.find(point =>
    point.x >= menuBox.x && point.x <= menuBox.x + menuBox.width &&
    point.y >= menuBox.y && point.y <= menuBox.y + menuBox.height);
  expect(overlap, `menu ${JSON.stringify(menuBox)} must overlap picker ${JSON.stringify(triggerBoxes)}`).toBeTruthy();
  // Hit-testing proves paint order: the topmost node at the shared point
  // must belong to the menu, not the swatch/hex input painted over it.
  const topIsMenu = await page.evaluate(([x, y]) => {
    const node = document.elementFromPoint(x, y);
    return Boolean(node && node.closest('[data-testid="add-shape-menu"]'));
  }, [overlap!.x, overlap!.y]);
  expect(topIsMenu).toBe(true);
  // Playwright's hit-target check also rejects an obscured menu click.
  await menu.getByRole('button', { name: 'Rectangle', exact: true }).click();
});
