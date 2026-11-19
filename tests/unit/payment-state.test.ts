import { describe, expect, it } from 'vitest';
import { projectPayment, type CanonicalPaymentProof, type CanonicalRefund, type CanonicalDispute, type PaymentProjectionInput } from '@/lib/orders/payment-state';

const input: PaymentProjectionInput = { expectedMinorAmount: 400000, currency: 'HUF', fulfillment: 'PENDING_PAYMENT', hasManualSettlement: false };
function proof(patch: Partial<CanonicalPaymentProof> = {}): CanonicalPaymentProof {
  return { attemptId: 'attempt-one', sessionId: 'cs_one', paymentIntentId: 'pi_one', expectedAccountId: 'acct_one',
    accountId: 'acct_one', expectedLivemode: false, livemode: false, expectedMinorAmount: 400000,
    amountMinor: 400000, currency: 'HUF', status: 'SUCCEEDED', receivedMinor: 400000,
    refunds: [], disputes: [], reviewReasons: [], ...patch };
}
function refund(patch: Partial<CanonicalRefund> = {}): CanonicalRefund {
  return { id: 're_one', chargeId: 'ch_one', amountMinor: 100000, currency: 'HUF', status: 'succeeded', ...patch };
}
function dispute(patch: Partial<CanonicalDispute> = {}): CanonicalDispute {
  return { id: 'dp_one', chargeId: 'ch_one', amountMinor: 400000, currency: 'HUF', status: 'needs_response', ...patch };
}

describe('canonical payment projection, independent of fulfillment', () => {
  it('retains unmatched event review reasons even without a provable payment', () => {
    expect(projectPayment({ ...input, reviewReasons: ['unknown-provider-reference'] }, []))
      .toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
  });
  it('does not invent an account identity or hold a not-yet-issued prepared request', () => {
    expect(projectPayment(input, [proof({ status: 'PREPARED', sessionId: null, paymentIntentId: null,
      expectedAccountId: null, receivedMinor: 0 })])).toMatchObject({ state: 'UNPAID', hold: false, canSettle: false });
  });
  it('does not infer unknown legacy payments or FX', () => {
    expect(projectPayment({ ...input, expectedMinorAmount: null, fulfillment: 'SHIPPED' }, [])).toMatchObject({ state: null, hold: false, canSettle: false });
  });
  it('labels recorded manual settlement without claiming Stripe paid', () => {
    expect(projectPayment({ ...input, hasManualSettlement: true, fulfillment: 'PAID' }, [])).toMatchObject({ state: 'MANUAL_PAID', hold: false, canSettle: false });
  });
  it.each(['HUF', 'EUR', 'GBP'])('settles one exactly matched %s charge only', currency => {
    expect(projectPayment({ ...input, currency }, [proof({ currency })])).toMatchObject({ state: 'PAID', hold: false, canSettle: true });
  });
  it.each(['PAID', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED'] as const)('never resettles %s or resets fulfillment', fulfillment => {
    expect(projectPayment({ ...input, fulfillment }, [proof()])).toMatchObject({ state: 'PAID', hold: false, canSettle: false });
  });
  it.each([
    ['wrong currency', { currency: 'EUR' }], ['wrong account', { accountId: 'acct_other' }],
    ['unknown original account', { expectedAccountId: null }], ['wrong mode', { livemode: true }],
    ['wrong amount', { amountMinor: 400100 }], ['wrong expected amount', { expectedMinorAmount: 400100 }],
    ['underpayment', { receivedMinor: 399900 }], ['overpayment', { receivedMinor: 400100 }],
    ['missing payment reference', { paymentIntentId: null }], ['ambiguous outcome', { status: 'AMBIGUOUS' }],
    ['unconfirmed payment', { status: 'OPEN' }], ['bad provider reference', { reviewReasons: ['session-reference-mismatch'] }],
    ['unsafe integer', { receivedMinor: Number.MAX_SAFE_INTEGER + 1 }], ['negative received amount', { receivedMinor: -1 }],
  ] as Array<[string, Partial<CanonicalPaymentProof>]>)('holds %s without settlement', (_name, patch) => {
    expect(projectPayment(input, [proof(patch)])).toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
  });
  it('does not combine unrelated currency/mode/account balances', () => {
    for (const patch of [{ currency: 'EUR' }, { livemode: true }, { accountId: 'acct_other' }]) {
      expect(projectPayment(input, [proof(patch)]).summary.receivedMinor).toBe(0);
    }
  });
  it('requires review for a payment on a canceled order without reviving it', () => {
    const result = projectPayment({ ...input, fulfillment: 'CANCELLED' }, [proof()]);
    expect(result).toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
    expect(result.summary.reviewReasons).toContain('payment-on-canceled-order');
  });
  it('flags provider payment after manual settlement as an additional payment', () => {
    expect(projectPayment({ ...input, hasManualSettlement: true, fulfillment: 'PAID' }, [proof()]))
      .toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
  });
  it('recognizes valid earlier attempts and refuses duplicate or additional payments', () => {
    const old = proof({ attemptId: 'old' });
    const newer = proof({ attemptId: 'new', sessionId: 'cs_new', paymentIntentId: null, status: 'OPEN', receivedMinor: 0 });
    expect(projectPayment(input, [old, newer])).toMatchObject({ state: 'PAID', hold: false, canSettle: true });
    const duplicateReference = projectPayment(input, [old, proof({ attemptId: 'new' })]);
    expect(duplicateReference.summary.receivedMinor).toBe(400000);
    expect(duplicateReference).toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
    const additional = projectPayment(input, [old, proof({ attemptId: 'new', paymentIntentId: 'pi_new' })]);
    expect(additional.summary.receivedMinor).toBe(800000);
    expect(additional.summary.reviewReasons).toContain('overpayment');
    expect(additional.canSettle).toBe(false);
  });
  it('uses canonical refund totals rather than increments per event delivery', () => {
    const facts = [proof({ refunds: [refund(), refund()] })];
    const first = projectPayment(input, facts), replay = projectPayment(input, facts);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ state: 'PARTIALLY_REFUNDED', hold: true, canSettle: false,
      summary: { refundedMinor: 100000, netReceivedMinor: 300000 } });
  });
  it('reconciles a full refund without changing physical state or creating goods', () => {
    const result = projectPayment({ ...input, fulfillment: 'SHIPPED' }, [proof({ refunds: [refund({ amountMinor: 400000 })] })]);
    expect(result).toMatchObject({ state: 'REFUNDED', hold: true, canSettle: false, summary: { netReceivedMinor: 0 } });
  });
  it.each(['pending', 'requires_action', 'failed'])('keeps %s refunds visible without subtracting unconfirmed money', status => {
    const result = projectPayment(input, [proof({ refunds: [refund({ status })] })]);
    expect(result).toMatchObject({ state: 'REVIEW', hold: true, canSettle: false,
      summary: { receivedMinor: 400000, refundedMinor: 0, netReceivedMinor: 400000 } });
    expect(status === 'failed' ? result.summary.failedRefundMinor : result.summary.pendingRefundMinor).toBe(100000);
  });
  it('does not treat a canceled refund as refunded', () => {
    expect(projectPayment(input, [proof({ refunds: [refund({ status: 'canceled' })] })]))
      .toMatchObject({ state: 'PAID', hold: false, summary: { refundedMinor: 0 } });
  });
  it.each(['warning_needs_response', 'warning_under_review', 'needs_response', 'under_review'])('holds a %s dispute', status => {
    expect(projectPayment(input, [proof({ disputes: [dispute({ status })] })]))
      .toMatchObject({ state: 'DISPUTED', hold: true, canSettle: false, summary: { disputedMinor: 400000 } });
  });
  it.each(['won', 'warning_closed'])('releases a resolved %s dispute after canonical confirmation', status => {
    expect(projectPayment(input, [proof({ disputes: [dispute({ status })] })]))
      .toMatchObject({ state: 'PAID', hold: false, canSettle: true, summary: { disputedMinor: 0 } });
  });
  it('retains a lost dispute and does not invent a refund', () => {
    expect(projectPayment(input, [proof({ disputes: [dispute({ status: 'lost' })] })]))
      .toMatchObject({ state: 'DISPUTE_LOST', hold: true, canSettle: false, summary: { lostDisputeMinor: 400000, refundedMinor: 0 } });
  });
  it.each([
    { refunds: [refund({ amountMinor: 400100 })] },
    { refunds: [refund(), refund({ amountMinor: 200000 })] },
    { refunds: [refund({ status: 'unknown' })] },
    { disputes: [dispute({ status: 'unknown' })] },
    { disputes: [dispute(), dispute({ status: 'lost' })] },
    { refunds: [refund({ currency: 'GBP' })] },
    { disputes: [dispute({ amountMinor: -1 })] },
  ] as Array<Partial<CanonicalPaymentProof>>)('fails closed on conflicting/malformed refund or dispute facts: %j', patch => {
    expect(projectPayment(input, [proof(patch)])).toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
  });
  it('binds an explicit hold release to the exact canonical facts and reholds changed outcomes', () => {
    const facts = [proof({ refunds: [refund()] })];
    const initial = projectPayment(input, facts);
    const reviewed = projectPayment({ ...input, reviewedFingerprint: initial.summary.fingerprint }, facts);
    expect(reviewed).toMatchObject({ state: 'PARTIALLY_REFUNDED', hold: false, canSettle: false });
    const changed = projectPayment({ ...input, reviewedFingerprint: initial.summary.fingerprint }, [proof({ refunds: [refund({ amountMinor: 200000 })] })]);
    expect(changed.hold).toBe(true);
    expect(changed.summary.fingerprint).not.toBe(initial.summary.fingerprint);
  });
  it('does not let a reviewed mismatch become a paid order', () => {
    const facts = [proof({ amountMinor: 400100 })];
    const initial = projectPayment(input, facts);
    expect(projectPayment({ ...input, reviewedFingerprint: initial.summary.fingerprint }, facts))
      .toMatchObject({ state: 'REVIEW', hold: false, canSettle: false });
  });
  it('creates the same review fingerprint irrespective of canonical list ordering', () => {
    const a = proof({ attemptId: 'a', refunds: [refund({ id: 're_b', amountMinor: 100 }), refund({ id: 're_a', amountMinor: 100 })] });
    const b = proof({ attemptId: 'b', sessionId: 'cs_b', paymentIntentId: null, status: 'OPEN', receivedMinor: 0 });
    expect(projectPayment(input, [a, b]).summary.fingerprint).toBe(projectPayment(input, [b, { ...a, refunds: [...a.refunds].reverse() }]).summary.fingerprint);
  });
  it.each(['OPEN', 'PREPARED', 'EXPIRED', 'FAILED', 'PROCESSING'] as const)('represents unpaid %s outcomes without claiming payment', status => {
    const result = projectPayment(input, [proof({ status, paymentIntentId: null, receivedMinor: 0 })]);
    expect(result.state).toBe(status === 'FAILED' ? 'FAILED' : status === 'PROCESSING' ? 'PROCESSING' : 'UNPAID');
    expect(result.canSettle).toBe(false);
  });
});
