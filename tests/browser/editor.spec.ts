import { expect, test, type Page } from '@playwright/test';
import { hash } from 'bcryptjs';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';
import { PAGE_LABEL_DISPLAY, PAGE_LABELS } from '@/lib/constants';
import { parseRenderSnapshot } from '@/lib/pdf/snapshot';

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

test('saves all eight pages, reopens exact scenes, and submits with the worker paused', async ({ page }) => {
  const id = await openDraft(page);
  await page.getByRole('textbox', { name: 'Book title' }).fill('Eight-page browser regression');
  for (const label of PAGE_LABELS) {
    await page.getByRole('button', { name: `Edit ${PAGE_LABEL_DISPLAY[label]}`, exact: true }).click();
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
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
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
    await expect(second.getByRole('status').filter({ hasText: 'Save failed' })).toBeVisible();
    expect((await db.submission.findUniqueOrThrow({ where: { id } })).title).toBe('Newer server title');
    await expect(second.getByRole('textbox', { name: 'Book title' })).toHaveValue('Stale tab local title');
    const recovery = await second.evaluate(key => localStorage.getItem(key), `titchybook-recovery:${userId}:${id}`);
    expect(JSON.parse(recovery!).parts.title.value).toBe('Stale tab local title');
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
