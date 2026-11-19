import { expect, test, type Page } from '@playwright/test';
import { hash } from 'bcryptjs';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';

const password = 'Isolated-review-regression-42!';
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function reviewFixture(page: Page) {
  const owner = await createUser();
  const admin = await createUser('ADMIN', await hash(password, 10));
  const draft = await createDraft(owner.id);
  await db.submission.update({ where: { id: draft.id }, data: { status: 'PENDING', title: 'Review fixture', pdfS3Key: 'retained/review.pdf' } });
  await login(page, admin.email);
  await page.goto('/admin');
  const row = page.getByRole('row').filter({ hasText: 'Review fixture' });
  await expect(row.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
  return { id: draft.id, row };
}
test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
});
test.afterEach(async ({ page }) => { await page.close(); await cleanupFixtures(); });
test.afterAll(async () => { await db.$disconnect(); });

test('nonpending submission actions render a real dash at desktop and mobile sizes', async ({ page }, testInfo) => {
  const owner = await createUser();
  const admin = await createUser('ADMIN', await hash(password, 10));
  const draft = await createDraft(owner.id);
  await db.submission.update({ where: { id: draft.id }, data: { title: 'Nonpending action evidence' } });
  await login(page, admin.email);
  await page.goto('/admin');
  const row = page.getByRole('main').getByRole('row').filter({ hasText: 'Nonpending action evidence' });
  const actions = row.getByRole('cell').last();
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(actions).toHaveText('—');
    await expect(row).not.toContainText('\\u2014');
    await expect(row.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
    await actions.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach(`Admin actions ${width}px`, {
      body: await page.screenshot({ path: `test-results/batch6-admin-dash-${width}.png`, fullPage: true }),
      contentType: 'image/png',
    });
  }
});

test('cancel and invalid correction explanations issue zero moderation requests', async ({ page }) => {
  const { id, row } = await reviewFixture(page);
  const original = await db.submission.findUniqueOrThrow({ where: { id } });
  let requests = 0;
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(`/api/admin/submissions/${id}`)) requests++; });
  page.once('dialog', dialog => dialog.dismiss());
  await row.getByRole('button', { name: 'Reject', exact: true }).click();
  for (const reason of ['', '    ', 'Short', 'x'.repeat(1001)]) {
    page.once('dialog', dialog => dialog.accept(reason));
    await row.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Explain the required correction in 10–1000 characters.' })).toBeVisible();
  }
  expect(requests).toBe(0);
  expect(await db.submission.findUniqueOrThrow({ where: { id } })).toEqual(original);
});

test('moderation locks repeated actions, surfaces server failure, then retries the same review', async ({ page }, testInfo) => {
  const { id, row } = await reviewFixture(page);
  const original = await db.submission.findUniqueOrThrow({ where: { id } });
  let requests = 0;
  // Test-wide counter independent of the failure route: a duplicate PATCH
  // dispatched late must still be visible after the route is removed.
  let totalPatches = 0;
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(`/api/admin/submissions/${id}`)) totalPatches++; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/admin/submissions/${id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    requests++;
    await held;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Injected review unavailable; reload and retry."}' });
  });
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
  await row.getByRole('button', { name: 'Approve', exact: true }).dispatchEvent('click');
  await row.getByRole('button', { name: 'Reject', exact: true }).dispatchEvent('click');
  expect(requests).toBe(1);
  release();
  await expect(page.getByRole('alert').filter({ hasText: 'Injected review unavailable' })).toBeVisible();
  expect(await db.submission.findUniqueOrThrow({ where: { id } })).toEqual(original);
  expect(requests).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('batch6-review-server-error.png'), fullPage: true });
  await page.unroute(`**/api/admin/submissions/${id}`);
  await page.getByRole('button', { name: 'Reload submissions', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
  page.once('dialog', dialog => dialog.accept('  Please correct the cover text.  '));
  await row.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(row.getByText('Correction needed: Please correct the cover text.')).toBeVisible();
  const rejected = await db.submission.findUniqueOrThrow({ where: { id } });
  expect(rejected).toEqual({ ...original, status: 'REJECTED', rejectionReason: 'Please correct the cover text.', updatedAt: rejected.updatedAt });
  // Only the original approval and the intended rejection ever left the page.
  expect(totalPatches).toBe(2);
});

test('admin list failures are contextual and mobile filters remain reachable', async ({ page }, testInfo) => {
  const admin = await createUser('ADMIN', await hash(password, 10));
  await login(page, admin.email);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/api\/admin\/submissions(?:\?.*)?$/, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Injected submission list unavailable"}' }));
  await page.goto('/admin');
  await expect(page.getByRole('alert').filter({ hasText: 'Injected submission list unavailable' })).toBeVisible();
  await expect(page.getByText('No submissions yet', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('batch6-admin-mobile-error.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.unroute(/\/api\/admin\/submissions(?:\?.*)?$/);
  // Consume the retry's own response before the loop so the first filter
  // cannot pass on it.
  const retry = page.waitForResponse(res => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/admin/submissions');
  await page.getByRole('button', { name: 'Retry loading submissions', exact: true }).click();
  expect((await retry).status()).toBe(200);
  const searches: Record<string, string> = { PROCESSING: '?status=PROCESSING', FAILED: '?status=FAILED', PENDING: '?status=PENDING', APPROVED: '?status=APPROVED', REJECTED: '?status=REJECTED', 'Spot-check': '?spotCheck=true', All: '' };
  for (const name of ['PROCESSING', 'FAILED', 'PENDING', 'APPROVED', 'REJECTED', 'Spot-check', 'All']) {
    // Match each response to its filter's request parameters, not just the path.
    const response = page.waitForResponse(res => res.request().method() === 'GET' && new URL(res.url()).pathname === '/api/admin/submissions' && new URL(res.url()).search === searches[name]);
    await page.getByRole('button', { name, exact: true }).click();
    expect((await response).status()).toBe(200);
  }
  await page.screenshot({ path: testInfo.outputPath('batch6-admin-mobile-filters.png'), fullPage: true });
});

test('legacy correction upload is owner-scoped and retains the original evidence', async ({ page }, testInfo) => {
  const owner = await createUser('USER', await hash(password, 10));
  const other = await createUser();
  const original = await db.submission.create({ data: { userId: owner.id, mode: 'LEGACY_UPLOAD', status: 'REJECTED', title: 'Legacy correction fixture', rejectionReason: 'Please upload the corrected first page.', pdfS3Key: 'retained/legacy.pdf' } });
  const foreign = await db.submission.create({ data: { userId: other.id, mode: 'LEGACY_UPLOAD', status: 'REJECTED' } });
  await login(page, owner.email);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Re-upload corrected images', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Re-upload corrected images', exact: true })).toBeVisible();
  await expect(page.getByText('Corrections for Legacy correction fixture', { exact: true })).toBeVisible();
  await expect(page.getByText('Please upload the corrected first page.', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('batch6-legacy-correction-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await db.submission.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  expect((await page.request.get(`/create/upload?replaces=${foreign.id}`)).status()).toBe(404);
  expect(await db.submission.count({ where: { userId: owner.id } })).toBe(1);
});

test('queue loading and unavailable states are accessible; retry reads real local health at desktop and mobile sizes', async ({ page }, testInfo) => {
  const admin = await createUser('ADMIN', await hash(password, 10));
  await login(page, admin.email);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let requests = 0;
  await page.route('**/api/admin/queue', async route => {
    requests++;
    await gate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/admin/queue');
  await expect(page.getByRole('status', { name: 'Loading queue status' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
  await page.getByRole('button', { name: 'Refreshing…' }).dispatchEvent('click');
  expect(requests).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('batch6-queue-loading.png'), fullPage: true });
  finish();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Queue status unavailable: Request failed (503)');
  await expect(page.getByRole('main').getByText('All queues healthy', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').getByText('No failed AI book jobs.', { exact: true })).toHaveCount(0);
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`batch6-queue-error-${width}.png`), fullPage: true });
  }
  await page.unroute('**/api/admin/queue');
  const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/admin/queue');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Render queue', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('batch6-queue-recovered-mobile.png'), fullPage: true });
});
