"use client";

import { useEffect, useRef, useState } from "react";
import type { OrderPaymentState } from "@prisma/client";
import type { PaymentProjection } from "@/lib/orders/payment-state";
import PaymentStatus from "@/components/orders/PaymentStatus";
import { formatCharge, isCurrency } from "@/lib/pricing/currency";

interface History {
  id: string;
  status: string;
  paymentState: OrderPaymentState | null;
  paymentHold: boolean;
  paymentSummary: PaymentProjection["summary"] | null;
  paymentAttempts: Array<
    {
      id: string;
      sequence: number;
      status: string;
      expectedMinorAmount: number;
      currency: string;
      livemode: boolean;
      providerAccountId: string | null;
      sessionId: string | null;
      paymentIntentId: string | null;
      failureCode: string | null;
      providerSnapshot: unknown;
      createdAt: string;
    }
  >;
  paymentEvents: Array<
    {
      id: string;
      providerEventId: string;
      source: string;
      type: string;
      status: string;
      data: unknown;
      outcome: string | null;
      createdAt: string;
    }
  >;
}
export default function OrderPaymentHistory({ orderId, onClose, onChanged }: {
  orderId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [explanation, setExplanation] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      setFresh(false);
      setConfirmed(false);
      try {
        const response = await fetch(`/api/admin/orders/${orderId}/payment`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok || !data.order) {
          throw new Error(data.error || "Payment history is unavailable.");
        }
        if (!controller.signal.aborted) {
          setHistory(data.order);
          setFresh(true);
        }
      } catch {
        if (!controller.signal.aborted) {
          setHistory(null);
          setError(
            "Payment history could not be loaded. Reload before reviewing or fulfilling this order.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [orderId, reload]);

  async function act(action: "RECONCILE" | "RELEASE_HOLD") {
    if (lock.current || !history || !fresh) return;
    const fingerprint = history.paymentSummary?.fingerprint;
    if (
      action === "RELEASE_HOLD" &&
      (!confirmed || explanation.trim().length < 10 || !fingerprint)
    ) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setFresh(false);
    // A lost response or 5xx leaves the server outcome unknown; a 4xx is a
    // definitive rejection that keeps the manual reload path. A 5xx that
    // explicitly reports no attempt (e.g. reconciliation not configured) is
    // also definitive: nothing could have committed, so the error must stay
    // visible instead of being wiped by an automatic reload.
    let outcomeUnknown = true;
    try {
      const response = await fetch(`/api/admin/orders/${orderId}/payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "RECONCILE"
            ? { action }
            : {
              action,
              fingerprint,
              explanation: explanation.trim(),
              confirmed: true,
            },
        ),
      });
      const data = await response.json().catch(() => ({}));
      outcomeUnknown = response.status >= 500 && data.attempted !== false;
      if (!response.ok) {
        throw new Error(
          data.error ||
            "The financial action could not be confirmed. Reload history before retrying.",
        );
      }
      setNotice(
        action === "RECONCILE"
          ? "Canonical payment state recorded. Review the updated history below."
          : "Reviewed fulfillment hold released. No payment, refund, or physical status was changed.",
      );
      setExplanation("");
      setReload((value) => value + 1);
      onChanged();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The action could not be confirmed. Reload history.",
      );
      if (outcomeUnknown) {
        // The action may already have committed (a recorded dispute hold whose
        // response was lost): reload history and refresh the parent list now,
        // so moderation never resumes on a stale row after history closes.
        // Financial controls stay disabled until the reload marks facts fresh.
        setReload((value) => value + 1);
        onChanged();
      }
    } finally {
      setConfirmed(false);
      lock.current = false;
      setBusy(false);
    }
  }
  const fingerprint = history?.paymentSummary?.fingerprint;
  return (
    <section className="card p-5 mb-6 space-y-4" aria-label="Payment history">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Payment history and reconciliation</h2>
          <p className="text-xs break-all">Order {orderId}</p>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={onClose}
        >
          Close history
        </button>
      </div>
      <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
        Reconciliation reads Stripe and records canonical facts. Initiate
        refunds only in Stripe Dashboard. Closing checkout or canceling an order
        is not a refund. Shipped goods and stored Vault copies are never erased.
      </p>
      {error && <p role="alert" className="text-sm">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy || loading}
          onClick={() =>
            setReload((value) => value + 1)}
        >
          Reload payment history
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || loading || !fresh || !history}
          onClick={() => act("RECONCILE")}
        >
          {busy ? "Recording…" : "Reconcile with Stripe"}
        </button>
      </div>
      {loading ? <p role="status">Loading payment history…</p> : history && (
        <>
          <p className="text-sm">
            Physical fulfillment: {history.status.replaceAll("_", " ")}
          </p>
          <PaymentStatus
            state={history.paymentState}
            hold={history.paymentHold}
            summary={history.paymentSummary}
          />
          {history.paymentSummary && (
            <>
              <p className="text-xs break-all">
                Current facts fingerprint: {fingerprint}
              </p>
              {!!history.paymentSummary.reviewReasons.length && (
                <ul
                  className="list-disc pl-5 text-sm"
                  aria-label="Payment review reasons"
                >
                  {history.paymentSummary.reviewReasons.map((reason) => (
                    <li key={reason}>{reason.replaceAll("-", " ")}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {history.paymentHold && (
            <fieldset disabled={busy || !fresh} className="space-y-3 text-sm">
              <legend className="font-semibold">
                Explicit fulfillment review
              </legend>
              <p>
                Review every attempt, refund, dispute, and mismatch before
                releasing this hold. Release applies only to the displayed
                fingerprint; it does not turn a mismatch or refund into a
                payment or revive a canceled order.
              </p>
              <label className="block">
                Review explanation
                <textarea
                  className="input mt-1"
                  rows={3}
                  minLength={10}
                  maxLength={1000}
                  value={explanation}
                  onChange={(event) => {
                    setExplanation(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I reviewed these current financial facts and explicitly approve
                releasing the fulfillment hold.
              </label>
              <button
                className="btn btn-primary btn-sm"
                disabled={!confirmed || explanation.trim().length < 10 ||
                  !fingerprint}
                onClick={() => act("RELEASE_HOLD")}
              >
                Release reviewed hold
              </button>
            </fieldset>
          )}
          <h3 className="section-label">
            Issued attempts ({history.paymentAttempts.length})
          </h3>
          {!history.paymentAttempts.length && (
            <p className="text-sm">
              No recorded attempts. Historical issuance is not inferred.
            </p>
          )}
          <ul className="space-y-3 text-sm">
            {history.paymentAttempts.map((attempt) => (
              <li key={attempt.id} className="break-words">
                <p className="font-medium">
                  Attempt {attempt.sequence} · {attempt.status} ·{" "}
                  {isCurrency(attempt.currency)
                    ? formatCharge(
                      attempt.expectedMinorAmount,
                      attempt.currency,
                    )
                    : "Unknown currency"}
                </p>
                <p className="text-xs break-all">
                  {attempt.livemode ? "Live mode" : "Test mode"} · account{" "}
                  {attempt.providerAccountId ?? "unknown"} · session{" "}
                  {attempt.sessionId ?? "not published"} · intent{" "}
                  {attempt.paymentIntentId ?? "not confirmed"}
                </p>
                {attempt.failureCode && <p>Outcome: {attempt.failureCode}</p>}
                {!!attempt.providerSnapshot && (
                  <details>
                    <summary className="cursor-pointer">
                      Canonical refund, dispute, and reference details
                    </summary>
                    <pre className="whitespace-pre-wrap break-all text-xs mt-2">{JSON.stringify(attempt.providerSnapshot, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
          <h3 className="section-label">
            Recorded events ({history.paymentEvents.length})
          </h3>
          {!history.paymentEvents.length && (
            <p className="text-sm">No recorded events.</p>
          )}
          <ul className="space-y-3 text-sm">
            {history.paymentEvents.map((event) => (
              <li key={event.id}>
                <details>
                  <summary className="cursor-pointer break-all">
                    {event.type} · {event.status} ·{" "}
                    {new Date(event.createdAt).toLocaleString()}
                  </summary>
                  <p className="text-xs break-all">
                    {event.source} · {event.providerEventId}
                  </p>
                  <pre className="whitespace-pre-wrap break-all text-xs mt-2">{JSON.stringify(event.data, null, 2)}</pre>
                  {event.outcome && (
                    <p className="text-xs break-all">
                      Outcome: {event.outcome}
                    </p>
                  )}
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
