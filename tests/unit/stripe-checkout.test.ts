import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), account: vi.fn() }));
vi.mock('stripe', () => ({ default: class {
  checkout = { sessions: { create: sdk.create, retrieve: sdk.retrieve } };
  accounts = { retrieve: sdk.account };
} }));
beforeEach(() => {
  vi.resetModules(); vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_local_only');
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3100');
  sdk.create.mockResolvedValue({ id: 'cs_test_synthetic', url: 'https://checkout.stripe.com/synthetic' });
  sdk.account.mockResolvedValue({ id: 'acct_synthetic' });
  sdk.retrieve.mockResolvedValue({ id: 'cs_test_synthetic', mode: 'payment', livemode: false,
    client_reference_id: 'original-order', metadata: { orderId: 'original-order' }, currency: 'eur',
    amount_total: 2740, amount_subtotal: 2740, automatic_tax: { enabled: false },
    total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 }, status: 'expired', payment_status: 'unpaid' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each([{ currency: 'HUF' as const, amountMinor: 400000 }, { currency: 'EUR' as const, amountMinor: 2740 }, { currency: 'GBP' as const, amountMinor: 2325 }])('sends the frozen integer charge directly for $currency with deterministic provider idempotency', async input => {
  const { createCheckoutSession } = await import('@/lib/stripe');
  await createCheckoutSession({ ...input, orderId: 'original-order', submissionTitle: 'Synthetic Émilie', idempotencyKey: 'order:original-order:initial' });
  expect(sdk.create.mock.calls[0][0].line_items[0].price_data.unit_amount).toBe(input.amountMinor);
  expect(sdk.create.mock.calls[0][0].line_items[0].price_data.currency).toBe(input.currency.toLowerCase());
  expect(sdk.create.mock.calls[0][1]).toEqual({ idempotencyKey: 'order:original-order:initial' });
});
it('retrieves the own-account context using the installed SDK null-ID signature', async () => {
  const { retrieveStripeAccountContext } = await import('@/lib/stripe');
  expect(await retrieveStripeAccountContext()).toEqual({ accountId: 'acct_synthetic', livemode: false });
  expect(sdk.account).toHaveBeenCalledWith(null);
});
it('retains an issued session ID when the provider omits its URL', async () => {
  const { createCheckoutSession } = await import('@/lib/stripe');
  sdk.create.mockResolvedValue({ id: 'cs_test_no_url', url: null });
  await expect(createCheckoutSession({ orderId: 'original-order', submissionTitle: 'Synthetic', currency: 'EUR',
    amountMinor: 2740, idempotencyKey: 'synthetic-key' })).rejects.toMatchObject({ sessionId: 'cs_test_no_url' });
});
it('accepts a complete canonical proof without loading current rates', async () => {
  const { retrieveOrderCheckoutSession } = await import('@/lib/stripe');
  expect((await retrieveOrderCheckoutSession('cs_test_synthetic', 'original-order', 'EUR')).amount_total).toBe(2740);
  expect(sdk.retrieve).toHaveBeenCalledWith('cs_test_synthetic');
});
it.each([
  ['session identity', { id: 'unrelated-session' }], ['mode', { mode: 'subscription' }], ['account mode', { livemode: true }],
  ['order reference', { client_reference_id: 'unrelated-order' }], ['metadata', { metadata: { orderId: 'unrelated-order' } }],
  ['currency', { currency: 'gbp' }], ['null amount', { amount_total: null }], ['invalid amount', { amount_total: -1 }],
  ['fractional amount', { amount_total: 2740.5 }], ['below minimum', { amount_total: 49 }],
  ['automatic tax', { automatic_tax: { enabled: true } }],
  ['subtotal mismatch', { amount_subtotal: 2500 }], ['missing subtotal', { amount_subtotal: undefined }],
  ['missing adjustment proof', { total_details: null }],
  ['discount', { total_details: { amount_discount: 100, amount_tax: 0, amount_shipping: 0 } }],
  ['tax', { total_details: { amount_discount: 0, amount_tax: 100, amount_shipping: 0 } }],
  ['shipping adjustment', { total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 100 } }],
] as const)('rejects unprovable original amounts: %s', async (_label, patch) => {
  const canonical = await sdk.retrieve();
  sdk.retrieve.mockResolvedValue({ ...canonical, ...('amount_total' in patch ? { amount_subtotal: patch.amount_total } : {}), ...patch });
  const { retrieveOrderCheckoutSession } = await import('@/lib/stripe');
  await expect(retrieveOrderCheckoutSession('cs_test_synthetic', 'original-order', 'EUR')).rejects.toThrow();
});
it('requires HUF charge divisibility by 100 rather than reconstructing forint amounts', async () => {
  const canonical = await sdk.retrieve(); sdk.retrieve.mockResolvedValue({ ...canonical, currency: 'huf', amount_total: 400001, amount_subtotal: 400001 });
  const { retrieveOrderCheckoutSession } = await import('@/lib/stripe');
  await expect(retrieveOrderCheckoutSession('cs_test_synthetic', 'original-order', 'HUF')).rejects.toThrow();
});
it('does not call the provider for an invalid frozen charge and rejects an incomplete response', async () => {
  const { createCheckoutSession } = await import('@/lib/stripe');
  const input = { orderId: 'original-order', submissionTitle: 'Synthetic', currency: 'EUR' as const, idempotencyKey: 'deterministic-key' };
  await expect(createCheckoutSession({ ...input, amountMinor: 0 })).rejects.toThrow(); expect(sdk.create).not.toHaveBeenCalled();
  sdk.create.mockResolvedValue({ id: 'cs_test_synthetic', url: null });
  await expect(createCheckoutSession({ ...input, amountMinor: 2740 })).rejects.toThrow();
});
