import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { db, createDraft, createUser, cleanupFixtures } from "../fixtures/database";
import { createOrderForUser } from "../fixtures/orders";
import { SYNTHETIC_SHIPPING_POLICY as policy, syntheticQuoteInputs } from "../fixtures/pricing";
import { DEFAULT_RESOLVED_CONFIG } from "@/lib/pricing/constants";
import { buildOffer, OFFER_TTL_MS, signOffer } from "@/lib/pricing/offer";
import { loadCheckoutPricingConfig, invalidatePricingConfigCache } from "@/lib/pricing/config";
import { POST as calculate } from "@/app/api/orders/calculate/route";
import { POST as create } from "@/app/api/orders/route";
import { POST as pay } from "@/app/api/orders/[id]/pay/route";
import { createCheckoutSession, retrieveOrderCheckoutSession } from "@/lib/stripe";
import { syntheticCanonicalProof } from "../fixtures/stripe-events";

const session = vi.hoisted(() => ({ user: null as { id: string; role: string; email: string } | null }));
vi.mock("@/auth", () => ({ auth: async () => session.user ? { user: session.user } : null }));
const stripe = vi.hoisted(() => ({ fail: false, configured: true, sequence: 0 }));
vi.mock("@/lib/stripe", async original => ({
  ...await original<typeof import('@/lib/stripe')>(),
  stripeLivemode: () => false,
  retrieveStripeAccountContext: vi.fn(async () => ({ accountId: 'acct_fixture', livemode: false })),
  isStripeConfigured: () => stripe.configured,
  createCheckoutSession: vi.fn(async () => {
    if (stripe.fail) throw new Error("SENSITIVE provider details");
    const sessionId = `cs_test_quote_${++stripe.sequence}`;
    return { sessionId, url: `https://checkout.stripe.com/c/${sessionId}` };
  }),
  retrieveOrderCheckoutSession: vi.fn(async (id: string, orderId: string, currency: string) => ({
    id, mode: "payment", client_reference_id: orderId, metadata: { orderId }, livemode: false,
    status: "expired", payment_status: "unpaid", currency: currency.toLowerCase(), amount_total: 400000, url: null,
  })),
}));
vi.mock('@/lib/orders/payment-provider', async original => ({ ...await original<typeof import('@/lib/orders/payment-provider')>(),
  readCanonicalAttempt: async (attempt: import('@prisma/client').PaymentAttempt) => syntheticCanonicalProof(attempt,
    await retrieveOrderCheckoutSession(attempt.sessionId!, attempt.orderId, attempt.currency as 'HUF' | 'EUR' | 'GBP')),
}));
const request = (body: unknown) => new Request("http://localhost/api/orders", { method: "POST",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const retry = (id: string) => pay(new NextRequest(`http://localhost/api/orders/${id}/pay`, { method: "POST" }), { params: Promise.resolve({ id }) });
const limiterKeys: string[] = [];
let original: Awaited<ReturnType<typeof db.pricingConfig.findUnique>>;
const pricingData = {
  version: 41, weightPerBookGrams: 6, handlingFixedHuf: 0, handlingPercent: 0,
  enabledZones: JSON.stringify(DEFAULT_RESOLVED_CONFIG.enabledZones),
  weightBands: JSON.stringify([50, 100, 250, 500, 1000, 2000]),
  shippingTable: JSON.stringify(DEFAULT_RESOLVED_CONFIG.shippingTable), priceTiers: JSON.stringify(DEFAULT_RESOLVED_CONFIG.priceTiers),
  currencyRates: JSON.stringify(DEFAULT_RESOLVED_CONFIG.currencyRates), vaultFeeHuf: 2000,
};
beforeAll(async () => { original = await db.pricingConfig.findUnique({ where: { id: "default" } }); });
beforeEach(async () => {
  vi.stubEnv("ORDER_SHIPPING_POLICY_JSON", JSON.stringify(policy));
  stripe.fail = false; stripe.configured = true; stripe.sequence = 0;
  vi.mocked(createCheckoutSession).mockReset().mockImplementation(async () => {
    if (stripe.fail) throw new Error("SENSITIVE provider details");
    const sessionId = `cs_test_quote_${++stripe.sequence}`;
    return { sessionId, url: `https://checkout.stripe.com/c/${sessionId}` };
  });
  vi.mocked(retrieveOrderCheckoutSession).mockReset().mockImplementation(async (id, orderId, currency) => ({
    id, mode: "payment", client_reference_id: orderId, metadata: { orderId }, livemode: false,
    status: "expired", payment_status: "unpaid", currency: currency.toLowerCase(), amount_total: 400000, url: null,
  }) as unknown as Awaited<ReturnType<typeof retrieveOrderCheckoutSession>>);
  await db.pricingConfig.upsert({ where: { id: "default" }, create: { id: "default", ...pricingData }, update: pricingData });
  invalidatePricingConfigCache();
});
afterEach(async () => {
  await cleanupFixtures();
  await db.rateLimitBucket.deleteMany({ where: { bucketKey: { in: limiterKeys.splice(0) } } });
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (original) await db.pricingConfig.upsert({ where: { id: "default" }, create: original, update: original });
  else await db.pricingConfig.deleteMany({ where: { id: "default" } });
  invalidatePricingConfigCache();
});
async function approvedBook() {
  const user = await createUser();
  session.user = { id: user.id, role: "USER", email: user.email };
  limiterKeys.push(`quote:user:${user.id}`, `order:user:${user.id}`, `pay:user:${user.id}`);
  const draft = await createDraft(user.id);
  const submission = await db.submission.update({ where: { id: draft.id }, data: { status: "APPROVED", title: "Synthetic quoted book", pdfS3Key: `synthetic/${draft.id}/approved.pdf` } });
  return { user, submission, inputs: syntheticQuoteInputs(submission.id) };
}
async function quotedRequest(inputs: ReturnType<typeof syntheticQuoteInputs>) {
  const response = await calculate(request(inputs));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const body = await response.json();
  return { ...inputs, offerToken: body.offer.token, requestKey: randomUUID(), acceptTerms: true as const };
}

describe("signed matching preview and immutable accepted Order", () => {
  it("requires authentication, owner approval, and an existing print PDF", async () => {
    const { inputs, submission } = await approvedBook();
    session.user = null;
    expect((await calculate(request(inputs))).status).toBe(401);
    const stranger = await createUser("ADMIN");
    limiterKeys.push(`quote:user:${stranger.id}`);
    session.user = { id: stranger.id, role: "ADMIN", email: stranger.email };
    expect((await calculate(request(inputs))).status).toBe(403);
    session.user = { id: submission.userId, role: "USER", email: "synthetic@example.invalid" };
    await db.submission.update({ where: { id: submission.id }, data: { status: "DRAFT" } });
    expect((await calculate(request(inputs))).status).toBe(400);
    await db.submission.update({ where: { id: submission.id }, data: { status: "APPROVED", pdfS3Key: null } });
    expect((await calculate(request(inputs))).status).toBe(400);
  });
  it("disables shipping without approved policy and refuses mismatched zones/excluded postcodes", async () => {
    const { inputs } = await approvedBook();
    vi.stubEnv("ORDER_SHIPPING_POLICY_JSON", "");
    expect((await calculate(request(inputs))).status).toBe(422);
    vi.stubEnv("ORDER_SHIPPING_POLICY_JSON", JSON.stringify(policy));
    expect((await calculate(request({ ...inputs, zone: "eu" }))).status).toBe(422);
    expect((await calculate(request({ ...inputs, shippingAddress: { ...inputs.shippingAddress, postalCode: "9999" } }))).status).toBe(422);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
  it("returns explicit manual contact for all synthetic service exclusions, unknown coverage, and overweight runs", async () => {
    const { inputs } = await approvedBook();
    const cases = policy.services.flatMap(service => service.excludedPostcodePrefixes.map(prefix => ({ countryCode: service.countryCode, postalCode: `${prefix}100` })));
    cases.push({ countryCode: "CA", postalCode: "A1A1A1" });
    for (const address of cases) {
      const response = await calculate(request({ ...inputs, shippingAddress: { ...inputs.shippingAddress, ...address } }));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "MANUAL_QUOTE_REQUIRED", contactUrl: expect.stringContaining("/contact?") });
    }
    const heavy = await calculate(request({ ...inputs, quantity: 1664, shippingAddress: { ...inputs.shippingAddress, countryCode: "US" } }));
    expect(heavy.status).toBe(422);
    expect(await heavy.json()).toMatchObject({ code: "MANUAL_QUOTE_REQUIRED", contactUrl: expect.stringContaining("/contact?") });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
  it("never makes missing/corrupt pricing defaults checkout ready", async () => {
    const { inputs } = await approvedBook();
    await db.pricingConfig.deleteMany({ where: { id: "default" } });
    expect((await calculate(request(inputs))).status).toBe(400);
    await db.pricingConfig.create({ data: { id: "default", ...pricingData, currencyRates: "corrupt" } });
    expect((await calculate(request(inputs))).status).toBe(400);
  });
  it("requires signed complete matching inputs, consent and unexpired preview", async () => {
    const { user, inputs } = await approvedBook();
    const payload = await quotedRequest(inputs);
    expect((await create(request({ ...payload, acceptTerms: false }))).status).toBe(400);
    expect((await create(request({ ...payload, quantity: 41 }))).status).toBe(409);
    expect((await create(request({ ...payload, shippingAddress: { ...inputs.shippingAddress, phone: "changed" } }))).status).toBe(409);
    const cfg = await loadCheckoutPricingConfig();
    const expired = signOffer(buildOffer(user.id, inputs, cfg, policy, Date.now() - OFFER_TTL_MS - 1000));
    expect((await create(request({ ...payload, offerToken: expired }))).status).toBe(409);
    expect(await db.order.count({ where: { userId: user.id } })).toBe(0);
  });
  it("serializes duplicate creation and charges once; different payload under the same key conflicts", async () => {
    const { user, inputs } = await approvedBook();
    const payload = await quotedRequest(inputs);
    const responses = await Promise.all([create(request(payload)), create(request(payload)), create(request(payload))]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 200, 201]);
    const bodies = await Promise.all(responses.map(r => r.json()));
    expect(new Set(bodies.map(b => b.order.id)).size).toBe(1);
    expect(await db.order.count({ where: { userId: user.id } })).toBe(1);
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
    expect((await create(request({ ...payload, quantity: 41 }))).status).toBe(409);
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });
  it("replays accepted requests after preview expiry/policy disable/rate cap without another payment call", async () => {
    const { user, inputs } = await approvedBook();
    const cfg = await loadCheckoutPricingConfig();
    const offer = buildOffer(user.id, inputs, cfg, policy, Date.now() - OFFER_TTL_MS + 50000);
    const payload = { ...inputs, requestKey: randomUUID(), acceptTerms: true, offerToken: signOffer(offer) };
    const first = await create(request(payload)); expect(first.status).toBe(201);
    const firstBody = await first.json();
    vi.stubEnv("ORDER_SHIPPING_POLICY_JSON", "");
    await db.rateLimitBucket.updateMany({ where: { bucketKey: `order:user:${user.id}` }, data: { count: 100 } });
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(offer.expiresAt + 1000);
    try {
      const replay = await create(request(payload)); expect(replay.status).toBe(200);
      expect((await replay.json()).order.id).toBe(firstBody.order.id);
    } finally { dateSpy.mockRestore(); }
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });
  it("freezes full HUF/config/address/terms/FX and retries the original minor charge despite current config changes", async () => {
    const { inputs, submission } = await approvedBook();
    const payload = await quotedRequest(inputs);
    stripe.configured = false;
    const response = await create(request(payload)); expect(response.status).toBe(201);
    const { order } = await response.json();
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    // 40 × 250 HUF + 540 HUF postage (260g including packaging), at 0.0026 EUR/HUF.
    expect(stored.paymentState).toBe('UNPAID');
    expect(stored.expectedMinorAmount).toBe(2740);
    expect(stored.weightGrams).toBe(260);
    expect(stored.fxRate?.toString()).toBe("0.0026");
    expect(stored.quoteSnapshot).toMatchObject({ inputs, terms: policy.terms, pricingConfig: { version: 41 } });
    expect(stored.quoteAcceptedAt).not.toBeNull();
    await db.pricingConfig.update({ where: { id: "default" }, data: { version: 99, currencyRates: "corrupt", shippingTable: "corrupt" } });
    stripe.configured = true;
    const retryResponse = await retry(order.id); expect(retryResponse.status).toBe(200);
    expect(vi.mocked(createCheckoutSession).mock.calls.at(-1)?.[0]).toMatchObject({ amountMinor: 2740, currency: "EUR", idempotencyKey: `order:${order.id}:initial` });
    expect((await db.submission.findUniqueOrThrow({ where: { id: submission.id } })).pdfS3Key).toBe(submission.pdfS3Key);
    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(0);
    await expect(db.order.update({ where: { id: order.id }, data: { totalHuf: stored.totalHuf + 1 } })).rejects.toThrow(/immutable/i);
    await expect(db.order.update({ where: { id: order.id }, data: { postalCode: "2000" } })).rejects.toThrow(/immutable/i);
    await expect(db.order.update({ where: { id: order.id }, data: { expectedMinorAmount: 9999 } })).rejects.toThrow();
    await expect(db.order.update({ where: { id: order.id }, data: { notes: "Permitted operator note" } })).resolves.toBeDefined();
  });
  it("retains accepted order and sanitizes a provider failure", async () => {
    const { user, inputs } = await approvedBook();
    const payload = await quotedRequest(inputs); stripe.fail = true;
    const response = await create(request(payload)); expect(response.status).toBe(201);
    const body = await response.json(); expect(body.paymentError).not.toContain("SENSITIVE");
    expect((await db.order.findMany({ where: { userId: user.id } }))).toHaveLength(1);
    expect((await create(request(payload))).status).toBe(200);
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });
  it("preserves legacy null provenance and blocks unprovable retry rather than inventing FX", async () => {
    const { user } = await approvedBook();
    const { order } = await createOrderForUser(user.id, { currency: "EUR" });
    const response = await retry(order.id); expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PAYMENT_REVIEW_REQUIRED");
    const preserved = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(preserved.expectedMinorAmount).toBeNull(); expect(preserved.fxRate).toBeNull();
    expect(preserved.quoteAcceptedAt).toBeNull(); expect(preserved.totalHuf).toBe(order.totalHuf);
    expect(createCheckoutSession).not.toHaveBeenCalled(); expect(retrieveOrderCheckoutSession).not.toHaveBeenCalled();
  });
  it("sanitizes transient legacy provider lookup failures without publishing or freezing invented provenance", async () => {
    const { user } = await approvedBook();
    const { order } = await createOrderForUser(user.id, { stripeSessionId: "cs_test_transient_failure", currency: "EUR" });
    vi.mocked(retrieveOrderCheckoutSession).mockRejectedValueOnce(new Error("SENSITIVE provider token and customer detail"));
    const response = await retry(order.id);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("SENSITIVE");
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(order);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
  it("proves a legacy provider amount once without fabricating FX or acceptance", async () => {
    const { user } = await approvedBook();
    const { order } = await createOrderForUser(user.id, { stripeSessionId: `cs_test_legacy_${randomUUID()}` });
    expect((await retry(order.id)).status).toBe(200);
    const frozen = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(frozen.expectedMinorAmount).toBe(400000); expect(frozen.fxRate).toBeNull(); expect(frozen.quoteAcceptedAt).toBeNull();
    expect(frozen.quoteSnapshot).toMatchObject({ origin: "LEGACY_STRIPE_SESSION", amountMinor: 400000, fxRate: null });
    expect(vi.mocked(createCheckoutSession).mock.calls.at(-1)?.[0]).toMatchObject({ amountMinor: 400000, currency: "HUF" });
  });
  it("reuses a proven open session without issuing another charge", async () => {
    const { inputs } = await approvedBook();
    const { order } = await (await create(request(await quotedRequest(inputs)))).json();
    vi.mocked(retrieveOrderCheckoutSession).mockResolvedValue(providerSession(await db.order.findUniqueOrThrow({ where: { id: order.id } }), { status: "open", url: "https://checkout.stripe.com/synthetic-existing" }));
    const response = await retry(order.id); expect(response.status).toBe(200);
    expect((await response.json()).checkoutUrl).toContain("synthetic-existing");
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });
  it.each([{ amount_total: 9999 }, { status: "open", url: null }])("blocks mismatched or unavailable sessions: %j", async patch => {
    const { inputs } = await approvedBook();
    const { order } = await (await create(request(await quotedRequest(inputs)))).json();
    vi.mocked(retrieveOrderCheckoutSession).mockResolvedValueOnce(providerSession(await db.order.findUniqueOrThrow({ where: { id: order.id } }), patch));
    const response = await retry(order.id); expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("PAYMENT_REVIEW_REQUIRED");
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });
  it.each([{ payment_status: 'paid', status: 'complete', expected: 'PAID' }, { status: 'complete', expected: 'PROCESSING' }])('reconciles paid/processing sessions instead of issuing another charge: %j', async patch => {
    const { inputs } = await approvedBook();
    const { order } = await (await create(request(await quotedRequest(inputs)))).json();
    vi.mocked(retrieveOrderCheckoutSession).mockResolvedValue(providerSession(await db.order.findUniqueOrThrow({ where: { id: order.id } }), patch));
    const response = await retry(order.id); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checkoutUrl: null, paymentState: patch.expected });
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });
  it("requires reviewed replacement terms for invalid canonical legacy proof and preserves all unknown facts", async () => {
    const { user } = await approvedBook();
    const { order } = await createOrderForUser(user.id, { stripeSessionId: "cs_test_unproved" });
    vi.mocked(retrieveOrderCheckoutSession).mockRejectedValueOnce(new Error("Provider session needs review"));
    const response = await retry(order.id); expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("replacement terms");
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(order);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
  it("rechecks pending state when an open-session provider read races settlement", async () => {
    const { inputs } = await approvedBook();
    const { order } = await (await create(request(await quotedRequest(inputs)))).json();
    vi.mocked(retrieveOrderCheckoutSession).mockImplementationOnce(async () => {
      await db.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });
      return providerSession(await db.order.findUniqueOrThrow({ where: { id: order.id } }), { status: "open", url: "https://checkout.stripe.com/synthetic-existing" });
    });
    expect((await retry(order.id)).status).toBe(409); expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });
  it("blocks retries after increased packaging or Vault parcel-copy assumptions without repricing", async () => {
    const { inputs } = await approvedBook();
    const { order } = await (await create(request(await quotedRequest({ ...inputs, vaultAddOn: true })))).json();
    vi.stubEnv("ORDER_SHIPPING_POLICY_JSON", JSON.stringify({ ...policy, weightRule: { packagingGrams: 21, vaultCopiesInCustomerParcel: 2 } }));
    expect((await retry(order.id)).status).toBe(422);
    const retained = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(retained.expectedMinorAmount).toBe(order.expectedMinorAmount); expect(retained.totalHuf).toBe(order.totalHuf);
    expect(createCheckoutSession).toHaveBeenCalledTimes(1); expect(retrieveOrderCheckoutSession).not.toHaveBeenCalled();
  });
  it("concurrent retries use the identical provider idempotency key and conditional publication", async () => {
    const { inputs } = await approvedBook(); stripe.configured = false;
    const { order } = await (await create(request(await quotedRequest(inputs)))).json(); stripe.configured = true;
    let arrivals = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(createCheckoutSession).mockImplementation(async () => {
      if (++arrivals === 2) release(); await gate;
      return { sessionId: "cs_test_same_idempotent", url: "https://checkout.stripe.com/synthetic-idempotent" };
    });
    const responses = await Promise.all([retry(order.id), retry(order.id)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 200]);
    expect(new Set(vi.mocked(createCheckoutSession).mock.calls.map(call => call[0].idempotencyKey))).toEqual(new Set([`order:${order.id}:initial`]));
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).stripeSessionId).toBe("cs_test_same_idempotent");
    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(0);
  });
  it("does not publish a new retry when provider latency races manual settlement", async () => {
    const { inputs } = await approvedBook(); stripe.configured = false;
    const { order } = await (await create(request(await quotedRequest(inputs)))).json(); stripe.configured = true;
    vi.mocked(createCheckoutSession).mockImplementationOnce(async () => {
      // This succeeds while the provider call is in flight: no open DB transaction spans it.
      await db.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: new Date() } });
      return { sessionId: "cs_test_not_published", url: "https://checkout.stripe.com/synthetic-late" };
    });
    expect((await retry(order.id)).status).toBe(409);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).stripeSessionId).toBeNull();
  });
});
function providerSession(order: { id: string; stripeSessionId: string | null; currency: string; expectedMinorAmount: number | null }, patch: Record<string, unknown> = {}) {
  return { id: order.stripeSessionId, mode: "payment", client_reference_id: order.id, metadata: { orderId: order.id },
    livemode: false, status: "expired", payment_status: "unpaid", currency: order.currency.toLowerCase(),
    amount_total: order.expectedMinorAmount, url: null, ...patch } as unknown as Awaited<ReturnType<typeof retrieveOrderCheckoutSession>>;
}
