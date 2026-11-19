import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import Stripe from 'stripe';
import sharp from 'sharp';
import { compare } from 'bcryptjs';
import { chromium } from '@playwright/test';
import { NextRequest } from 'next/server';
import { db, cleanupFixtures, createUser, trackFixtureUser } from '../fixtures/database';
import { SYNTHETIC_SHIPPING_POLICY, syntheticQuoteInputs } from '../fixtures/pricing';
import { textElement, imageElement } from '../fixtures/scenes';
import { DEFAULT_RESOLVED_CONFIG } from '@/lib/pricing/constants';
import { PAGE_LABELS } from '@/lib/constants';
import { createEmptyEditorScene } from '@/lib/editor/schema';
import { parseArtifactManifest, sha256, verifyArtifact, type ArtifactManifest } from '@/lib/pdf/artifacts';
import { invalidatePricingConfigCache } from '@/lib/pricing/config';
import { claimRenderJob, processRenderJob } from '@/lib/pdf/render-job';
import { POST as register } from '@/app/api/register/route';
import { POST as createBook } from '@/app/api/submissions/route';
import { GET as loadBook } from '@/app/api/submissions/[id]/route';
import { PUT as savePage } from '@/app/api/submissions/[id]/pages/[pageLabel]/route';
import { POST as registerAsset } from '@/app/api/assets/route';
import { DELETE as removeAsset } from '@/app/api/assets/[assetId]/route';
import { POST as submit } from '@/app/api/submissions/[id]/submit/route';
import { PATCH as moderate } from '@/app/api/admin/submissions/[id]/route';
import { POST as duplicate } from '@/app/api/submissions/[id]/duplicate/route';
import { GET as download } from '@/app/api/submissions/[id]/downloads/route';
import { POST as quote } from '@/app/api/orders/calculate/route';
import { POST as createOrder, GET as listOrders } from '@/app/api/orders/route';
import { POST as retryPayment } from '@/app/api/orders/[id]/pay/route';
import { POST as webhook } from '@/app/api/stripe/webhook/route';
import { GET as history, POST as paymentAction } from '@/app/api/admin/orders/[id]/payment/route';
import { PATCH as fulfill } from '@/app/api/admin/orders/[id]/route';
import { PATCH as consent } from '@/app/api/vault/[id]/consent/route';

// Actual application routes/services, PostgreSQL locks/triggers, sharp/PDF
// rendering, canonical provider traversal and signed webhook verification.
// ONLY auth sessions, email delivery and provider/storage transport are mocked.
// This is not NextAuth browser login, real S3/Stripe/AI or physical pilot proof.
const state = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; email: string }, objects: new Map<string, Buffer>(),
  sessions: new Map<string, Stripe.Checkout.Session>(), keys: new Map<string, string>(),
  paid: false, ambiguousOnce: true, providerCalls: [] as string[],
  refunds: [] as Array<{ id: string; amount: number; status: string }>, dispute: null as null | string,
  reconciliationErrors: [] as string[],
}));
vi.mock('@/lib/prisma', async () => ({ prisma: (await import('../fixtures/database')).db }));
vi.mock('@/auth', () => ({ auth: async () => state.user ? { user: state.user } : null }));
vi.mock('@/lib/email', () => ({ sendWelcomeEmail: vi.fn(async () => true) }));
vi.mock('@/lib/orders/payment-events', async original => {
  const actual = await original<typeof import('@/lib/orders/payment-events')>();
  return { ...actual, processSignedPaymentEvent: async (event: Stripe.Event) => {
    try { return await actual.processSignedPaymentEvent(event); }
    catch (error) {
      state.reconciliationErrors.push(error instanceof Error ? error.message : 'Unknown reconciliation failure');
      throw error;
    }
  } };
});
vi.mock('@/lib/s3', async original => ({
  ...await original<typeof import('@/lib/s3')>(),
  headS3Object: async (key: string) => state.objects.has(key) ? { size: state.objects.get(key)!.length, contentType: 'image/png' } : null,
  downloadFromS3: async (key: string) => {
    const bytes = state.objects.get(key); if (!bytes) throw new Error('Missing local retained source'); return Buffer.from(bytes);
  },
  uploadToS3: async (key: string, bytes: Buffer) => { state.objects.set(key, Buffer.from(bytes)); },
  openS3Object: async (key: string) => {
    const bytes = state.objects.get(key); if (!bytes) throw { name: 'NoSuchKey' };
    return { body: Readable.from([bytes.subarray(0, 128), bytes.subarray(128)]), size: bytes.length, contentType: 'application/pdf' };
  },
  deleteS3Object: async () => { throw new Error('Retained source deletion is forbidden'); },
}));
vi.mock('@/lib/stripe', async original => {
  const actual = await original<typeof import('@/lib/stripe')>();
  const { default: Stripe } = await import('stripe');
  const signer = new Stripe('sk_test_local_signing_only');
  const session = (id: string) => {
    const value = state.sessions.get(id); if (!value) throw new Error('Unknown synthetic provider session');
    return { ...value, status: state.paid ? 'complete' : 'open', payment_status: state.paid ? 'paid' : 'unpaid',
      payment_intent: state.paid ? `pi_${id}` : null } as Stripe.Checkout.Session;
  };
  const forIntent = (id: string) => session(id.replace(/^pi_/, ''));
  const charge = (id: string) => {
    const s = session(id.replace(/^ch_/, ''));
    return { id, object: 'charge', payment_intent: `pi_${s.id}`, currency: s.currency, livemode: false,
      amount_captured: s.amount_total, amount_refunded: state.refunds.filter(r => r.status === 'succeeded').reduce((n, r) => n + r.amount, 0),
      paid: state.paid, captured: state.paid, status: 'succeeded', disputed: state.dispute !== null };
  };
  return { ...actual,
    retrieveStripeAccountContext: async () => ({ accountId: 'acct_journey_fixture', livemode: false }),
    retrieveOrderCheckoutSession: async (id: string) => session(id),
    createCheckoutSession: async (input: Parameters<typeof actual.createCheckoutSession>[0]) => {
      const { db } = await import('../fixtures/database');
      const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { id: input.attemptId! } });
      expect(attempt).toMatchObject({ idempotencyKey: input.idempotencyKey, expectedMinorAmount: input.amountMinor, status: 'AMBIGUOUS' });
      expect(attempt.providerRequest).toEqual(input.providerRequest);
      // A different connection can lock the order during provider I/O.
      await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${input.orderId} FOR UPDATE NOWAIT`; });
      state.providerCalls.push(input.idempotencyKey!);
      let id = state.keys.get(input.idempotencyKey!);
      if (!id) {
        id = `cs_journey_${randomUUID()}`; state.keys.set(input.idempotencyKey!, id);
        state.sessions.set(id, { id, object: 'checkout.session', mode: 'payment', livemode: false,
          client_reference_id: input.orderId, metadata: { orderId: input.orderId, attemptId: input.attemptId! },
          amount_total: input.amountMinor, amount_subtotal: input.amountMinor, currency: input.currency.toLowerCase(),
          status: 'open', payment_status: 'unpaid', payment_intent: null,
          total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 }, automatic_tax: { enabled: false },
          url: `http://localhost/synthetic-checkout/${id}` } as unknown as Stripe.Checkout.Session);
      }
      if (state.ambiguousOnce) { state.ambiguousOnce = false; throw new Error('Synthetic issued response lost'); }
      return { sessionId: id, url: session(id).url! };
    },
    getStripeClient: () => ({ webhooks: signer.webhooks,
      checkout: { sessions: { retrieve: async (id: string) => session(id) } },
      paymentIntents: { retrieve: async (id: string) => { const s = forIntent(id); return {
        id, object: 'payment_intent', livemode: false, metadata: s.metadata, amount: s.amount_total,
        amount_received: state.paid ? s.amount_total : 0, currency: s.currency,
        status: state.paid ? 'succeeded' : 'requires_payment_method', latest_charge: state.paid ? `ch_${s.id}` : null,
      }; } },
      charges: { list: async ({ payment_intent }: { payment_intent: string }) => ({ data: [charge(payment_intent.replace(/^pi_/, 'ch_'))], has_more: false }),
        retrieve: async (id: string) => charge(id) },
      refunds: { list: async ({ charge: id }: { charge: string }) => ({ data: state.refunds.map(r => ({ ...r,
        object: 'refund', charge: id, payment_intent: id.replace(/^ch_/, 'pi_'), currency: charge(id).currency })), has_more: false }) },
      disputes: { list: async ({ charge: id }: { charge: string }) => ({ data: state.dispute ? [{ id: 'dp_journey', object: 'dispute',
        charge: id, payment_intent: id.replace(/^ch_/, 'pi_'), currency: charge(id).currency,
        amount: charge(id).amount_captured, livemode: false, status: state.dispute }] : [], has_more: false }) },
    }),
  };
});
const req = (body: unknown = {}) => new Request('http://localhost/journey', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '192.0.2.77' }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const originalPricing = { current: null as Awaited<ReturnType<typeof db.pricingConfig.findUnique>> };
const keys: string[] = ['register:ip:192.0.2.77'];
let registeredEmail = '';
const fixtureUserIds: string[] = [];
let journeyTarget: { major: number; output: string };
let journeyReport: { output: string; data: Record<string, unknown> } | undefined;
const pricingData = { version: 77, weightPerBookGrams: 6, handlingFixedHuf: 0, handlingPercent: 0,
  enabledZones: JSON.stringify(DEFAULT_RESOLVED_CONFIG.enabledZones), weightBands: JSON.stringify([50, 100, 250, 500, 1000, 2000]),
  shippingTable: JSON.stringify(DEFAULT_RESOLVED_CONFIG.shippingTable), priceTiers: JSON.stringify(DEFAULT_RESOLVED_CONFIG.priceTiers),
  currencyRates: JSON.stringify(DEFAULT_RESOLVED_CONFIG.currencyRates), vaultFeeHuf: 2000 };
beforeAll(async () => {
  const [{ major }] = await db.$queryRaw<Array<{ major: number }>>`SELECT current_setting('server_version_num')::int / 10000 AS major`;
  const output = resolve('test-results', `batch7-journey-pg${major}`);
  journeyTarget = { major, output }; mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'evidence.json'), JSON.stringify({ status: 'INCOMPLETE', startedAt: new Date().toISOString(),
    postgresMajor: major, scope: 'Local service journey; no passing claim until all assertions and cleanup' }, null, 2) + '\n');
  originalPricing.current = await db.pricingConfig.findUnique({ where: { id: 'default' } });
});
afterEach(async () => {
  if (registeredEmail) {
    const owner = await db.user.findUnique({ where: { email: registeredEmail } }); if (owner) trackFixtureUser(owner);
  }
  await cleanupFixtures();
  await db.rateLimitBucket.deleteMany({ where: { bucketKey: { in: keys } } });
  if (originalPricing.current) await db.pricingConfig.upsert({ where: { id: 'default' }, create: originalPricing.current, update: originalPricing.current });
  else await db.pricingConfig.deleteMany({ where: { id: 'default' } });
  invalidatePricingConfigCache(); vi.unstubAllEnvs(); state.objects.clear();
  expect(await db.user.count({ where: { id: { in: fixtureUserIds } } })).toBe(0);
  expect(await db.rateLimitBucket.count({ where: { bucketKey: { in: keys } } })).toBe(0);
  expect(await db.pricingConfig.findUnique({ where: { id: 'default' } })).toEqual(originalPricing.current);
  if (journeyReport) writeFileSync(resolve(journeyReport.output, 'evidence.json'), JSON.stringify({
    ...journeyReport.data, status: 'PASSED', finishedAt: new Date().toISOString(),
    fixtureUsersRemoved: true, fixtureRateLimitsRemoved: true, pricingConfigRestored: true,
  }, null, 2) + '\n');
});
afterAll(async () => { await db.$disconnect(); });
async function book(id: string) {
  const result = await loadBook(req(), params(id)); expect(result.status).toBe(200); return (await result.json()).submission;
}
async function render(id: string) {
  const queued = await submit(req({ force: true }), params(id)); expect(queued.status).toBe(202);
  const job = await claimRenderJob(); expect(job?.submissionId).toBe(id);
  await processRenderJob(job!);
  const rendered = await db.submission.findUniqueOrThrow({ where: { id }, include: { pages: { orderBy: { order: 'asc' } }, renderJobs: { orderBy: { id: 'asc' } } } });
  expect(rendered.status).toBe('PENDING'); expect(rendered.renderJobs.at(-1)?.status).toBe('COMPLETED');
  const manifest = parseArtifactManifest(rendered.artifactManifest)!; expect(manifest).not.toBeNull();
  for (const kind of ['print', 'reading'] as const) expect(await verifyArtifact(kind, manifest[kind], state.objects.get(manifest[kind].s3Key)!)).toEqual([]);
  return rendered;
}
async function signed(type: string, object: unknown, id = `evt_${randomUUID()}`) {
  const body = JSON.stringify({ id, object: 'event', type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  return webhook(new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST',
    headers: { 'stripe-signature': signature }, body }));
}
async function saveBrowserDownloads(id: string, manifest: ArtifactManifest, output: string) {
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController(); outgoing.on('close', () => { if (!outgoing.writableFinished) controller.abort(); });
    try {
      const response = await download(new Request(`http://localhost${incoming.url}`, {
        signal: controller.signal, headers: { accept: 'text/html' } }), params(id));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), outgoing);
      else outgoing.end();
    } catch { outgoing.destroy(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    for (const kind of ['print', 'reading'] as const) {
      const pending = page.waitForEvent('download');
      await page.goto(`${origin}/api/submissions/${id}/downloads?kind=${kind}`).catch(error => {
        if (!/Download is starting|ERR_ABORTED/.test(String(error))) throw error;
      });
      const saved = await pending; expect(await saved.failure()).toBeNull();
      await saved.saveAs(resolve(output, `${kind}.pdf`));
      const bytes = await readFile(resolve(output, `${kind}.pdf`));
      expect(bytes.length).toBe(manifest[kind].bytes); expect(sha256(bytes)).toBe(manifest[kind].sha256);
      expect(await verifyArtifact(kind, manifest[kind], bytes)).toEqual([]);
      expect(saved.suggestedFilename()).toContain(kind === 'print' ? 'print-sheet-a4-fold.pdf' : 'reading-74x105mm.pdf');
    }
  } finally {
    await browser.close(); server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
}

it('executes one registered-owner book from validated upload through correction, saved PDFs, frozen payment recovery, fulfillment and refund/dispute/Vault history', async () => {
  vi.stubEnv('ORDER_SHIPPING_POLICY_JSON', JSON.stringify(SYNTHETIC_SHIPPING_POLICY));
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_journey'); vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_synthetic_journey');
  await db.pricingConfig.upsert({ where: { id: 'default' }, create: { id: 'default', ...pricingData }, update: pricingData });
  invalidatePricingConfigCache(); expect(await db.renderJob.count({ where: { status: { in: ['QUEUED', 'PROCESSING'] } } })).toBe(0);
  registeredEmail = `sprint-${randomUUID()}@example.invalid`;
  expect((await register(req({ name: 'Émilie — Journey', email: registeredEmail, password: 'synthetic-local-password' }))).status).toBe(201);
  const owner = trackFixtureUser(await db.user.findUniqueOrThrow({ where: { email: registeredEmail } }));
  expect(owner.role).toBe('USER'); expect(await compare('synthetic-local-password', owner.passwordHash)).toBe(true);
  const admin = await createUser('ADMIN'); const stranger = await createUser(); expect(owner.id).not.toBe(admin.id);
  fixtureUserIds.push(owner.id, admin.id, stranger.id);
  for (const user of [owner, admin, stranger]) for (const prefix of ['submission:user', 'quote:user', 'order:user', 'order-request:user', 'pay:user', 'payment-review:admin']) keys.push(`${prefix}:${user.id}`);
  state.user = owner;
  const created = await createBook(req({ mode: 'EDITOR', title: 'Émilie café — original' })); expect(created.status).toBe(201);
  const originalId: string = (await created.json()).submission.id;
  const assetId = randomUUID(); const stagingKey = `assets/${owner.id}/${assetId}.png`;
  const image = await sharp({ create: { width: 720, height: 1080, channels: 3, background: '#c59442' } }).png().toBuffer();
  state.objects.set(stagingKey, image);
  const uploaded = await registerAsset(req({ s3Key: stagingKey, originalFilename: 'café.png', mimeType: 'image/jpeg', width: 1, height: 1, fileSize: 1 }));
  expect(uploaded.status).toBe(201); const asset = (await uploaded.json()).asset;
  expect(asset).toMatchObject({ id: assetId, mimeType: 'image/png', width: 720, height: 1080, fileSize: image.length });
  expect(asset.s3Key).toContain('/canonical/'); state.objects.set(stagingKey, Buffer.from('overwritten upload URL source'));
  const scenes = PAGE_LABELS.map(label => ({ ...createEmptyEditorScene(), elements: [
    { ...textElement(`text-${label}`, `Émilie café — ${label}`), width: 550, height: 120 },
    { ...imageElement(asset.id), x: 200, y: 250, width: 300, height: 450 },
  ] }));
  for (const [index, label] of PAGE_LABELS.entries()) expect((await savePage(req({ scene: scenes[index], revision: 0 }),
    { params: Promise.resolve({ id: originalId, pageLabel: label }) })).status).toBe(200);
  const resumed = await book(originalId); expect(resumed.pages.map((p: { scene: unknown }) => p.scene)).toEqual(scenes);
  expect(resumed.pages.map((p: { pageLabel: string }) => p.pageLabel)).toEqual([...PAGE_LABELS]);
  expect((await removeAsset(req(), { params: Promise.resolve({ assetId }) })).status).toBe(409);
  const original = await render(originalId); const originalManifest = parseArtifactManifest(original.artifactManifest)!;
  const retained = new Map([...state.objects].map(([key, bytes]) => [key, Buffer.from(bytes)]));
  state.user = admin;
  expect((await moderate(req({ action: 'REJECT', rejectionReason: 'Please correct the cover to say revised café.' }), params(originalId))).status).toBe(200);
  const rejected = await db.submission.findUniqueOrThrow({ where: { id: originalId }, include: { pages: { orderBy: { order: 'asc' } }, renderJobs: { orderBy: { id: 'asc' } } } });
  state.user = owner; const correction = await duplicate(req(), params(originalId)); expect(correction.status).toBe(201);
  const correctedId: string = (await correction.json()).submission.id; expect(correctedId).not.toBe(originalId);
  const copy = await book(correctedId); expect(copy.pages.map((p: { scene: unknown }) => p.scene)).toEqual(scenes);
  const revised = { ...scenes[0], elements: [{ ...textElement('text-FRONT_COVER', 'Émilie revised café'), width: 550, height: 120 }, scenes[0].elements[1]] };
  expect((await savePage(req({ scene: revised, revision: 0 }), { params: Promise.resolve({ id: correctedId, pageLabel: 'FRONT_COVER' }) })).status).toBe(200);
  // Model loss and exact recovery of independently retained bytes, then regenerate
  // only the new correction. The original reviewed masters must stay untouched.
  state.objects.clear(); state.user = admin;
  expect((await download(new Request('http://localhost/downloads?kind=print'), params(originalId))).status).toBe(404);
  for (const [key, bytes] of retained) state.objects.set(key, Buffer.from(bytes));
  expect(sha256(state.objects.get(asset.s3Key)!)).toBe(sha256(image));
  state.user = owner; const corrected = await render(correctedId);
  state.user = admin; expect((await moderate(req({ action: 'APPROVE' }), params(correctedId))).status).toBe(200);
  expect(await db.submission.findUniqueOrThrow({ where: { id: originalId }, include: { pages: { orderBy: { order: 'asc' } }, renderJobs: { orderBy: { id: 'asc' } } } })).toEqual(rejected);
  for (const kind of ['print', 'reading'] as const) expect(state.objects.get(originalManifest[kind].s3Key)).toEqual(retained.get(originalManifest[kind].s3Key));
  const manifest = parseArtifactManifest(corrected.artifactManifest)!;
  state.user = owner;
  const { major, output } = journeyTarget;
  await saveBrowserDownloads(correctedId, manifest, output);
  state.user = stranger; expect((await download(new Request('http://localhost/downloads?kind=print'), params(correctedId))).status).toBe(403);
  const inputs = { ...syntheticQuoteInputs(correctedId), vaultAddOn: true };
  state.user = admin; expect((await quote(req(inputs))).status).toBe(403);
  state.user = owner; const quoted = await quote(req(inputs)); expect(quoted.status).toBe(200); const offer = (await quoted.json()).offer;
  const acceptedBody = { ...inputs, offerToken: offer.token, requestKey: randomUUID(), acceptTerms: true };
  const accepted = await createOrder(req(acceptedBody)); expect(accepted.status).toBe(201); const acceptedResult = await accepted.json();
  expect(acceptedResult.checkoutUrl).toBeNull(); expect(acceptedResult.paymentError).toContain('retained');
  const orderId: string = acceptedResult.order.id; const frozen = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(frozen.expectedMinorAmount).toBe(offer.charge.amountMinor); expect(frozen.currency).toBe('EUR');
  const attemptBefore = await db.paymentAttempt.findFirstOrThrow({ where: { orderId } }); expect(attemptBefore.status).toBe('AMBIGUOUS');
  expect((await createOrder(req(acceptedBody))).status).toBe(200); expect(state.providerCalls).toHaveLength(1);
  await db.pricingConfig.update({ where: { id: 'default' }, data: { version: 78, currencyRates: '{"HUF":1,"EUR":0.5,"GBP":0.4}' } }); invalidatePricingConfigCache();
  const retry = await retryPayment(new NextRequest(`http://localhost/api/orders/${orderId}/pay`, { method: 'POST' }), params(orderId));
  expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ amountMinor: frozen.expectedMinorAmount, currency: 'EUR', attemptId: attemptBefore.id });
  expect(state.providerCalls).toEqual([attemptBefore.idempotencyKey, attemptBefore.idempotencyKey]); expect(state.sessions.size).toBe(1);
  expect(await db.order.count({ where: { userId: owner.id } })).toBe(1); expect(await db.paymentAttempt.count({ where: { orderId } })).toBe(1);
  const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { id: attemptBefore.id } });
  expect(attempt.providerRequest).toEqual(attemptBefore.providerRequest);
  const openRetry = await retryPayment(new NextRequest('http://localhost/retry', { method: 'POST' }), params(orderId)); expect(openRetry.status).toBe(200);
  expect(state.providerCalls).toHaveLength(2); state.paid = true;
  const issued = state.sessions.get(attempt.sessionId!)!;
  const paidObject = { ...issued, payment_status: 'paid', status: 'complete', payment_intent: `pi_${issued.id}`, customer_email: 'private@example.invalid' };
  const eventId = `evt_${randomUUID()}`;
  const deliveries = await Promise.allSettled(Array.from({ length: 3 }, () => signed('checkout.session.completed', paidObject, eventId)));
  expect(state.reconciliationErrors).toEqual([]);
  expect(deliveries.map(delivery => delivery.status === 'fulfilled' ? delivery.value.status : 'rejected')).toEqual([200, 200, 200]);
  const paid = await db.order.findUniqueOrThrow({ where: { id: orderId } }); expect(paid).toMatchObject({ status: 'PAID', paymentState: 'PAID', paymentHold: false, expectedMinorAmount: frozen.expectedMinorAmount, paidAt: expect.any(Date) });
  expect(await db.paymentEvent.count({ where: { providerEventId: eventId } })).toBe(1);
  const event = await db.paymentEvent.findUniqueOrThrow({ where: { providerEventId: eventId } }); expect(JSON.stringify(event.data)).not.toContain('private@example.invalid');
  const vault = await db.vaultEntry.findUniqueOrThrow({ where: { orderId } }); expect(vault.publicConsent).toBe(false);
  state.user = admin;
  state.dispute = 'needs_response'; const disputed = { object: 'dispute', id: 'dp_journey', charge: `ch_${issued.id}`, payment_intent: `pi_${issued.id}`, currency: 'eur', amount: paid.expectedMinorAmount };
  expect((await signed('charge.dispute.created', disputed)).status).toBe(200);
  expect((await fulfill(req({ status: 'IN_PRODUCTION' }), params(orderId))).status).toBe(409);
  state.dispute = 'won'; expect((await paymentAction(req({ action: 'RECONCILE' }), params(orderId))).status).toBe(200);
  expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentHold).toBe(false);
  expect((await fulfill(req({ status: 'IN_PRODUCTION' }), params(orderId))).status).toBe(200);
  expect((await fulfill(req({ status: 'SHIPPED' }), params(orderId))).status).toBe(200);
  const partial = Math.floor(paid.expectedMinorAmount! / 2); state.refunds.push({ id: 're_partial', amount: partial, status: 'succeeded' });
  expect((await signed('charge.refunded', { object: 'charge', id: `ch_${issued.id}`, payment_intent: `pi_${issued.id}`, currency: 'eur', amount: paid.expectedMinorAmount })).status).toBe(200);
  expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).paymentState).toBe('PARTIALLY_REFUNDED');
  state.refunds.push({ id: 're_balance', amount: paid.expectedMinorAmount! - partial, status: 'succeeded' });
  expect((await signed('refund.updated', { object: 'refund', ...state.refunds[1], charge: `ch_${issued.id}`, payment_intent: `pi_${issued.id}`, currency: 'eur' })).status).toBe(200);
  const refunded = await db.order.findUniqueOrThrow({ where: { id: orderId } }); expect(refunded).toMatchObject({ status: 'SHIPPED', paymentState: 'REFUNDED', paidAt: paid.paidAt, paymentHold: true, expectedMinorAmount: frozen.expectedMinorAmount, quoteSnapshot: frozen.quoteSnapshot });
  const before = await history(req(), params(orderId)); expect(before.status).toBe(200); expect((await before.json()).order.paymentAttempts).toHaveLength(1);
  state.user = stranger; expect((await consent(new NextRequest('http://localhost/consent', { method: 'PATCH', body: '{"consent":true}' }), params(vault.id))).status).toBe(403);
  state.user = owner; expect((await consent(new NextRequest('http://localhost/consent', { method: 'PATCH', body: '{"consent":true}' }), params(vault.id))).status).toBe(200);
  expect((await signed('checkout.session.completed', paidObject)).status).toBe(200);
  expect(await db.vaultEntry.count({ where: { orderId } })).toBe(1); expect(await db.vaultEntry.findUniqueOrThrow({ where: { orderId } })).toMatchObject({ id: vault.id, publicConsent: true, status: 'STORED', quantity: 2 });
  const listed = await listOrders(); expect(listed.status).toBe(200); expect((await listed.json()).orders).toHaveLength(1);
  expect(await db.submission.findUniqueOrThrow({ where: { id: originalId }, include: { pages: { orderBy: { order: 'asc' } }, renderJobs: { orderBy: { id: 'asc' } } } })).toEqual(rejected);
  journeyReport = { output, data: { scope: 'Actual local service journey with mocked sessions/email/S3/Stripe adapters; real canonical traversal and native Chromium saved downloads',
    postgresMajor: major, originalId, correctedId, orderId, attemptId: attempt.id, amountMinor: frozen.expectedMinorAmount,
    currency: frozen.currency, artifactManifest: manifest, noDuplicateOrdersAttemptsVault: true,
    retainedOriginalArtifacts: true, fulfillment: refunded.status, payment: refunded.paymentState,
    unverified: ['NextAuth full browser journey', 'real providers/staging', 'printer/carrier', 'physical Vault receipt'] } };
}, 120000);
