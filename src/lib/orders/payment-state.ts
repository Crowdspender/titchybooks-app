import { createHash } from 'node:crypto';
import type { OrderPaymentState, OrderStatus, PaymentAttemptStatus } from '@prisma/client';

export interface CanonicalRefund {
  id: string;
  chargeId: string;
  amountMinor: number;
  currency: string;
  status: string;
}
export interface CanonicalDispute {
  id: string;
  chargeId: string;
  amountMinor: number;
  currency: string;
  status: string;
}
/** Minimized canonical provider facts, not event-delivery increments. The gateway
 * verifies Checkout/PaymentIntent/charge references before constructing a proof.
 */
export interface CanonicalPaymentProof {
  attemptId: string;
  sessionId: string | null;
  paymentIntentId: string | null;
  expectedAccountId: string | null;
  accountId: string;
  expectedLivemode: boolean;
  livemode: boolean;
  expectedMinorAmount: number;
  amountMinor: number;
  currency: string;
  status: PaymentAttemptStatus;
  receivedMinor: number;
  refunds: CanonicalRefund[];
  disputes: CanonicalDispute[];
  reviewReasons: string[];
  unmatchedSessionIds?: string[];
}
export interface PaymentProjectionInput {
  expectedMinorAmount: number | null;
  currency: string;
  fulfillment: OrderStatus;
  hasManualSettlement: boolean;
  reviewedFingerprint?: string | null;
  reviewReasons?: string[];
}
export interface PaymentProjection {
  state: OrderPaymentState | null;
  hold: boolean;
  canSettle: boolean;
  summary: {
    version: 1;
    currency: string;
    expectedMinorAmount: number | null;
    receivedMinor: number;
    refundedMinor: number;
    pendingRefundMinor: number;
    failedRefundMinor: number;
    disputedMinor: number;
    lostDisputeMinor: number;
    netReceivedMinor: number;
    proofs: CanonicalPaymentProof[];
    reviewReasons: string[];
    fingerprint: string;
  };
}
const OPEN_DISPUTES = new Set(['warning_needs_response', 'warning_under_review', 'needs_response', 'under_review']);
const CLOSED_DISPUTES = new Set(['won', 'warning_closed']);
const REFUND_STATUSES = new Set(['succeeded', 'pending', 'requires_action', 'failed', 'canceled']);
const minor = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 99_999_999;

/** Canonical order projection. It neither initiates refunds nor changes physical
 * fulfillment/paidAt/Vault history. A reviewed release covers only this exact
 * financial fingerprint; a changed refund/dispute/attempt invalidates it.
 */
export function projectPayment(input: PaymentProjectionInput, facts: CanonicalPaymentProof[]): PaymentProjection {
  const proofs = facts.map(proof => ({ ...proof,
    refunds: [...proof.refunds].sort((a, b) => a.id.localeCompare(b.id)),
    disputes: [...proof.disputes].sort((a, b) => a.id.localeCompare(b.id)),
    reviewReasons: [...new Set(proof.reviewReasons)].sort(),
    unmatchedSessionIds: [...new Set(proof.unmatchedSessionIds ?? [])].sort(),
  })).sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  const reasons = new Set<string>(input.reviewReasons ?? []);
  let receivedMinor = 0, refundedMinor = 0, pendingRefundMinor = 0, failedRefundMinor = 0;
  let disputedMinor = 0, lostDisputeMinor = 0, successfulPayments = 0;
  const intents = new Set<string>(), attempts = new Set<string>();
  const refunds = new Map<string, CanonicalRefund>(), disputes = new Map<string, CanonicalDispute>();
  const knownCurrency = ['HUF', 'EUR', 'GBP'].includes(input.currency);
  if (proofs.length && (!knownCurrency || input.expectedMinorAmount === null || !minor(input.expectedMinorAmount) || input.expectedMinorAmount <= 0)) reasons.add('unknown-expected-charge');

  for (const proof of proofs) {
    proof.reviewReasons.forEach(reason => reasons.add(reason));
    if (attempts.has(proof.attemptId)) reasons.add('duplicate-attempt');
    attempts.add(proof.attemptId);
    const validContext = knownCurrency && proof.currency === input.currency &&
      proof.expectedLivemode === proof.livemode && !!proof.expectedAccountId && proof.expectedAccountId === proof.accountId;
    if (proof.currency !== input.currency) reasons.add('currency-mismatch');
    if (proof.expectedLivemode !== proof.livemode) reasons.add('mode-mismatch');
    if ((proof.sessionId || proof.paymentIntentId || proof.status !== 'PREPARED') &&
        (!proof.expectedAccountId || proof.expectedAccountId !== proof.accountId)) reasons.add('account-mismatch');
    if (!minor(proof.amountMinor) || proof.amountMinor <= 0 || proof.amountMinor !== proof.expectedMinorAmount ||
        proof.expectedMinorAmount !== input.expectedMinorAmount) reasons.add('amount-mismatch');
    if (!minor(proof.receivedMinor)) reasons.add('invalid-received-amount');
    if (proof.status === 'REVIEW' || proof.status === 'AMBIGUOUS') reasons.add('unconfirmed-attempt');
    if (proof.status === 'SUCCEEDED' && proof.receivedMinor !== proof.amountMinor) reasons.add('received-amount-mismatch');
    if (proof.receivedMinor > 0 && proof.status !== 'SUCCEEDED') reasons.add('unconfirmed-received-payment');
    if (proof.receivedMinor > 0 && !proof.paymentIntentId) reasons.add('missing-payment-reference');
    const duplicateIntent = proof.paymentIntentId !== null && intents.has(proof.paymentIntentId);
    if (duplicateIntent) reasons.add('shared-payment-reference');
    if (proof.paymentIntentId) intents.add(proof.paymentIntentId);
    // Never add unrelated currency/account/mode totals, nor count the same intent twice.
    if (validContext && minor(proof.receivedMinor) && !duplicateIntent) {
      receivedMinor += proof.receivedMinor;
      if (proof.receivedMinor > 0) successfulPayments++;
    }
    for (const refund of proof.refunds) {
      const previous = refunds.get(refund.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(refund)) reasons.add('conflicting-refund-facts');
      if (!validContext || !minor(refund.amountMinor) || refund.currency !== input.currency || !refund.id || !refund.chargeId) {
        reasons.add('invalid-refund-facts'); continue;
      }
      if (!REFUND_STATUSES.has(refund.status)) reasons.add('unknown-refund-status');
      if (!previous) refunds.set(refund.id, refund);
    }
    for (const dispute of proof.disputes) {
      const previous = disputes.get(dispute.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(dispute)) reasons.add('conflicting-dispute-facts');
      if (!validContext || !minor(dispute.amountMinor) || dispute.currency !== input.currency || !dispute.id || !dispute.chargeId) {
        reasons.add('invalid-dispute-facts'); continue;
      }
      if (!OPEN_DISPUTES.has(dispute.status) && !CLOSED_DISPUTES.has(dispute.status) && dispute.status !== 'lost') reasons.add('unknown-dispute-status');
      if (!previous) disputes.set(dispute.id, dispute);
    }
  }
  for (const refund of refunds.values()) {
    if (refund.status === 'succeeded') refundedMinor += refund.amountMinor;
    if (refund.status === 'pending' || refund.status === 'requires_action') pendingRefundMinor += refund.amountMinor;
    if (refund.status === 'failed') failedRefundMinor += refund.amountMinor;
  }
  for (const dispute of disputes.values()) {
    if (OPEN_DISPUTES.has(dispute.status)) disputedMinor += dispute.amountMinor;
    if (dispute.status === 'lost') lostDisputeMinor += dispute.amountMinor;
  }
  if (![receivedMinor, refundedMinor, pendingRefundMinor, failedRefundMinor, disputedMinor, lostDisputeMinor].every(Number.isSafeInteger)) reasons.add('unsafe-provider-total');
  if (refundedMinor + pendingRefundMinor > receivedMinor) reasons.add('refund-exceeds-payment');
  if (input.expectedMinorAmount !== null && receivedMinor > input.expectedMinorAmount) reasons.add('overpayment');
  if (receivedMinor > 0 && receivedMinor < (input.expectedMinorAmount ?? Infinity)) reasons.add('underpayment');
  if (successfulPayments > 1) reasons.add('multiple-payments');
  if (receivedMinor > 0 && input.fulfillment === 'CANCELLED') reasons.add('payment-on-canceled-order');
  if (receivedMinor > 0 && input.hasManualSettlement) reasons.add('provider-payment-after-manual-settlement');
  const reviewReasons = [...reasons].sort();
  const netReceivedMinor = Math.max(0, receivedMinor - refundedMinor);
  const fingerprint = createHash('sha256').update(JSON.stringify({
    expectedMinorAmount: input.expectedMinorAmount, currency: input.currency, proofs, reviewReasons,
  })).digest('hex');
  const financialRisk = reviewReasons.length > 0 || refundedMinor > 0 || pendingRefundMinor > 0 || failedRefundMinor > 0 || disputedMinor > 0 || lostDisputeMinor > 0;
  const hold = financialRisk && input.reviewedFingerprint !== fingerprint;
  let state: OrderPaymentState | null;
  if (reviewReasons.length) state = 'REVIEW';
  else if (disputedMinor > 0) state = 'DISPUTED';
  else if (lostDisputeMinor > 0) state = 'DISPUTE_LOST';
  else if (receivedMinor > 0 && refundedMinor === receivedMinor) state = 'REFUNDED';
  else if (refundedMinor > 0) state = 'PARTIALLY_REFUNDED';
  else if (pendingRefundMinor > 0 || failedRefundMinor > 0) state = 'REVIEW';
  else if (receivedMinor > 0 && receivedMinor === input.expectedMinorAmount) state = 'PAID';
  else if (input.hasManualSettlement) state = 'MANUAL_PAID';
  else if (proofs.some(proof => proof.status === 'PROCESSING')) state = 'PROCESSING';
  else if (proofs.some(proof => proof.status === 'OPEN' || proof.status === 'PREPARED')) state = 'UNPAID';
  else if (proofs.some(proof => proof.status === 'FAILED')) state = 'FAILED';
  else state = proofs.length ? 'UNPAID' : null;
  return { state, hold,
    // Releasing a hold does not turn a refund, mismatch or cancellation into payment.
    canSettle: input.fulfillment === 'PENDING_PAYMENT' && state === 'PAID' && !hold && successfulPayments === 1,
    summary: { version: 1, currency: input.currency, expectedMinorAmount: input.expectedMinorAmount,
      receivedMinor, refundedMinor, pendingRefundMinor, failedRefundMinor, disputedMinor, lostDisputeMinor,
      netReceivedMinor, proofs, reviewReasons, fingerprint },
  };
}
