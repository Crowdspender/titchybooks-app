import { expect, test } from '@playwright/test';
import { hash } from 'bcryptjs';
import { cleanupFixtures, createUser, db } from '../fixtures/database';

const password = 'Isolated-test-password-42!';
const CONCEPT = 'A bedtime story about a lighthouse that befriends the stars.';
let userId: string;

test.beforeEach(async ({ page, context }) => {
  const user = await createUser('USER', await hash(password, 10));
  userId = user.id;
  // No provider or storage requests may leave the isolated test server.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
test.afterEach(async ({ page }) => {
  await page.close();
  await cleanupFixtures();
});
test.afterAll(async () => { await db.$disconnect(); });

test('submits one prompt without a template and resumes tracking after a refresh', async ({ page }) => {
  await page.goto('/create/ai');
  await expect(page.getByRole('heading', { name: 'Create with AI' })).toBeVisible();

  // One prompt, no template choice, no images: the job id becomes the page state.
  await page.getByPlaceholder(/A gentle bedtime story/).fill(CONCEPT);
  await page.getByRole('button', { name: 'Create my book' }).click();
  await expect(page).toHaveURL(/\?job=/);
  const jobId = new URL(page.url()).searchParams.get('job');
  expect(jobId).toBeTruthy();
  await expect(page.getByText('Queued', { exact: true })).toBeVisible();

  // A refresh mid-job must resume the same job instead of starting another.
  await page.reload();
  await expect(page.getByText('Queued', { exact: true })).toBeVisible();
  expect(await db.aiBookJob.count({ where: { userId } })).toBe(1);

  // The job is listed on the dashboard before any draft exists.
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'AI books' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View progress' }).first()).toBeVisible();
  const jobs = await db.aiBookJob.findMany({ where: { userId } });
  expect(jobs).toHaveLength(1);
  expect(jobs[0].concept).toBe(CONCEPT);
});
