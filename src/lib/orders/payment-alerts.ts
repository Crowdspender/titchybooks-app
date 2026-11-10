import { prisma } from "@/lib/prisma";

/**
 * Durable payment-reconciliation alerts.
 *
 * The checkout webhook and the admin "mark PAID" path both take decisions that
 * are correct but still need a human to look at them: a signature-verified
 * payment against a superseded session is honoured anyway, an unpaid completion
 * is acknowledged and dropped, and a vault entry that fails to be created
 * leaves a paid order without the storage copy the buyer paid for.
 *
 * A structured log line is not a sufficient signal for any of those on
 * serverless hosting, where the log stream is only visible to someone who goes
 * looking. They are recorded here instead and surfaced in /admin/orders.
 *
 * Recording is best-effort on purpose: observability must never turn a
 * successful payment into a failed request, so every write is caught and logged.
 */

export const PAYMENT_ALERT_KINDS = [
  "stale-session",
  "unpaid-completion",
  "vault-entry-failed",
] as const;

export type PaymentAlertKind = (typeof PAYMENT_ALERT_KINDS)[number];

export interface RecordPaymentAlertInput {
  kind: PaymentAlertKind;
  /** Null only for a condition that could not be tied to a stored order. */
  orderId: string | null;
  /** Operator-facing summary. Keep it short; put the detail in `context`. */
  message: string;
  /** Supporting detail (session ids, error text), stored as JSON. */
  context?: Record<string, unknown>;
  /**
   * Discriminator within the kind; defaults to the order id. Pass the Stripe
   * session id when a second distinct session for the same order should be
   * visible in its own right rather than folded into the first alert.
   */
  subject?: string;
}

export interface PaymentAlertView {
  id: string;
  orderId: string | null;
  kind: string;
  message: string;
  context: Record<string, unknown> | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Alerts listed per screen; reconciliation queues are short by nature. */
export const PAYMENT_ALERT_LIST_LIMIT = 50;

function dedupeKeyFor(input: RecordPaymentAlertInput): string {
  return `${input.kind}:${input.subject ?? input.orderId ?? "unknown"}`;
}

function parseContext(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A malformed context must not hide the alert itself.
    return null;
  }
}

/**
 * Record (or re-record) one reconciliation condition.
 *
 * Stripe retries deliveries, so the same event can arrive many times: the
 * dedupe key collapses those into one row with an occurrence count instead of
 * burying the operator in duplicates. A recurrence also reopens an alert that
 * was already dismissed, because the condition is evidently still live.
 */
export async function recordPaymentAlert(
  input: RecordPaymentAlertInput,
): Promise<void> {
  const dedupeKey = dedupeKeyFor(input);
  const now = new Date();
  const context = input.context ? JSON.stringify(input.context) : null;
  try {
    await prisma.paymentAlert.upsert({
      where: { dedupeKey },
      create: {
        orderId: input.orderId,
        kind: input.kind,
        message: input.message,
        context,
        dedupeKey,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        occurrences: { increment: 1 },
        lastSeenAt: now,
        message: input.message,
        context,
        resolvedAt: null,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "payment-alert-record-failed",
        kind: input.kind,
        dedupeKey,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Open alerts, most recently seen first, for the admin orders screen. */
export async function listOpenPaymentAlerts(
  limit = PAYMENT_ALERT_LIST_LIMIT,
): Promise<PaymentAlertView[]> {
  const rows = await prisma.paymentAlert.findMany({
    where: { resolvedAt: null },
    orderBy: { lastSeenAt: "desc" },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    orderId: row.orderId,
    kind: row.kind,
    message: row.message,
    context: parseContext(row.context),
    occurrences: row.occurrences,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}

/**
 * Dismiss one alert. Returns false when there was nothing to dismiss, which the
 * caller reports as a 404 rather than a silent success.
 */
export async function resolvePaymentAlert(id: string): Promise<boolean> {
  const updated = await prisma.paymentAlert.updateMany({
    where: { id, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
  return updated.count === 1;
}
