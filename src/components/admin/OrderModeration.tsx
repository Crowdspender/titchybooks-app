"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { OrderPaymentState } from "@prisma/client";
import OrderPaymentHistory from "./OrderPaymentHistory";
import { paymentStateLabel } from "@/components/orders/PaymentStatus";
import { formatCharge, isCurrency } from "@/lib/pricing/currency";
import {
    ORDER_STATUS_TRANSITIONS,
    ORDER_STATUSES,
    type OrderStatus,
} from "@/lib/pricing/constants";

interface AdminOrderRow {
    id: string;
    status: OrderStatus;
    paymentState: OrderPaymentState | null;
    paymentHold: boolean;
    quantity: number;
    zone: string;
    totalHuf: number;
    currency: string;
    expectedMinorAmount: number | null;
    vaultAddOn: boolean;
    vaultFeeHuf: number;
    createdAt: string;
    updatedAt: string;
    manualSettlement: {
        source: string;
        operatorId: string;
        recordedAt: string;
        method: string;
        reference: string;
    } | null;
    notes: string | null;
    recipientName: string;
    countryCode: string;
    user: { id: string; email: string; name: string | null };
    submission: { id: string; title: string | null } | null;
}

const STATUS_FILTERS: Array<"" | OrderStatus> = ["", ...ORDER_STATUSES];

interface PaymentAlertRow {
    id: string;
    orderId: string | null;
    kind: string;
    message: string;
    occurrences: number;
    firstSeenAt: string;
    lastSeenAt: string;
}

interface PaymentEventRow {
    id: string;
    orderId: string | null;
    providerEventId: string;
    type: string;
    status: string;
    source: string;
    objectId: string | null;
    outcome: string | null;
    createdAt: string;
}

const ALERT_KIND_LABELS: Record<string, string> = {
    "stale-session": "Superseded session",
    "unpaid-completion": "Unpaid completion",
    "vault-entry-failed": "Settlement / Vault failure",
};

export default function OrderModeration() {
    const [orders, setOrders] = useState<AdminOrderRow[]>([]);
    const [alerts, setAlerts] = useState<PaymentAlertRow[]>([]);
    const [events, setEvents] = useState<PaymentEventRow[]>([]);
    const [eventCount, setEventCount] = useState(0);
    const [queueError, setQueueError] = useState("");
    const [loadError, setLoadError] = useState("");
    const [historyId, setHistoryId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<"" | OrderStatus>("");
    const [refreshKey, setRefreshKey] = useState(0);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [pendingStatus, setPendingStatus] = useState<OrderStatus | "">("");
    const [pendingNotes, setPendingNotes] = useState("");
    const [manualMethod, setManualMethod] = useState("BANK_TRANSFER");
    const [manualReference, setManualReference] = useState("");
    const [manualConfirmed, setManualConfirmed] = useState(false);
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const [editError, setEditError] = useState("");
    // The edit baseline is captured when editing starts and never follows queue
    // reloads: a refreshed row must not lend its newer revision to an old draft.
    const editBaseline = useRef<{
        id: string;
        status: OrderStatus;
        notes: string;
        updatedAt: string;
    } | null>(null);
    const [loadingOlder, setLoadingOlder] = useState(false);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            const params = filter ? `?status=${filter}` : "";
            try {
                const res = await fetch(`/api/admin/orders${params}`, {
                    cache: "no-store",
                });
                const data = await res.json();
                if (!res.ok) throw new Error("Orders unavailable");
                if (!cancelled) {
                    setOrders(data.orders || []);
                    setLoadError("");
                }
            } catch {
                if (!cancelled) {
                    setOrders([]);
                    setLoadError(
                        "Orders could not be loaded. Reload before taking any action.",
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [filter, refreshKey]);

    // Independent of the status filter: an operator editing a FULFILLED order
    // still has to see a reconciliation alert raised against a PENDING one.
    // Re-read on refreshKey because marking an order PAID can raise one.
    useEffect(() => {
        let cancelled = false;
        async function loadAlerts() {
            try {
                const res = await fetch("/api/admin/payment-alerts", {
                    cache: "no-store",
                });
                const data = await res.json();
                if (!res.ok) throw new Error("Queue unavailable");
                if (!cancelled) {
                    setAlerts(data.alerts || []);
                    setEvents(data.events || []);
                    setEventCount(data.eventCount ?? 0);
                    setQueueError("");
                }
            } catch {
                if (!cancelled) {
                    setQueueError(
                        "Payment reconciliation queue could not be loaded. Its absence is not proof that payments are clear.",
                    );
                }
            }
        }
        loadAlerts();
        return () => {
            cancelled = true;
        };
    }, [refreshKey]);

    function startEdit(order: AdminOrderRow) {
        editBaseline.current = {
            id: order.id,
            status: order.status,
            notes: order.notes ?? "",
            updatedAt: order.updatedAt,
        };
        setEditingId(order.id);
        setPendingStatus(order.status);
        setPendingNotes(order.notes ?? "");
        setManualMethod("BANK_TRANSFER");
        setManualReference("");
        setManualConfirmed(false);
        setEditError("");
    }

    function endEdit() {
        editBaseline.current = null;
        setEditingId(null);
    }

    async function saveEdit(order: AdminOrderRow) {
        if (savingRef.current) return;
        const baseline = editBaseline.current;
        if (!baseline || baseline.id !== order.id) return;
        if (order.updatedAt !== baseline.updatedAt) {
            setEditError(
                "This order changed since you started editing. Reload and review it before saving.",
            );
            return;
        }
        const manual = pendingStatus === "PAID" &&
            baseline.status === "PENDING_PAYMENT";
        if (manual && (!manualConfirmed || !manualReference.trim())) {
            setEditError(
                "Payment evidence and explicit confirmation are required.",
            );
            return;
        }
        const body: Record<string, unknown> = {};
        if (pendingStatus && pendingStatus !== baseline.status) {
            body.status = pendingStatus;
        }
        if ((pendingNotes || "") !== baseline.notes) {
            body.notes = pendingNotes || null;
        }
        if (Object.keys(body).length === 0) {
            endEdit();
            return;
        }
        body.expectedUpdatedAt = baseline.updatedAt;
        if (manual) {
            body.manualSettlement = {
                method: manualMethod,
                reference: manualReference.trim(),
                confirmed: true,
            };
        }
        savingRef.current = true;
        setSaving(true);
        setEditError("");
        try {
            const res = await fetch(`/api/admin/orders/${order.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Update failed");
            toast.success(
                manual
                    ? "Manual settlement recorded; this does not confirm a Stripe payment."
                    : "Order updated",
            );
            endEdit();
            setRefreshKey((k) => k + 1);
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : "Update could not be confirmed. Reload the order before retrying.";
            setEditError(message);
            toast.error(message);
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }

    async function dismissAlert(id: string) {
        try {
            const res = await fetch(`/api/admin/payment-alerts/${id}`, {
                method: "PATCH",
            });
            if (!res.ok) throw new Error("Could not dismiss the alert");
            setAlerts((current) => current.filter((alert) => alert.id !== id));
            // Cancel any in-flight queue snapshot and refetch: a GET captured
            // before this dismissal must not restore the dismissed alert.
            setRefreshKey((k) => k + 1);
            toast.success(
                "Historical alert dismissed. Financial holds are unchanged.",
            );
        } catch {
            toast.error(
                "Alert dismissal could not be confirmed. Reload the queue.",
            );
            setRefreshKey((k) => k + 1);
        }
    }

    async function loadOlderEvents() {
        const oldest = events.at(-1);
        if (!oldest?.createdAt || loadingOlder) return;
        setLoadingOlder(true);
        try {
            // The id breaks createdAt ties so a same-timestamp sibling at the
            // page boundary is not skipped.
            const res = await fetch(
                `/api/admin/payment-alerts?olderThan=${encodeURIComponent(oldest.createdAt)}&olderThanId=${encodeURIComponent(oldest.id)}`,
                { cache: "no-store" },
            );
            const data = await res.json();
            if (!res.ok) throw new Error("Queue unavailable");
            setEvents((current) => {
                const seen = new Set(current.map((event) => event.id));
                const older = (data.events || []).filter(
                    (event: PaymentEventRow) => !seen.has(event.id),
                );
                return [...current, ...older];
            });
            setEventCount(data.eventCount ?? eventCount);
        } catch {
            toast.error("Older events could not be loaded. Reload the queue.");
        } finally {
            setLoadingOlder(false);
        }
    }

    return (
        <div className="page-container py-10">
            <div className="mb-8">
                <p className="section-label mb-2">Administration</p>
                <h1
                    className="text-3xl font-semibold tracking-tight"
                    style={{ color: "var(--color-text)" }}
                >
                    Order Moderation
                </h1>
            </div>

            {(queueError || loadError) && (
                <div className="card p-4 mb-4">
                    {queueError && <p role="alert">{queueError}</p>}
                    {loadError && <p role="alert">{loadError}</p>}
                    <button
                        className="btn btn-ghost btn-sm mt-2"
                        disabled={saving}
                        onClick={() => setRefreshKey((k) => k + 1)}
                    >
                        Reload orders and payment queue
                    </button>
                </div>
            )}
            {historyId && (
                <OrderPaymentHistory
                    key={historyId}
                    orderId={historyId}
                    onClose={() => setHistoryId(null)}
                    onChanged={() =>
                        setRefreshKey((k) => k + 1)}
                />
            )}
            {events.length > 0 && (
                <section
                    className="card p-5 mb-6 space-y-3"
                    aria-label="Unresolved payment events"
                >
                    <h2 className="font-semibold">
                        Unresolved payment events ({eventCount})
                    </h2>
                    <p className="text-sm">
                        Showing {events.length} of {eventCount}{" "}
                        unresolved events, newest first. No event is silently
                        discarded. Unmatched references require operator
                        comparison with Stripe Dashboard; no order is inferred.
                    </p>
                    {events.length < eventCount && (
                        <button
                            className="btn btn-ghost btn-sm"
                            disabled={loadingOlder || !events.at(-1)?.createdAt}
                            onClick={loadOlderEvents}
                        >
                            {loadingOlder
                                ? "Loading older events…"
                                : "Show older events"}
                        </button>
                    )}
                    <ul className="space-y-3 text-sm">
                        {events.map((event) => (
                            <li key={event.id}>
                                <p className="font-medium break-all">
                                    {event.type} · {event.status}
                                </p>
                                <p className="text-xs break-all">
                                    {event.providerEventId} · object{" "}
                                    {event.objectId ?? "unknown"}
                                </p>
                                {event.outcome && (
                                    <details>
                                        <summary>Recorded outcome</summary>
                                        <p className="text-xs break-all">
                                            {event.outcome}
                                        </p>
                                    </details>
                                )}
                                {event.orderId
                                    ? (
                                        <button
                                            className="btn btn-ghost btn-sm mt-1"
                                            style={{
                                                whiteSpace: "normal",
                                                overflowWrap: "anywhere",
                                                maxWidth: "100%",
                                            }}
                                            disabled={saving ||
                                                historyId !== null}
                                            onClick={() => {
                                                // Keep any open draft: the edit
                                                // baseline fences stale saves.
                                                setHistoryId(event.orderId);
                                            }}
                                        >
                                            Review payment for order{" "}
                                            {event.orderId}
                                        </button>
                                    )
                                    : (
                                        <p className="text-xs">
                                            Unmatched — retained for manual
                                            provider review.
                                        </p>
                                    )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {alerts.length > 0 && (
                <div
                    className="card p-5 mb-6"
                    style={{
                        background: "var(--color-accent-light)",
                        border: "1px solid var(--color-accent)",
                    }}
                >
                    <h2
                        className="font-semibold mb-1"
                        style={{ color: "var(--color-text)" }}
                    >
                        Payment reconciliation
                    </h2>
                    <p
                        className="text-sm mb-4"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        {alerts.length}{" "}
                        {alerts.length === 1 ? "event needs" : "events need"}
                        {" "}
                        a decision. Review the recorded outcome before retrying
                        settlement or fulfillment. An alert is not proof of
                        payment. Dismissing a historical alert does not release
                        a financial hold.
                    </p>
                    <ul className="space-y-3">
                        {alerts.map((alert) => (
                            <li
                                key={alert.id}
                                className="flex items-start justify-between gap-4 text-sm"
                            >
                                <div className="min-w-0">
                                    <span
                                        className="badge text-[11px] mr-2"
                                        style={{
                                            background: "var(--color-accent)",
                                            color: "var(--color-text-inverse)",
                                        }}
                                    >
                                        {ALERT_KIND_LABELS[alert.kind] ??
                                            alert.kind}
                                    </span>
                                    <span
                                        style={{ color: "var(--color-text)" }}
                                    >
                                        {alert.message}
                                    </span>
                                    <div
                                        className="text-xs mt-1"
                                        style={{
                                            color: "var(--color-text-muted)",
                                        }}
                                    >
                                        Seen {new Date(alert.lastSeenAt)
                                            .toLocaleString()}
                                        {alert.occurrences > 1
                                            ? ` · ${alert.occurrences}× since ${
                                                new Date(alert.firstSeenAt)
                                                    .toLocaleDateString()
                                            }`
                                            : ""}
                                        {alert.orderId
                                            ? ` · order ${alert.orderId}`
                                            : ""}
                                    </div>
                                </div>
                                <button
                                    onClick={() => dismissAlert(alert.id)}
                                    className="btn btn-ghost btn-sm text-xs shrink-0"
                                >
                                    Dismiss
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div
                className="flex flex-wrap gap-2 mb-6 pb-6"
                style={{ borderBottom: "1px solid var(--color-border)" }}
            >
                {STATUS_FILTERS.map((status) => (
                    <button
                        key={status || "all"}
                        disabled={saving || historyId !== null}
                        onClick={() => setFilter(status)}
                        className={`btn btn-sm ${
                            filter === status ? "btn-primary" : "btn-ghost"
                        }`}
                    >
                        {status || "All"}
                    </button>
                ))}
            </div>

            {editError && (
                <div className="card p-4 mb-4">
                    <p role="alert">{editError}</p>
                    <button
                        className="btn btn-ghost btn-sm mt-2"
                        disabled={saving}
                        onClick={() => {
                            endEdit();
                            setEditError("");
                            setRefreshKey((k) => k + 1);
                        }}
                    >
                        Reload orders
                    </button>
                </div>
            )}
            {loading
                ? (
                    <div className="space-y-3">
                        {[1, 2, 3].map((i) => (
                            <div
                                key={i}
                                className="card p-5 animate-pulse"
                                style={{ background: "var(--color-border)" }}
                            >
                                <div
                                    className="h-4 w-40 rounded"
                                    style={{
                                        background:
                                            "var(--color-border-strong)",
                                    }}
                                />
                            </div>
                        ))}
                    </div>
                )
                : loadError
                ? null
                : orders.length === 0
                ? (
                    <div className="card p-12 text-center">
                        <div
                            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4"
                            style={{ background: "var(--color-primary-muted)" }}
                        >
                            <svg
                                width="32"
                                height="32"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="var(--color-primary)"
                                strokeWidth="1.5"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"
                                />
                            </svg>
                        </div>
                        <p
                            className="font-medium mb-1"
                            style={{ color: "var(--color-text)" }}
                        >
                            No orders yet
                        </p>
                        <p
                            className="text-sm"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Orders will appear here once users start placing
                            print orders.
                        </p>
                    </div>
                )
                : (
                    <div className="card overflow-hidden">
                        <div
                            className="overflow-x-auto"
                            role="region"
                            aria-label="Orders"
                            tabIndex={0}
                        >
                            <table className="w-full text-sm">
                                <thead>
                                    <tr
                                        style={{
                                            background: "var(--color-surface)",
                                            borderBottom:
                                                "1px solid var(--color-border)",
                                        }}
                                    >
                                        <th className="text-left px-5 py-3 section-label">
                                            User
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Titchybooks
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Qty
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Zone
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Total
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Vault
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Status
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Created
                                        </th>
                                        <th className="text-right px-5 py-3 section-label">
                                            Actions
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {orders.map((order) => {
                                        const isEditing =
                                            editingId === order.id;
                                        const allowedNext =
                                            (ORDER_STATUS_TRANSITIONS[
                                                order.status
                                            ] ?? [])
                                                .filter((next) =>
                                                    !order.paymentHold ||
                                                    !["PAID", "IN_PRODUCTION"]
                                                        .includes(next)
                                                );
                                        return (
                                            <tr
                                                key={order.id}
                                                className="align-top"
                                                style={{
                                                    borderBottom:
                                                        "1px solid var(--color-border)",
                                                }}
                                            >
                                                <td className="px-5 py-4">
                                                    <div
                                                        className="font-medium"
                                                        style={{
                                                            color:
                                                                "var(--color-text)",
                                                        }}
                                                    >
                                                        {order.user.name || "—"}
                                                    </div>
                                                    <div
                                                        className="text-xs"
                                                        style={{
                                                            color:
                                                                "var(--color-text-subtle)",
                                                        }}
                                                    >
                                                        {order.user.email}
                                                    </div>
                                                </td>
                                                <td
                                                    className="px-5 py-4"
                                                    style={{
                                                        color:
                                                            "var(--color-text)",
                                                    }}
                                                >
                                                    {order.submission?.title ||
                                                        "Titchybooks"}
                                                    <div
                                                        className="text-xs"
                                                        style={{
                                                            color:
                                                                "var(--color-text-subtle)",
                                                        }}
                                                    >
                                                        {order.recipientName} ·
                                                        {" "}
                                                        {order.countryCode}
                                                    </div>
                                                </td>
                                                <td className="px-5 py-4">
                                                    {order.quantity}
                                                </td>
                                                <td
                                                    className="px-5 py-4"
                                                    style={{
                                                        color:
                                                            "var(--color-text-muted)",
                                                    }}
                                                >
                                                    {order.zone}
                                                </td>
                                                <td className="px-5 py-4 font-medium">
                                                    {order.totalHuf
                                                        .toLocaleString(
                                                            "en-US",
                                                        )} HUF
                                                </td>
                                                <td className="px-5 py-4">
                                                    {order.vaultAddOn
                                                        ? (
                                                            <span
                                                                className="badge text-[11px]"
                                                                style={{
                                                                    background:
                                                                        "var(--color-primary-muted)",
                                                                    color:
                                                                        "var(--color-primary)",
                                                                }}
                                                            >
                                                                Vault
                                                            </span>
                                                        )
                                                        : (
                                                            <span
                                                                className="text-xs"
                                                                style={{
                                                                    color:
                                                                        "var(--color-text-subtle)",
                                                                }}
                                                            >
                                                                —
                                                            </span>
                                                        )}
                                                </td>
                                                <td className="px-5 py-4">
                                                    <p className="text-xs mb-2">
                                                        {paymentStateLabel(
                                                            order
                                                                .paymentState ??
                                                                null,
                                                        )}
                                                        {order.paymentHold
                                                            ? " · review hold"
                                                            : ""}
                                                    </p>
                                                    {isEditing
                                                        ? (
                                                            <select
                                                                aria-label="Order status"
                                                                disabled={saving}
                                                                value={pendingStatus}
                                                                onChange={(
                                                                    event,
                                                                ) => setPendingStatus(
                                                                    event.target
                                                                        .value as OrderStatus,
                                                                )}
                                                                className="input text-xs py-1 px-2 w-auto min-w-36"
                                                            >
                                                                <option
                                                                    value={order
                                                                        .status}
                                                                >
                                                                    {order
                                                                        .status}
                                                                    {" "}
                                                                    (current)
                                                                </option>
                                                                {allowedNext
                                                                    .map((
                                                                        next,
                                                                    ) => (
                                                                        <option
                                                                            key={next}
                                                                            value={next}
                                                                        >
                                                                            {next}
                                                                        </option>
                                                                    ))}
                                                            </select>
                                                        )
                                                        : (
                                                            <span className="badge badge-draft">
                                                                {order.status
                                                                    .replace(
                                                                        "_",
                                                                        " ",
                                                                    )}
                                                            </span>
                                                        )}
                                                </td>
                                                <td
                                                    className="px-5 py-4 text-xs"
                                                    style={{
                                                        color:
                                                            "var(--color-text-muted)",
                                                    }}
                                                >
                                                    {new Date(order.createdAt)
                                                        .toLocaleDateString()}
                                                    {order.manualSettlement
                                                                ?.source ===
                                                            "manual" && (
                                                        <details className="mt-2 text-left break-all">
                                                            <summary>
                                                                Manual
                                                                settlement
                                                                evidence
                                                            </summary>
                                                            <p>
                                                                Recorded by{" "}
                                                                {order
                                                                    .manualSettlement
                                                                    .operatorId}
                                                                {" "}
                                                                at{" "}
                                                                {new Date(
                                                                    order
                                                                        .manualSettlement
                                                                        .recordedAt,
                                                                ).toLocaleString()}
                                                            </p>
                                                            <p>
                                                                {order
                                                                    .manualSettlement
                                                                    .method}:
                                                                {" "}
                                                                {order
                                                                    .manualSettlement
                                                                    .reference}
                                                            </p>
                                                            <p>
                                                                Operator-verified;
                                                                not Stripe
                                                                confirmation.
                                                            </p>
                                                        </details>
                                                    )}
                                                </td>
                                                <td className="px-5 py-4 text-right">
                                                    {isEditing
                                                        ? (
                                                            <div className="flex w-64 flex-col items-end gap-2">
                                                                {pendingStatus ===
                                                                        "PAID" &&
                                                                    order
                                                                            .status ===
                                                                        "PENDING_PAYMENT" &&
                                                                    (
                                                                        <fieldset
                                                                            disabled={saving}
                                                                            className="w-64 text-left space-y-2"
                                                                        >
                                                                            <legend className="font-medium">
                                                                                Record
                                                                                manual
                                                                                settlement
                                                                            </legend>
                                                                            {isCurrency(order.currency) &&
                                                                                order.expectedMinorAmount !== null && (
                                                                                <p className="text-xs font-medium">
                                                                                    Accepted
                                                                                    charge:{" "}
                                                                                    {formatCharge(
                                                                                        order.expectedMinorAmount,
                                                                                        order.currency,
                                                                                    )}
                                                                                    {" "}
                                                                                    —
                                                                                    verify
                                                                                    the
                                                                                    evidence
                                                                                    against
                                                                                    this
                                                                                    amount.
                                                                                </p>
                                                                            )}
                                                                            <p className="text-xs">
                                                                                Verify
                                                                                payment
                                                                                evidence
                                                                                before
                                                                                confirming.
                                                                                This
                                                                                records
                                                                                your
                                                                                manual
                                                                                decision,
                                                                                not
                                                                                a
                                                                                Stripe
                                                                                payment.
                                                                                Do
                                                                                not
                                                                                include
                                                                                card
                                                                                or
                                                                                bank
                                                                                account
                                                                                details.
                                                                            </p>
                                                                            <label className="block">
                                                                                Payment
                                                                                method
                                                                                <select
                                                                                    className="input text-xs"
                                                                                    value={manualMethod}
                                                                                    onChange={(event) => {
                                                                                        setManualMethod(
                                                                                            event
                                                                                                .target
                                                                                                .value,
                                                                                        );
                                                                                        setManualConfirmed(
                                                                                            false,
                                                                                        );
                                                                                    }}
                                                                                >
                                                                                    <option value="BANK_TRANSFER">
                                                                                        Bank
                                                                                        transfer
                                                                                    </option>
                                                                                    <option value="CASH">
                                                                                        Cash
                                                                                    </option>
                                                                                    <option value="OTHER">
                                                                                        Other
                                                                                    </option>
                                                                                </select>
                                                                            </label>
                                                                            <label className="block">
                                                                                Payment
                                                                                evidence
                                                                                /
                                                                                reference
                                                                                <textarea
                                                                                    className="input text-xs"
                                                                                    rows={2}
                                                                                    maxLength={500}
                                                                                    value={manualReference}
                                                                                    onChange={(event) => {
                                                                                        setManualReference(
                                                                                            event
                                                                                                .target
                                                                                                .value,
                                                                                        );
                                                                                        setManualConfirmed(
                                                                                            false,
                                                                                        );
                                                                                    }}
                                                                                />
                                                                            </label>
                                                                            <label className="flex items-start gap-2">
                                                                                <input
                                                                                    type="checkbox"
                                                                                    checked={manualConfirmed}
                                                                                    onChange={(event) =>
                                                                                        setManualConfirmed(
                                                                                            event
                                                                                                .target
                                                                                                .checked,
                                                                                        )}
                                                                                />
                                                                                I
                                                                                verified
                                                                                this
                                                                                manual
                                                                                payment
                                                                                and
                                                                                confirm
                                                                                settlement.
                                                                            </label>
                                                                        </fieldset>
                                                                    )}
                                                                <textarea
                                                                    aria-label="Internal notes"
                                                                    disabled={saving}
                                                                    maxLength={2000}
                                                                    value={pendingNotes}
                                                                    onChange={(
                                                                        event,
                                                                    ) => setPendingNotes(
                                                                        event
                                                                            .target
                                                                            .value,
                                                                    )}
                                                                    placeholder="Internal notes"
                                                                    className="input text-xs p-1.5 w-48"
                                                                    rows={2}
                                                                />
                                                                <div className="flex gap-2">
                                                                    <button
                                                                        onClick={() =>
                                                                            saveEdit(
                                                                                order,
                                                                            )}
                                                                        disabled={saving ||
                                                                            (pendingStatus ===
                                                                                    "PAID" &&
                                                                                order
                                                                                        .status ===
                                                                                    "PENDING_PAYMENT" &&
                                                                                (!manualConfirmed ||
                                                                                    !manualReference
                                                                                        .trim()))}
                                                                        className="btn btn-success btn-sm text-xs"
                                                                    >
                                                                        {saving
                                                                            ? "Saving…"
                                                                            : "Save"}
                                                                    </button>
                                                                    <button
                                                                        onClick={endEdit}
                                                                        disabled={saving}
                                                                        className="btn btn-ghost btn-sm text-xs"
                                                                    >
                                                                        Cancel
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )
                                                        : (
                                                            <button
                                                                onClick={() =>
                                                                    startEdit(
                                                                        order,
                                                                    )}
                                                                disabled={saving ||
                                                                    historyId !==
                                                                        null}
                                                                className="btn btn-primary btn-sm text-xs"
                                                            >
                                                                Update
                                                            </button>
                                                        )}
                                                    <button
                                                        className="btn btn-ghost btn-sm text-xs mt-2"
                                                        disabled={saving ||
                                                            historyId !== null}
                                                        onClick={() => {
                                                            // Preserve the draft;
                                                            // closing history returns
                                                            // to the same edit.
                                                            setHistoryId(
                                                                order.id,
                                                            );
                                                        }}
                                                    >
                                                        Payment history
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
        </div>
    );
}
