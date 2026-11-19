import { expect, test, type Page } from '@playwright/test';
import { hash } from 'bcryptjs';
import { db, createUser, cleanupFixtures } from '../fixtures/database';
import { createOrderForUser } from '../fixtures/orders';
import { projectPayment, type CanonicalPaymentProof } from '@/lib/orders/payment-state';
import { applyOrderLifecycle } from '@/lib/orders/lifecycle';

const password = 'Isolated-settlement-test-42!';
async function fixture(page: Page) {
  const admin = await createUser('ADMIN', await hash(password, 10));
  const customer = await createUser();
  const { order } = await createOrderForUser(customer.id, { vaultAddOn: true, title: 'Batch 3 isolated settlement' });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(admin.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/admin/orders');
  const row = page.getByRole('row').filter({ hasText: 'Batch 3 isolated settlement' });
  await row.getByRole('button', { name: 'Update', exact: true }).click();
  await row.getByRole('combobox', { name: 'Order status' }).selectOption('PAID');
  return { admin, order, row };
}
test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
});
test.afterEach(async ({ page }) => { await page.close(); await cleanupFixtures(); });
test.afterAll(async () => { await db.$disconnect(); });

test('manual settlement needs evidence and confirmation; cancel sends zero requests; real API commits one private Vault entry', async ({ page }, testInfo) => {
  const { admin, order, row } = await fixture(page);
  let patches = 0;
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(`/api/admin/orders/${order.id}`)) patches++; });
  await expect(row.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await row.getByLabel('Payment evidence / reference').fill('Controlled receipt 42');
  await expect(row.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(patches).toBe(0);
  await row.getByRole('button', { name: 'Update', exact: true }).click();
  await row.getByRole('combobox', { name: 'Order status' }).selectOption('PAID');
  await row.getByLabel('Payment evidence / reference').fill('Controlled receipt 42');
  await row.getByRole('checkbox').check();
  await page.getByRole('region', { name: 'Orders', exact: true }).evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await testInfo.attach('Manual settlement confirmation', { body: await page.screenshot({ path: 'test-results/batch3-manual-confirmation.png', fullPage: true }), contentType: 'image/png' });
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith(`/api/admin/orders/${order.id}`));
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(row.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
  await row.getByText('Manual settlement evidence', { exact: true }).click();
  await expect(row.getByText('Operator-verified; not Stripe confirmation.', { exact: true })).toBeVisible();
  const stored = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { vaultEntries: true } });
  expect(stored).toMatchObject({ status: 'PAID', manualSettlement: { source: 'manual', operatorId: admin.id, method: 'BANK_TRANSFER', reference: 'Controlled receipt 42', confirmed: true } });
  expect(stored.paidAt).not.toBeNull();
  expect(stored.vaultEntries).toHaveLength(1);
  expect(stored.vaultEntries[0].publicConsent).toBe(false);
  expect(patches).toBe(1);
  await testInfo.attach('Manual settlement recorded', { body: await page.screenshot({ path: 'test-results/batch3-manual-recorded.png', fullPage: true }), contentType: 'image/png' });
});

test('stale settlement shows a real HTTP conflict, preserves evidence, and reloads without settlement', async ({ page }, testInfo) => {
  const { order, row } = await fixture(page);
  await row.getByLabel('Payment evidence / reference').fill('Controlled stale receipt');
  await row.getByRole('checkbox').check();
  await db.order.update({ where: { id: order.id }, data: { notes: 'Concurrent operator note' } });
  const response = page.waitForResponse(res => res.request().method() === 'PATCH' && res.url().endsWith(`/api/admin/orders/${order.id}`));
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Order changed');
  await expect(row.getByLabel('Payment evidence / reference')).toHaveValue('Controlled stale receipt');
  await page.getByRole('region', { name: 'Orders', exact: true }).evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await testInfo.attach('Manual settlement conflict', { body: await page.screenshot({ path: 'test-results/batch3-manual-conflict.png', fullPage: true }), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Reload orders', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
  const stored = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { vaultEntries: true } });
  expect(stored).toMatchObject({ status: 'PENDING_PAYMENT', notes: 'Concurrent operator note', manualSettlement: null, vaultEntries: [] });
});

test('slow settlement disables duplicate actions; injected HTTP failure retains the form', async ({ page }) => {
  const { order, row } = await fixture(page);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let patches = 0;
  await page.route(`**/api/admin/orders/${order.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patches++;
    await gate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected local HTTP failure; reload before retrying.' }) });
  });
  await row.getByLabel('Payment evidence / reference').fill('Controlled receipt');
  await row.getByRole('checkbox').check();
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await expect(row.getByRole('combobox', { name: 'Order status' })).toBeDisabled();
  await expect.poll(() => patches).toBe(1);
  finish();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Injected local HTTP failure');
  await expect(row.getByLabel('Payment evidence / reference')).toHaveValue('Controlled receipt');
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING_PAYMENT');
});

test('settlement controls retain usable widths and stay reachable in the desktop and mobile scroll region', async ({ page }, testInfo) => {
  const { order, row } = await fixture(page);
  const region = page.getByRole('region', { name: 'Orders', exact: true });
  await expect(region).toHaveAttribute('tabindex', '0');
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const status = await row.getByRole('combobox', { name: 'Order status' }).boundingBox();
    expect(status?.width).toBeGreaterThanOrEqual(144);
    await region.focus();
    await expect(region).toBeFocused();
    await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    const bounds = await region.boundingBox();
    expect(bounds).not.toBeNull();
    for (const control of [row.getByLabel('Payment evidence / reference'), row.getByRole('checkbox'), row.getByRole('button', { name: 'Save', exact: true }), row.getByRole('button', { name: 'Cancel', exact: true })]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
    expect((await row.getByLabel('Payment evidence / reference').boundingBox())!.width).toBeGreaterThanOrEqual(250);
    await testInfo.attach(`Manual settlement ${width}px`, { body: await page.screenshot({ path: `test-results/batch3-manual-${width}.png`, fullPage: true }), contentType: 'image/png' });
  }
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING_PAYMENT');
});

async function paymentFixture(page: Page) {
  const { order, row } = await fixture(page);
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await db.order.update({ where: { id: order.id }, data: { currency: 'EUR', expectedMinorAmount: 2740 } });
  const attempt = await db.paymentAttempt.create({ data: { orderId: order.id, sequence: 1,
    idempotencyKey: `synthetic-browser:${order.id}`, expectedMinorAmount: 2740, currency: 'EUR', livemode: false,
    providerAccountId: 'acct_synthetic_browser', sessionId: `cs_browser_${order.id}`, paymentIntentId: `pi_browser_${order.id}`,
    status: 'SUCCEEDED', providerRequest: { origin: 'SYNTHETIC_BROWSER_EVIDENCE', request: null } } });
  const proof: CanonicalPaymentProof = { attemptId: attempt.id, sessionId: attempt.sessionId, paymentIntentId: attempt.paymentIntentId,
    expectedAccountId: attempt.providerAccountId, accountId: attempt.providerAccountId!, expectedLivemode: false, livemode: false,
    expectedMinorAmount: 2740, amountMinor: 2740, currency: 'EUR', status: 'SUCCEEDED', receivedMinor: 2740,
    refunds: [{ id: 're_synthetic_browser', chargeId: 'ch_synthetic_browser', amountMinor: 1000, currency: 'EUR', status: 'succeeded' }],
    disputes: [], reviewReasons: [] };
  const projection = projectPayment({ expectedMinorAmount: 2740, currency: 'EUR', fulfillment: 'PAID', hasManualSettlement: false }, [proof]);
  await db.paymentAttempt.update({ where: { id: attempt.id }, data: { providerSnapshot: JSON.parse(JSON.stringify(proof)) } });
  await db.order.update({ where: { id: order.id }, data: { status: 'PAID', stripeSessionId: attempt.sessionId,
    paymentState: projection.state, paymentHold: projection.hold, paymentSummary: JSON.parse(JSON.stringify(projection.summary)) } });
  await db.paymentEvent.create({ data: { providerEventId: `evt_browser_${order.id}`, source: 'SIGNED_WEBHOOK',
    type: 'refund.updated', orderId: order.id, attemptId: attempt.id, status: 'REVIEW', dataDigest: 'b'.repeat(64),
    data: { objectId: 're_synthetic_browser', amountMinor: 1000, currency: 'eur' }, outcome: 'Synthetic persisted refund review' } });
  await page.reload();
  return { order, projection, row };
}
test('payment history reads real minimized records, shows holds and surfaces unavailable reconciliation without provider calls', async ({ page }, testInfo) => {
  const { order, row } = await paymentFixture(page);
  await expect(page.getByRole('region', { name: 'Unresolved payment events' })).toContainText('refund.updated');
  const response = page.waitForResponse(res => res.url().endsWith(`/api/admin/orders/${order.id}/payment`) && res.request().method() === 'GET');
  await row.getByRole('button', { name: 'Payment history', exact: true }).click();
  expect((await response).headers()['cache-control']).toBe('private, no-store');
  const panel = page.getByRole('region', { name: 'Payment history', exact: true });
  await expect(panel.getByText('Partially refunded', { exact: true })).toBeVisible();
  await expect(panel.getByText(/Attempt 1/)).toContainText('27.40');
  await expect(panel.getByRole('button', { name: 'Release reviewed hold' })).toBeDisabled();
  await panel.getByText('Canonical refund, dispute, and reference details').click();
  await expect(panel.getByText(/re_synthetic_browser/).first()).toBeVisible();
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const queue = page.getByRole('region', { name: 'Unresolved payment events' });
    const queueBounds = (await queue.boundingBox())!;
    const reviewBounds = (await queue.getByRole('button', { name: `Review payment for order ${order.id}`, exact: true }).boundingBox())!;
    expect(reviewBounds.x).toBeGreaterThanOrEqual(queueBounds.x);
    expect(reviewBounds.x + reviewBounds.width).toBeLessThanOrEqual(queueBounds.x + queueBounds.width);
    await page.evaluate(() => window.scrollTo(0, 0));
    await testInfo.attach(`Payment history ${width}px`, { body: await page.screenshot({ path: `test-results/batch5-history-${width}.png`, fullPage: true }), contentType: 'image/png' });
    const bounds = await panel.boundingBox();
    for (const control of [panel.getByLabel('Review explanation'), panel.getByRole('checkbox'), panel.getByRole('button', { name: 'Release reviewed hold' })]) {
      const box = await control.boundingBox(); expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x); expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
  }
  const failure = page.waitForResponse(res => res.url().endsWith(`/api/admin/orders/${order.id}/payment`) && res.request().method() === 'POST');
  await panel.getByRole('button', { name: 'Reconcile with Stripe' }).click();
  expect((await failure).status()).toBe(503);
  await expect(panel.getByRole('alert')).toContainText('not configured');
  await expect(panel.getByRole('button', { name: 'Release reviewed hold' })).toBeDisabled();
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentHold).toBe(true);
});
test('explicit review is fingerprint-bound, cancels without requests and fails closed on stale mocked responses', async ({ page }) => {
  const { order, projection, row } = await paymentFixture(page);
  let requests = 0;
  await page.route(`**/api/admin/orders/${order.id}/payment`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests++; expect(route.request().postDataJSON()).toEqual({ action: 'RELEASE_HOLD', fingerprint: projection.summary.fingerprint,
      explanation: 'Synthetic finance reviewed current refund.', confirmed: true });
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Current facts changed. Reload history.' }) });
  });
  await row.getByRole('button', { name: 'Payment history', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Payment history', exact: true });
  await panel.getByLabel('Review explanation').fill('Synthetic finance reviewed current refund.');
  await expect(panel.getByRole('button', { name: 'Release reviewed hold' })).toBeDisabled();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Close history' }).click(); expect(requests).toBe(0);
  await row.getByRole('button', { name: 'Payment history', exact: true }).click();
  await panel.getByLabel('Review explanation').fill('Synthetic finance reviewed current refund.'); await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Release reviewed hold' }).click();
  await expect(panel.getByRole('alert')).toContainText('facts changed');
  await expect(panel.getByRole('button', { name: 'Release reviewed hold' })).toBeDisabled(); expect(requests).toBe(1);
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentHold).toBe(true);
});
test('checkout query strings never fabricate confirmation; persisted refund/dispute state preserves shipped fulfillment', async ({ page }, testInfo) => {
  const customer = await createUser('USER', await hash(password, 10));
  const { order } = await createOrderForUser(customer.id, { status: 'SHIPPED', currency: 'EUR', title: 'Batch 5 customer payment evidence' });
  await db.order.update({ where: { id: order.id }, data: { expectedMinorAmount: 2740 } });
  await page.goto('/login'); await page.getByLabel('Email', { exact: true }).fill(customer.email);
  await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  for (const [state, label] of [[null, 'Historical payment state unknown'], ['UNPAID', 'Awaiting payment'], ['PROCESSING', 'Payment processing'],
    ['PAID', 'Payment confirmed'], ['MANUAL_PAID', 'Manual payment recorded'], ['PARTIALLY_REFUNDED', 'Partially refunded'],
    ['REFUNDED', 'Fully refunded'], ['DISPUTED', 'Payment disputed'], ['DISPUTE_LOST', 'Dispute lost']] as const) {
    await db.order.update({ where: { id: order.id }, data: { paymentState: state, paymentHold: ['REFUNDED', 'DISPUTED', 'DISPUTE_LOST'].includes(state ?? '') } });
    await page.goto(`/dashboard/orders/${order.id}?checkout=success`);
    await expect(page.getByRole('main').getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('SHIPPED', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText(/Payment completed/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pay now' })).toHaveCount(0);
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  await testInfo.attach('Persisted customer payment', { body: await page.screenshot({ path: 'test-results/batch5-customer-payment.png', fullPage: true }), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Refresh payment status' }).click();
  await expect(page.getByRole('main').getByText('Dispute lost', { exact: true })).toBeVisible();
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SHIPPED');
});

test('paid Vault records remain private until separate consent; errors, opt-in and removal preserve archive history', async ({ page }, testInfo) => {
  const customer = await createUser('USER', await hash(password, 10));
  const other = await createUser();
  const { order } = await createOrderForUser(customer.id, { vaultAddOn: true, title: 'Batch 6 private archive record' });
  // Local lifecycle fixture, not provider payment or physical receipt evidence.
  await db.$transaction(tx => applyOrderLifecycle(tx, order.id, { source: 'stripe' }));
  const original = await db.vaultEntry.findUniqueOrThrow({ where: { orderId: order.id } });
  expect(original.publicConsent).toBe(false);
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: original.title, exact: true })).toHaveCount(0);
  await page.goto('/login'); await page.getByLabel('Email', { exact: true }).fill(customer.email);
  await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/dashboard/vault');
  await expect(page.getByRole('main').getByText(/Payment and the recorded status do not confirm physical receipt/)).toBeVisible();
  const entry = page.getByRole('listitem').filter({ hasText: original.title });
  await expect(entry.getByText(/Record status: STORED/)).toBeVisible();
  const { order: foreignOrder } = await createOrderForUser(other.id, { vaultAddOn: true });
  await db.$transaction(tx => applyOrderLifecycle(tx, foreignOrder.id, { source: 'stripe' }));
  const foreign = await db.vaultEntry.findUniqueOrThrow({ where: { orderId: foreignOrder.id } });
  expect((await page.request.patch(`/api/vault/${foreign.id}/consent`, { data: { consent: true } })).status()).toBe(403);
  await page.route(`**/api/vault/${original.id}/consent`, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Injected visibility unavailable"}' }));
  await entry.getByRole('button', { name: 'Make public', exact: true }).click();
  await expect(entry.getByRole('alert')).toContainText('Injected visibility unavailable');
  expect(await db.vaultEntry.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  await page.unroute(`**/api/vault/${original.id}/consent`);
  await entry.getByRole('button', { name: 'Make public', exact: true }).click();
  await expect(entry.getByRole('button', { name: 'Consent granted ✓', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`batch6-vault-consent-${width}.png`), fullPage: true });
  }
  await page.goto('/vault');
  await expect(page.getByRole('heading', { name: original.title, exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByText(/Buying the Vault add-on does not make a book public/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('batch6-public-vault-mobile.png'), fullPage: true });
  await db.vaultEntry.update({ where: { id: original.id }, data: { status: 'WITHDRAWN' } });
  await page.reload();
  await expect(page.getByRole('heading', { name: original.title, exact: true })).toHaveCount(0);
  await page.goto('/dashboard/vault');
  await entry.getByRole('button', { name: 'Consent granted ✓', exact: true }).click();
  await expect(entry.getByRole('button', { name: 'Make public', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const retained = await db.vaultEntry.findUniqueOrThrow({ where: { id: original.id } });
  expect(retained).toEqual({ ...original, status: 'WITHDRAWN', updatedAt: retained.updatedAt });
  expect(retained.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
  expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(1);
});
