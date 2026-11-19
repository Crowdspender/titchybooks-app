import { test, expect, type Page } from '@playwright/test';
import { hash } from 'bcryptjs';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';
import { DEFAULT_RESOLVED_CONFIG as cfg } from '@/lib/pricing/constants';
import { formatCharge } from '@/lib/pricing/currency';
import { syntheticQuoteInputs } from '../fixtures/pricing';

const password = 'Isolated-order-quote-test-42!';
const limiterKeys: string[] = [];
let original: Awaited<ReturnType<typeof db.pricingConfig.findUnique>>;
const pricingData = { version: 41, weightPerBookGrams: 6, handlingFixedHuf: 0, handlingPercent: 0,
  enabledZones: JSON.stringify(cfg.enabledZones), weightBands: JSON.stringify([50, 100, 250, 500, 1000, 2000]),
  shippingTable: JSON.stringify(cfg.shippingTable), priceTiers: JSON.stringify(cfg.priceTiers),
  currencyRates: JSON.stringify(cfg.currencyRates), vaultFeeHuf: 2000 };
test.beforeAll(async () => { original = await db.pricingConfig.findUnique({ where: { id: 'default' } }); });
test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await db.pricingConfig.upsert({ where: { id: 'default' }, create: { id: 'default', ...pricingData }, update: pricingData });
});
test.afterEach(async ({ page }) => {
  await page.close(); await cleanupFixtures();
  await db.rateLimitBucket.deleteMany({ where: { bucketKey: { in: limiterKeys.splice(0) } } });
});
test.afterAll(async () => {
  if (original) await db.pricingConfig.upsert({ where: { id: 'default' }, create: original, update: original });
  else await db.pricingConfig.deleteMany({ where: { id: 'default' } });
  await db.$disconnect();
});
async function fixture(page: Page) {
  const user = await createUser('USER', await hash(password, 10));
  limiterKeys.push(`quote:user:${user.id}`, `order:user:${user.id}`, `order-request:user:${user.id}`, `pay:user:${user.id}`);
  const draft = await createDraft(user.id);
  const submission = await db.submission.update({ where: { id: draft.id }, data: { status: 'APPROVED', title: 'Batch 4 synthetic approved book', pdfS3Key: `synthetic/${draft.id}/approved.pdf` } });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto(`/dashboard/orders/new?submissionId=${submission.id}`);
  return { user, submission };
}
async function fillAddress(page: Page) {
  const input = syntheticQuoteInputs();
  // Streamed navigation can briefly retain a hidden boundary. Require one
  // accessible field rather than matching hidden copies by their label alone.
  const recipient = page.getByRole('textbox', { name: 'Recipient name', exact: true });
  await expect(recipient).toHaveCount(1);
  await recipient.fill(input.shippingAddress.recipientName);
  await page.getByLabel('Address line 1', { exact: true }).fill(input.shippingAddress.line1);
  await page.getByLabel('City', { exact: true }).fill(input.shippingAddress.city);
  const quote = page.waitForResponse(r => r.url().endsWith('/api/orders/calculate') && r.request().method() === 'POST');
  await page.getByLabel('Postal code', { exact: true }).fill(input.shippingAddress.postalCode);
  const response = await quote; expect(response.status()).toBe(200);
  const body = await response.json();
  await expect(page.getByText('Exact charge:', { exact: false })).toBeVisible();
  return body;
}
async function accept(page: Page) {
  await page.getByRole('checkbox', { name: /I accept this exact charge/ }).check();
  await expect(page.getByRole('button', { name: 'Place order', exact: true })).toBeEnabled();
}
for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }]) {
  test(`real owner quote/acceptance persists exact frozen EUR charge and displays provenance at ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const { user, submission } = await fixture(page);
    await expect(page.getByRole('button', { name: 'Place order', exact: true })).toBeDisabled();
    await fillAddress(page);
    const recalculated = page.waitForResponse(r => r.url().endsWith('/api/orders/calculate') && r.request().method() === 'POST');
    await page.getByRole('checkbox', { name: /Add 2 copies/ }).check();
    const quote = await (await recalculated).json();
    const exact = formatCharge(quote.offer.charge.amountMinor, 'EUR');
    await expect(page.getByText(`Exact charge: ${exact}`, { exact: true })).toBeVisible();
    await accept(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await info.attach('Matching accepted quote', { body: await page.screenshot({ path: `test-results/batch4-quote-${viewport.width}.png`, fullPage: true }), contentType: 'image/png' });
    // A newer tariff/rate cannot rewrite the offer the customer accepted.
    await db.pricingConfig.update({ where: { id: 'default' }, data: { version: 99, currencyRates: JSON.stringify({ HUF: 1, EUR: 0.009, GBP: 0.008 }) } });
    const created = page.waitForResponse(r => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Place order', exact: true }).click();
    const response = await created; expect(response.status()).toBe(201);
    const body = await response.json();
    await expect(page).toHaveURL(new RegExp(`/dashboard/orders/${body.order.id}$`));
    await expect(page.getByText(exact, { exact: true })).toBeVisible();
    await expect(page.getByText('Original FX (per HUF)', { exact: true })).toBeVisible();
    await expect(page.getByText('0.0026', { exact: true })).toBeVisible();
    await expect(page.getByText('Vault storage (2 copies)', { exact: true })).toBeVisible();
    await page.getByText('Accepted terms (synthetic-test-v1)', { exact: true }).click();
    await expect(page.getByText(/Synthetic test terms only/)).toBeVisible();
    const stored = await db.order.findUniqueOrThrow({ where: { id: body.order.id } });
    expect(stored.expectedMinorAmount).toBe(quote.offer.charge.amountMinor); expect(stored.fxRate?.toString()).toBe('0.0026');
    expect(stored.pricingConfigVersion).toBe(41); expect(stored.weightGrams).toBe(260);
    expect(await db.order.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.vaultEntry.count({ where: { orderId: stored.id } })).toBe(0);
    expect((await db.submission.findUniqueOrThrow({ where: { id: submission.id } })).pdfS3Key).toBe(submission.pdfS3Key);
    await page.getByText('Order placed. Awaiting payment.', { exact: true }).waitFor({ state: 'hidden' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await info.attach('Frozen charge detail', { body: await page.screenshot({ path: `test-results/batch4-detail-${viewport.width}.png`, fullPage: true }), contentType: 'image/png' });
    await page.goto('/dashboard/orders');
    await expect(page.getByText(exact, { exact: true })).toBeVisible();
  });
}
test('input change disables acceptance immediately while a real server quote is delayed', async ({ page }) => {
  await fixture(page); await fillAddress(page); await accept(page);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/orders/calculate', async route => { await gate; await route.continue(); });
  await page.getByLabel('Phone (optional)').fill('changed');
  await expect(page.getByText('Exact charge:', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Place order|Calculating/ })).toBeDisabled();
  finish(); await expect(page.getByText('Exact charge:', { exact: false })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /I accept this exact charge/ })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Place order', exact: true })).toBeDisabled();
});
test('browser storage write failure sends zero creation requests', async ({ page }) => {
  const { user } = await fixture(page); await fillAddress(page); await accept(page);
  let posts = 0; page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/orders')) posts++; });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === window.sessionStorage && key.startsWith('titchybooks-pending-order:')) throw new Error('Injected local storage failure');
      return original.call(this, key, value);
    };
  });
  await page.getByRole('button', { name: 'Place order', exact: true }).click();
  await expect(page.getByText(/no request was sent/)).toBeVisible();
  expect(posts).toBe(0); expect(await db.order.count({ where: { userId: user.id } })).toBe(0);
});
test('lost response after real commit recovers the identical request after reload without a second order', async ({ page }, info) => {
  const { user } = await fixture(page); await fillAddress(page); await accept(page);
  const payloads: unknown[] = [];
  let creationStatus = 0;
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/orders')) payloads.push(r.postDataJSON()); });
  await page.route('**/api/orders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    creationStatus = response.status();
    // Always settle the interception: abort only a real 201 to simulate the
    // lost response; an unexpected status is fulfilled and asserted below.
    if (creationStatus === 201) await route.abort('connectionfailed');
    else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Place order', exact: true }).click();
  await expect.poll(() => creationStatus).toBe(201);
  await expect(page.getByRole('button', { name: 'Retry same order request' })).toBeEnabled();
  await expect(page.getByRole('spinbutton')).toBeDisabled();
  expect(await db.order.count({ where: { userId: user.id } })).toBe(1);
  await info.attach('Ambiguous response recovery', { body: await page.screenshot({ path: 'test-results/batch4-ambiguous-recovery.png', fullPage: true }), contentType: 'image/png' });
  await page.unroute('**/api/orders'); await page.reload();
  const replay = page.waitForResponse(r => r.url().endsWith('/api/orders') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Retry same order request' }).click();
  const response = await replay; expect(response.status()).toBe(200);
  const body = await response.json(); expect(body.replayed).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/dashboard/orders/${body.order.id}$`));
  expect(payloads).toHaveLength(2); expect(payloads[1]).toEqual(payloads[0]);
  expect(await db.order.count({ where: { userId: user.id } })).toBe(1);
});
test('excluded territory retains requested quantity and offers manual contact instead of checkout', async ({ page }, info) => {
  const { user } = await fixture(page); await fillAddress(page);
  await page.getByLabel('Country code (ISO)').fill('GB');
  await page.getByLabel('Postal code', { exact: true }).fill('BT1 1AA');
  await expect(page.getByRole('main').getByRole('alert')).toContainText('manual quote');
  await expect(page.getByRole('button', { name: 'Place order', exact: true })).toBeDisabled();
  await expect(page.getByRole('spinbutton')).toHaveValue('40');
  const contact = page.getByRole('link', { name: 'Ask for a manual quote', exact: true }).last();
  await expect(contact).toBeVisible();
  const href = new URL((await contact.getAttribute('href'))!, 'http://localhost:3100');
  expect(href.searchParams.has('zone')).toBe(false); expect(href.searchParams.has('weight')).toBe(false);
  expect(href.searchParams.get('quantity')).toBe('40');
  expect(await db.order.count({ where: { userId: user.id } })).toBe(0);
  await info.attach('Manual quote gate', { body: await page.screenshot({ path: 'test-results/batch4-manual-quote.png', fullPage: true }), contentType: 'image/png' });
});
