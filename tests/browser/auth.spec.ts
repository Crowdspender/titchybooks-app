import { expect, test, type Page } from '@playwright/test';
import { hash, compare } from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { db, createDraft, createUser, cleanupFixtures, trackFixtureRateLimit } from '../fixtures/database';

const password = 'Isolated-auth-regression-42!';
const registeredEmails: string[] = [];
async function signIn(page: Page, email: string, value = password) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.beforeEach(async ({ context }) => {
  const ip = '192.0.2.66';
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': ip });
  for (const prefix of ['register:ip', 'login-ip', 'forgot:ip', 'reset:ip']) trackFixtureRateLimit(`${prefix}:${ip}`);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await db.rateLimitBucket.deleteMany({ where: { bucketKey: { in: registeredEmails.flatMap(email => [`login:${email}`, `forgot:email:${email}`]) } } });
  await db.user.deleteMany({ where: { email: { in: registeredEmails } } });
  registeredEmails.length = 0;
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

test('real mobile registration, login, and logout preserve identity and first-user guidance', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const email = `sprint-register-${randomUUID()}@example.invalid`;
  registeredEmails.push(email);
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill('Émilie <reader>');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.screenshot({ path: testInfo.outputPath('batch6-registration-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?registered=true$/);
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  expect(user.role).toBe('USER');
  expect(user.name).toBe('Émilie <reader>');
  expect(await compare(password, user.passwordHash)).toBe(true);
  await signIn(page, email);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('No Titchybooks yet', { exact: true })).toBeVisible();
  await expect(page.getByText(/Start with a blank eight-page booklet/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('batch6-first-library-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Toggle menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('http://localhost:3100/');
  expect((await page.request.get('/api/submissions')).status()).toBe(401);
  expect(await (await page.request.get('/api/auth/session')).json()).toBeNull();
});

test('reset request does not claim delivery for an unknown address', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/forgot-password');
  const email = `unknown-${randomUUID()}@example.invalid`;
  trackFixtureRateLimit(`forgot:email:${email}`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Send reset link', exact: true }).click();
  await expect(page.getByText(/This response does not confirm delivery/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('batch6-reset-request-mobile.png'), fullPage: true });
});

test('reset form redeems a local token once and only the new password authenticates', async ({ page }, testInfo) => {
  const user = await createUser('USER', await hash(password, 10));
  const token = randomBytes(32).toString('hex');
  const newPassword = 'New-isolated-reset-password-42!';
  // Token delivery is a local fixture; no email-provider acceptance is claimed.
  await db.user.update({ where: { id: user.id }, data: { passwordResetToken: createHash('sha256').update(token).digest('hex'), passwordResetExpires: new Date(Date.now() + 600000) } });
  await page.goto(`/reset-password?token=${token}`);
  await page.getByLabel('New Password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm Password', { exact: true }).fill('Mismatch-password-42!');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByText('Passwords do not match', { exact: true })).toBeVisible();
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordResetToken).not.toBeNull();
  await page.getByLabel('Confirm Password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?reset=success$/);
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordResetToken).toBeNull();
  await page.goto(`/reset-password?token=${token}`);
  await page.getByLabel('New Password', { exact: true }).fill('Another-isolated-password-42!');
  await page.getByLabel('Confirm Password', { exact: true }).fill('Another-isolated-password-42!');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByText('Invalid or expired reset token', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('batch6-reset-reuse-denied.png'), fullPage: true });
  await page.goto('/login');
  await signIn(page, user.email);
  await expect(page.getByText('Invalid email or password', { exact: true })).toBeVisible();
  await signIn(page, user.email, newPassword);
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('a logged-in administrator loses privileged API and page authority immediately after role downgrade', async ({ page }) => {
  const admin = await createUser('ADMIN', await hash(password, 10));
  const draft = await createDraft(admin.id);
  await page.goto('/login');
  await signIn(page, admin.email);
  await expect(page).toHaveURL(/\/dashboard$/);
  expect((await page.request.get('/api/admin/submissions')).status()).toBe(200);
  await db.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
  const session = await (await page.request.get('/api/auth/session')).json();
  expect(session.user).toMatchObject({ id: admin.id, role: 'USER' });
  for (const path of ['/api/admin/submissions', '/api/admin/orders', '/api/admin/queue', '/api/admin/pricing-config', '/api/admin/payment-alerts']) expect((await page.request.get(path)).status(), path).toBe(403);
  expect((await page.request.patch(`/api/admin/submissions/${draft.id}`, { data: { action: 'APPROVE' } })).status()).toBe(403);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/dashboard$/);
  expect((await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
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
