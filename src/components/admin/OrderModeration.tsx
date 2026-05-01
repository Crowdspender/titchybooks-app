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
        <div className="max-w-6xl mx-auto px-4 py-8">
            <h1 className="text-2xl font-bold mb-6">Order Moderation</h1>

            <div className="mb-4 flex flex-wrap gap-2">
                {STATUS_FILTERS.map((status) => (
                    <button
                        key={status || "all"}
                        onClick={() => setFilter(status)}
                        className={`px-3 py-1 text-sm rounded-md ${
                            filter === status
                                ? "bg-blue-600 text-white"
                                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
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
                                className="h-16 bg-gray-100 rounded-lg animate-pulse"
                            />
                        ))}
                    </div>
                )
                : orders.length === 0
                ? (
                    <p className="text-gray-500 text-center py-12">
                        No orders found.
                    </p>
                )
                : (
                    <div className="border border-gray-200 rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="text-left px-4 py-2 font-medium">
                                        User
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Titchybook
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Qty
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Zone
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Total
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Status
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Created
                                    </th>
                                    <th className="text-right px-4 py-2 font-medium">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {orders.map((order) => {
                                    const isEditing = editingId === order.id;
                                    const allowedNext =
                                        ORDER_STATUS_TRANSITIONS[
                                            order.status
                                        ] ?? [];
                                    return (
                                        <tr
                                            key={order.id}
                                            className="align-top"
                                        >
                                            <td className="px-4 py-3">
                                                <div className="font-medium">
                                                    {order.user.name || "—"}
                                                </div>
                                                <div className="text-xs text-gray-500">
                                                    {order.user.email}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3">
                                                {order.submission?.title ||
                                                    "Titchybook"}
                                                <div className="text-xs text-gray-500">
                                                    {order.recipientName} ·{" "}
                                                    {order.countryCode}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3">
                                                {order.quantity}
                                            </td>
                                            <td className="px-4 py-3">
                                                {order.zone}
                                            </td>
                                            <td className="px-4 py-3 font-medium">
                                                {order.totalHuf.toLocaleString(
                                                    "en-US",
                                                )} HUF
                                            </td>
                                            <td className="px-4 py-3">
                                                {isEditing
                                                    ? (
                                                        <select
                                                            value={pendingStatus}
                                                            onChange={(event) =>
                                                                setPendingStatus(
                                                                    event.target
                                                                        .value as OrderStatus,
                                                                )}
                                                            className="rounded border border-stone-300 px-2 py-1 text-xs"
                                                        >
                                                            <option
                                                                value={order
                                                                    .status}
                                                            >
                                                                {order.status}
                                                                {" "}
                                                                (current)
                                                            </option>
                                                            {allowedNext.map((
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
                                                        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs">
                                                            {order.status
                                                                .replace(
                                                                    "_",
                                                                    " ",
                                                                )}
                                                        </span>
                                                    )}
                                            </td>
                                            <td className="px-4 py-3 text-gray-600 text-xs">
                                                {new Date(order.createdAt)
                                                    .toLocaleDateString()}
                                            </td>
                                            <td className="px-4 py-3 text-right">
                                                {isEditing
                                                    ? (
                                                        <div className="flex flex-col items-end gap-2">
                                                            <textarea
                                                                value={pendingNotes}
                                                                onChange={(
                                                                    event,
                                                                ) => setPendingNotes(
                                                                    event.target
                                                                        .value,
                                                                )}
                                                                placeholder="Internal notes"
                                                                className="w-48 rounded border border-stone-300 p-1 text-xs"
                                                                rows={2}
                                                            />
                                                            <div className="flex gap-2">
                                                                <button
                                                                    onClick={() =>
                                                                        saveEdit(
                                                                            order,
                                                                        )}
                                                                    className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                                                                >
                                                                    Save
                                                                </button>
                                                                <button
                                                                    onClick={() =>
                                                                        setEditingId(
                                                                            null,
                                                                        )}
                                                                    className="px-2 py-1 text-xs bg-stone-200 text-stone-700 rounded"
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
                                                            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
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
                )}
        </div>
    );
}
