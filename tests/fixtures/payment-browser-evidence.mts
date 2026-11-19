import { hash } from 'bcryptjs';
import { db, createDraft, createUser, cleanupFixtures } from './database';
import { createOrderForUser } from './orders';
import { projectPayment, type CanonicalPaymentProof } from '../../src/lib/orders/payment-state';

// Launched only through the sanitized local test-db harness. Synthetic facts are
// not evidence of a Stripe transaction; this fixture supports browser-use checks.
const action = process.argv[2];
try {
  if (action === 'seed') {
    try {
      // Both identities are created inside the cleanup scope: if the customer
      // insert fails, the tracked admin is removed instead of leaking.
      const password = 'Local-payment-evidence-42!';
      const admin = await createUser('ADMIN', await hash(password, 10));
      const customer = await createUser('USER', await hash(password, 10));
      const { order } = await createOrderForUser(customer.id, { currency: 'EUR', status: 'SHIPPED', vaultAddOn: true, title: 'Batch 5 isolated financial evidence' });
      await db.order.update({ where: { id: order.id }, data: { expectedMinorAmount: 2740 } });
      const attempt = await db.paymentAttempt.create({ data: { orderId: order.id, sequence: 1,
        idempotencyKey: `synthetic-evidence:${order.id}`, expectedMinorAmount: 2740, currency: 'EUR', livemode: false,
        providerAccountId: 'acct_synthetic_evidence', sessionId: `cs_evidence_${order.id}`, paymentIntentId: `pi_evidence_${order.id}`,
        status: 'SUCCEEDED', providerRequest: { origin: 'SYNTHETIC_BROWSER_EVIDENCE', request: null } } });
      const proof: CanonicalPaymentProof = { attemptId: attempt.id, sessionId: attempt.sessionId, paymentIntentId: attempt.paymentIntentId,
        expectedAccountId: attempt.providerAccountId, accountId: attempt.providerAccountId!, expectedLivemode: false, livemode: false,
        expectedMinorAmount: 2740, amountMinor: 2740, currency: 'EUR', status: 'SUCCEEDED', receivedMinor: 2740,
        refunds: [{ id: 're_synthetic_evidence', chargeId: 'ch_synthetic_evidence', amountMinor: 1000, currency: 'EUR', status: 'succeeded' }],
        disputes: [], reviewReasons: [] };
      const projection = projectPayment({ expectedMinorAmount: 2740, currency: 'EUR', fulfillment: 'SHIPPED', hasManualSettlement: false }, [proof]);
      await db.paymentAttempt.update({ where: { id: attempt.id }, data: { providerSnapshot: JSON.parse(JSON.stringify(proof)) } });
      await db.order.update({ where: { id: order.id }, data: { stripeSessionId: attempt.sessionId,
        paymentState: projection.state, paymentHold: projection.hold, paymentSummary: JSON.parse(JSON.stringify(projection.summary)) } });
      await db.vaultEntry.create({ data: { orderId: order.id, submissionId: order.submissionId,
        title: 'Synthetic retained copy', authorName: 'Synthetic Customer', quantity: 2, publicConsent: false, status: 'STORED' } });
      await db.paymentEvent.create({ data: { providerEventId: `evt_evidence_${order.id}`, source: 'SIGNED_WEBHOOK',
        type: 'refund.updated', orderId: order.id, attemptId: attempt.id, status: 'REVIEW', dataDigest: 'c'.repeat(64),
        data: { objectId: 're_synthetic_evidence', amountMinor: 1000, currency: 'eur' }, outcome: 'Synthetic persisted refund review' } });
      const draft = await createDraft(customer.id);
      await db.submission.update({ where: { id: draft.id }, data: { title: 'Batch 6 browser save evidence' } });
      const review = await db.submission.create({ data: { userId: customer.id, mode: 'LEGACY_UPLOAD', status: 'PENDING',
        title: 'Batch 6 canceled review evidence', pdfS3Key: 'synthetic/retained-review.pdf' } });
      console.log(JSON.stringify({ adminId: admin.id, adminEmail: admin.email, customerId: customer.id, customerEmail: customer.email,
        orderId: order.id, draftId: draft.id, reviewId: review.id, password }));
    } catch (error) { await cleanupFixtures(); throw error; }
  } else if (action === 'audit') {
    const audit = await db.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const users = await tx.user.findMany({ where: { email: { startsWith: 'sprint-', endsWith: '@example.invalid' } }, select: { id: true, email: true } });
      if (users.some(user => !/^sprint-[a-f0-9-]+@example\.invalid$/.test(user.email))) throw new Error('Unexpected fixture identity');
      const [{ major }] = await tx.$queryRaw<Array<{ major: number }>>`SELECT current_setting('server_version_num')::int / 10000 AS major`;
      const scratch = await tx.$queryRaw<Array<{ datname: string }>>`SELECT datname FROM pg_database
        WHERE datname ~ '^batch7_restore_test_[0-9a-f]{24}_(source|restored)$' ORDER BY datname`;
      return { postgresMajor: major, readOnly: true, fixtureUserIds: users.map(user => user.id), fixtureUsers: users.length,
        totalUsers: await tx.user.count(), submissions: await tx.submission.count(), pages: await tx.submissionPage.count(),
        templateElements: await tx.templateElement.count(), assets: await tx.asset.count(),
        orders: await tx.order.count(), vaultEntries: await tx.vaultEntry.count(), paymentAttempts: await tx.paymentAttempt.count(),
        paymentEvents: await tx.paymentEvent.count(), paymentAlerts: await tx.paymentAlert.count(),
        renderJobs: await tx.renderJob.count(), aiBookJobs: await tx.aiBookJob.count(),
        rateLimitBuckets: await tx.rateLimitBucket.count(), pricingConfigs: await tx.pricingConfig.count(),
        queueDrainRuns: await tx.queueDrainRun.count(), ownedScratchDatabases: scratch.map(row => row.datname) };
    }, { isolationLevel: 'RepeatableRead', timeout: 15000 });
    console.log(JSON.stringify(audit));
  } else if (action === 'cleanup' || action === 'cleanup-interrupted') {
    const ids = process.argv.slice(3);
    if (!ids.length || new Set(ids).size !== ids.length || (action === 'cleanup' && ids.length !== 2)) throw new Error('Supply the exact isolated fixture IDs from seed or audit');
    const users = await db.user.findMany({ where: { id: { in: ids } } });
    if (users.length !== ids.length || users.some(user => !/^sprint-[a-f0-9-]+@example\.invalid$/.test(user.email))) throw new Error('Not the isolated evidence identities');
    await db.$transaction(async tx => {
      await tx.aiBookJob.deleteMany({ where: { userId: { in: ids } } });
      await tx.renderJob.deleteMany({ where: { submission: { userId: { in: ids } } } });
      await tx.vaultEntry.deleteMany({ where: { order: { userId: { in: ids } } } });
      await tx.paymentEvent.deleteMany({ where: { order: { userId: { in: ids } } } });
      await tx.paymentAttempt.deleteMany({ where: { order: { userId: { in: ids } } } });
      await tx.order.deleteMany({ where: { userId: { in: ids } } });
      await tx.submission.updateMany({ where: { userId: { in: ids } }, data: { templateId: null } });
      await tx.submission.deleteMany({ where: { userId: { in: ids } } });
      await tx.asset.deleteMany({ where: { userId: { in: ids } } });
      await tx.rateLimitBucket.deleteMany({ where: { bucketKey: { in: users.flatMap(user => [
        `login:${user.email}`, `forgot:email:${user.email}`,
        ...['submission:user', 'quote:user', 'order:user', 'order-request:user', 'pay:user', 'ai-book:user', 'payment-review:admin'].map(prefix => `${prefix}:${user.id}`),
      ]) } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    });
    console.log(`Removed only ${ids.length} explicitly identified local fixture users and their records.`);
  } else throw new Error('Expected seed, audit, cleanup, or cleanup-interrupted');
} finally { await db.$disconnect(); }
