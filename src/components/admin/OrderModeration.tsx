"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
    ORDER_STATUS_TRANSITIONS,
    ORDER_STATUSES,
    type OrderStatus,
} from "@/lib/pricing/constants";

interface AdminOrderRow {
    id: string;
    status: OrderStatus;
    quantity: number;
    zone: string;
    totalHuf: number;
    vaultAddOn: boolean;
    vaultFeeHuf: number;
    createdAt: string;
    notes: string | null;
    recipientName: string;
    countryCode: string;
    user: { id: string; email: string; name: string | null };
    submission: { id: string; title: string | null } | null;
}

const STATUS_FILTERS: Array<"" | OrderStatus> = ["", ...ORDER_STATUSES];

export default function OrderModeration() {
    const [orders, setOrders] = useState<AdminOrderRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<"" | OrderStatus>("");
    const [refreshKey, setRefreshKey] = useState(0);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [pendingStatus, setPendingStatus] = useState<OrderStatus | "">("");
    const [pendingNotes, setPendingNotes] = useState("");

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            const params = filter ? `?status=${filter}` : "";
            const res = await fetch(`/api/admin/orders${params}`);
            const data = await res.json();
            if (!cancelled) {
                setOrders(data.orders || []);
                setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [filter, refreshKey]);

    function startEdit(order: AdminOrderRow) {
        setEditingId(order.id);
        setPendingStatus(order.status);
        setPendingNotes(order.notes ?? "");
    }

    async function saveEdit(order: AdminOrderRow) {
        const body: Record<string, unknown> = {};
        if (pendingStatus && pendingStatus !== order.status) {
            body.status = pendingStatus;
        }
        if ((pendingNotes || "") !== (order.notes ?? "")) {
            body.notes = pendingNotes || null;
        }
        if (Object.keys(body).length === 0) {
            setEditingId(null);
            return;
        }
        const res = await fetch(`/api/admin/orders/${order.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (res.ok) {
            toast.success("Order updated");
            setEditingId(null);
            setRefreshKey((k) => k + 1);
        } else {
            const data = await res.json();
            toast.error(data.error || "Update failed");
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

            <div
                className="flex flex-wrap gap-2 mb-6 pb-6"
                style={{ borderBottom: "1px solid var(--color-border)" }}
            >
                {STATUS_FILTERS.map((status) => (
                    <button
                        key={status || "all"}
                        onClick={() => setFilter(status)}
                        className={`btn btn-sm ${
                            filter === status ? "btn-primary" : "btn-ghost"
                        }`}
                    >
                        {status || "All"}
                    </button>
                ))}
            </div>

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
                        <div className="overflow-x-auto">
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
                                            ORDER_STATUS_TRANSITIONS[
                                                order.status
                                            ] ?? [];
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
                                                    {isEditing
                                                        ? (
                                                            <select
                                                                value={pendingStatus}
                                                                onChange={(
                                                                    event,
                                                                ) => setPendingStatus(
                                                                    event.target
                                                                        .value as OrderStatus,
                                                                )}
                                                                className="input text-xs py-1 px-2 w-auto"
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
                                                </td>
                                                <td className="px-5 py-4 text-right">
                                                    {isEditing
                                                        ? (
                                                            <div className="flex flex-col items-end gap-2">
                                                                <textarea
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
                                                                        className="btn btn-success btn-sm text-xs"
                                                                    >
                                                                        Save
                                                                    </button>
                                                                    <button
                                                                        onClick={() =>
                                                                            setEditingId(
                                                                                null,
                                                                            )}
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
                                                                className="btn btn-primary btn-sm text-xs"
                                                            >
                                                                Update
                                                            </button>
                                                        )}
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
