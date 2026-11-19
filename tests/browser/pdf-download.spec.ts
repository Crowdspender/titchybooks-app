import { expect, test } from '@playwright/test';
import { hash } from 'bcryptjs';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';

const password = 'Isolated-test-password-42!';
test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
});
test.afterEach(async ({ page }) => { await page.close(); await cleanupFixtures(); });
test.afterAll(async () => { await db.$disconnect(); });

test('real authenticated dashboard requests same-origin download and shows a sanitized storage failure', async ({ page }, info) => {
  const user = await createUser('USER', await hash(password, 10));
  const draft = await createDraft(user.id);
  const before = await db.submission.update({ where: { id: draft.id }, data: { title: 'Batch 2 approved historical book', status: 'APPROVED', pdfS3Key: `pdfs/${user.id}/${draft.id}/retained.pdf` } });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const link = page.getByRole('link', { name: 'Download print sheet', exact: true });
  await expect(link).toHaveAttribute('href', `/api/submissions/${draft.id}/downloads?kind=print`);
  await expect(page.getByText('Reading PDF unavailable for this book.', { exact: true })).toBeVisible();
  const response = page.waitForResponse(response => response.url().includes(`/api/submissions/${draft.id}/downloads`));
  await link.click();
  expect((await response).status()).toBe(503); // Node egress fence rejects real S3; this is not real-provider acceptance.
  await expect(page.getByRole('alert')).toContainText('could not be started');
  await expect(page.getByRole('link', { name: 'Retry PDF request' })).toBeVisible();
  // The sanitized error page must never expose the retained storage key.
  expect(await page.content()).not.toContain(`pdfs/${user.id}/${draft.id}/retained.pdf`);
  await page.screenshot({ path: info.outputPath('authenticated-download-error.png'), fullPage: true });
  expect(await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).toEqual(before);
});

test('real endpoint displays expired authorization as a sign-in error, not a downloaded file', async ({ page }, info) => {
  let downloads = 0;
  page.on('download', () => downloads++);
  const response = await page.goto('/api/submissions/expired-fixture/downloads?kind=print');
  expect(response?.status()).toBe(401);
  expect(response?.headers()['cache-control']).toBe('private, no-store');
  await expect(page.getByRole('alert')).toHaveText('Sign in to request this PDF.');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  expect(downloads).toBe(0);
  await page.screenshot({ path: info.outputPath('expired-download-auth.png'), fullPage: true });
});
