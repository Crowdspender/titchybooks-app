import type { OrderPaymentState } from "@prisma/client";
import { formatCharge, isCurrency } from "@/lib/pricing/currency";

const LABELS: Record<OrderPaymentState, string> = {
  UNPAID: "Awaiting payment",
  PROCESSING: "Payment processing",
  PAID: "Payment confirmed",
  MANUAL_PAID: "Manual payment recorded",
  FAILED: "Payment failed",
  REVIEW: "Payment needs review",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Fully refunded",
  DISPUTED: "Payment disputed",
  DISPUTE_LOST: "Dispute lost",
};
export function paymentStateLabel(state: OrderPaymentState | null) {
  return state ? LABELS[state] : "Historical payment state unknown";
}
export function paymentMessage(state: OrderPaymentState | null, hold: boolean) {
  if (hold) {
    return "Payment needs review. Do not pay again; contact us. Unstarted fulfillment is on hold.";
  }
  switch (state) {
    case "PAID":
      return "Payment received and confirmed in our records.";
    case "MANUAL_PAID":
      return "An operator recorded manual payment evidence. This is not Stripe confirmation.";
    case "PROCESSING":
      return "Payment is still processing. Do not pay again; refresh this page later.";
    case "UNPAID":
      return "Payment has not been confirmed. A checkout return URL is not proof of payment.";
    case "FAILED":
      return "The payment failed. Any retry retains your original accepted charge.";
    case "PARTIALLY_REFUNDED":
      return "A partial refund is recorded. Payment and physical fulfillment are tracked separately.";
    case "REFUNDED":
      return "A full refund is recorded. This does not erase any shipment or stored Vault copy.";
    case "DISPUTED":
      return "A payment dispute is recorded. Contact us for the reviewed fulfillment decision.";
    case "DISPUTE_LOST":
      return "The payment dispute was lost. Contact us for the reviewed fulfillment decision.";
    case "REVIEW":
      return "Payment facts require review. Contact us before making another payment.";
    default:
      return "Historical payment facts have not been reconciled. No payment or refund is inferred.";
  }
}
/** Only minimized canonical totals are shown; provider requests and proofs stay out of customer UI. */
export default function PaymentStatus({ state, hold, summary }: {
  state: OrderPaymentState | null;
  hold: boolean;
  summary?: unknown;
}) {
  const totals = summary && typeof summary === "object"
    ? summary as Record<string, unknown>
    : null;
  const currency = totals?.currency;
  const fields = [
    ["receivedMinor", "Provider payment received"],
    ["refundedMinor", "Refunded"],
    ["pendingRefundMinor", "Refund pending"],
    ["failedRefundMinor", "Refund failed"],
    ["disputedMinor", "Active dispute"],
    ["lostDisputeMinor", "Lost dispute"],
  ] as const;
  return (
    <div className="space-y-2 text-sm">
      <p className="font-semibold">{paymentStateLabel(state)}</p>
      <p style={{ color: "var(--color-text-muted)" }}>
        {paymentMessage(state, hold)}
      </p>
      {totals && isCurrency(currency) && (
        <dl className="space-y-1">
          {fields.map(([key, label]) => {
            const amount = totals[key];
            return typeof amount === "number" && Number.isSafeInteger(amount) &&
                amount >= 0 &&
                (key === "receivedMinor" || amount > 0)
              ? (
                <div className="flex flex-wrap justify-between gap-2" key={key}>
                  <dt>{label}</dt>
                  <dd>{formatCharge(amount, currency)}</dd>
                </div>
              )
              : null;
          })}
        </dl>
      )}
    </div>
  );
}
