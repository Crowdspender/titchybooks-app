import { expect, test, type Page } from '@playwright/test';
import { hash } from 'bcryptjs';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';

const password = 'Isolated-auth-regression-42!';
async function signIn(page: Page, email: string, value = password) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await cleanupFixtures();
});
test.afterAll(async () => { await db.$disconnect(); });

test('proxy guards bare and nested protected routes, including prefetch requests', async ({ request }) => {
  const paths = ['/dashboard', '/dashboard/orders', '/create', '/create/templates', '/admin', '/admin/orders', '/admin/templates'];
  for (const path of paths) {
    for (const prefetch of [false, true]) {
      const response = await request.get(path, {
        maxRedirects: 0,
        headers: prefetch ? { RSC: '1', 'Next-Router-Prefetch': '1' } : {},
      });
      expect(response.status(), `${path} (prefetch=${prefetch})`).toBe(307);
      const location = new URL(response.headers().location, 'http://localhost:3100');
      expect(location.origin).toBe('http://localhost:3100');
      expect(location.pathname).toBe('/login');
      expect(new URL(location.searchParams.get('callbackUrl')!).pathname).toBe(path);
    }
  }
});

test('public pages remain public while API authorization stays server-side', async ({ request }) => {
  for (const path of ['/', '/login', '/register', '/forgot-password']) {
    expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(200);
  }
  expect((await request.get('/api/submissions')).status()).toBe(401);
  expect((await request.get('/api/admin/submissions')).status()).toBe(403);
});

test('rejects invalid credentials, preserves user sessions, and denies admin access', async ({ page }) => {
  const user = await createUser('USER', await hash(password, 10));
  const draft = await createDraft(user.id);
  await page.goto('/login');
  await signIn(page, user.email, 'incorrect-password');
  await expect(page.getByText('Invalid email or password', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/submissions')).status()).toBe(401);

  await signIn(page, user.email);
  await expect(page).toHaveURL(/\/dashboard$/);
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session.user).toMatchObject({ id: user.id, role: 'USER' });
  await page.goto(`/create?submissionId=${draft.id}`);
  await expect(page.getByRole('textbox', { name: 'Book title' })).toBeVisible();
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/admin/orders');
  await expect(page).toHaveURL(/\/dashboard$/);
  expect((await page.request.get('/api/admin/submissions')).status()).toBe(403);
});

test('preserves admin sessions and access to protected administration pages', async ({ page }) => {
  const admin = await createUser('ADMIN', await hash(password, 10));
  await page.goto('/login');
  await signIn(page, admin.email);
  await expect(page).toHaveURL(/\/dashboard$/);
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session.user).toMatchObject({ id: admin.id, role: 'ADMIN' });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Submissions', exact: true })).toBeVisible();
  expect((await page.request.get('/api/admin/submissions')).status()).toBe(200);
  await page.goto('/admin/orders');
  await expect(page).toHaveURL(/\/admin\/orders$/);
  expect((await page.request.get('/api/admin/orders')).status()).toBe(200);
});
