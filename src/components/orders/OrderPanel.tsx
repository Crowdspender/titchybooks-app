"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    DEFAULT_RESOLVED_CONFIG,
    PRICE_BREAK_QUANTITIES,
    type ResolvedPricingConfig,
    type Zone,
    ZONE_LABELS,
} from "@/lib/pricing/constants";
import {
    buildUxMessages,
    type CalculatedOrder,
    calculateOrder,
    type OptimalSuggestion,
    suggestOptimalQuantity,
    type UxMessage,
} from "@/lib/pricing/engine";
import {
    type Currency,
    CURRENCY_LABELS,
    DEFAULT_CURRENCY,
    formatMoney,
    isCurrency,
    SUPPORTED_CURRENCIES,
} from "@/lib/pricing/currency";

const ZONE_STORAGE_KEY = "titchybook-last-zone";
const CURRENCY_STORAGE_KEY = "titchybook-last-currency";
const QUANTITY_MIN = 1;
const QUANTITY_MAX = 333;
const DEBOUNCE_MS = 250;

interface OrderPanelSubmission {
    id: string;
    status: string;
    pdfReady: boolean;
}

interface OrderPanelProps {
    submission: OrderPanelSubmission;
    /** Optional title for display only. */
    submissionTitle?: string | null;
    /** When true, hide the "back to editor" affordance (used on standalone pages). */
    standalone?: boolean;
}

interface ServerCalcResponse {
    order: CalculatedOrder;
    suggestion: OptimalSuggestion | null;
    messages: UxMessage[];
    meta: {
        enabledZones: Zone[];
        priceTiers: ResolvedPricingConfig["priceTiers"];
        weightBands: number[];
        weightPerBookGrams: number;
        currencyRates?: ResolvedPricingConfig["currencyRates"];
        pricingConfigVersion: number;
    };
}

interface AddressForm {
    recipientName: string;
    line1: string;
    line2: string;
    city: string;
    postalCode: string;
    countryCode: string;
    phone: string;
}

const EMPTY_ADDRESS: AddressForm = {
    recipientName: "",
    line1: "",
    line2: "",
    city: "",
    postalCode: "",
    countryCode: "HU",
    phone: "",
};

export default function OrderPanel({
    submission,
    submissionTitle,
    standalone,
}: OrderPanelProps) {
    const router = useRouter();
    const [quantity, setQuantity] = useState(40);
    const [zone, setZone] = useState<Zone>("hungary");
    const [currency, setCurrency] = useState<Currency>(DEFAULT_CURRENCY);
    const [config, setConfig] = useState<ResolvedPricingConfig>(
        DEFAULT_RESOLVED_CONFIG,
    );
    const [serverCalc, setServerCalc] = useState<CalculatedOrder | null>(null);
    const [serverMessages, setServerMessages] = useState<UxMessage[]>([]);
    const [serverSuggestion, setServerSuggestion] = useState<
        OptimalSuggestion | null
    >(null);
    const [calcLoading, setCalcLoading] = useState(false);
    const [calcError, setCalcError] = useState<string | null>(null);
    const [showAddress, setShowAddress] = useState(false);
    const [address, setAddress] = useState<AddressForm>(EMPTY_ADDRESS);
    const [submitting, setSubmitting] = useState(false);

    const debounceTimer = useRef<number | null>(null);
    const requestId = useRef(0);

    // Load public pricing meta + last-used zone once.
    useEffect(() => {
        if (typeof window !== "undefined") {
            const storedZone = window.localStorage.getItem(ZONE_STORAGE_KEY);
            if (storedZone) {
                setZone(storedZone as Zone);
            }
            const storedCurrency = window.localStorage.getItem(
                CURRENCY_STORAGE_KEY,
            );
            if (isCurrency(storedCurrency)) {
                setCurrency(storedCurrency);
            }
        }

        let cancelled = false;
        (async () => {
            try {
                const res = await fetch("/api/pricing/public");
                if (!res.ok) return;
                const data = await res.json();
                if (cancelled) return;
                const next: ResolvedPricingConfig = {
                    version: data.pricingConfigVersion ?? 0,
                    weightPerBookGrams: data.weightPerBookGrams,
                    handlingFixedHuf: data.handlingFixedHuf,
                    handlingPercent: data.handlingPercent,
                    enabledZones: data.enabledZones,
                    weightBands: data.weightBands,
                    shippingTable: data.shippingTable,
                    priceTiers: data.priceTiers,
                    currencyRates: data.currencyRates ??
                        DEFAULT_RESOLVED_CONFIG.currencyRates,
                };
                setConfig(next);
                if (
                    next.enabledZones.length &&
                    !next.enabledZones.includes(zone)
                ) {
                    setZone(next.enabledZones[0]);
                }
            } catch {
                // fall back to defaults silently
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Persist last-used zone.
    useEffect(() => {
        if (typeof window !== "undefined") {
            window.localStorage.setItem(ZONE_STORAGE_KEY, zone);
        }
    }, [zone]);

    // Persist last-used currency.
    useEffect(() => {
        if (typeof window !== "undefined") {
            window.localStorage.setItem(CURRENCY_STORAGE_KEY, currency);
        }
    }, [currency]);

    // Instant client-side mirror so the UI never feels laggy.
    const clientCalc = useMemo(() => {
        try {
            return calculateOrder(zone, quantity, config);
        } catch {
            return null;
        }
    }, [zone, quantity, config]);

    const clientMessages = useMemo(() => {
        try {
            return buildUxMessages(zone, quantity, config);
        } catch {
            return [];
        }
    }, [zone, quantity, config]);

    const clientSuggestion = useMemo(
        () => suggestOptimalQuantity(zone, quantity, config),
        [zone, quantity, config],
    );

    // Reconcile with the server (authoritative).
    useEffect(() => {
        if (debounceTimer.current) {
            window.clearTimeout(debounceTimer.current);
        }

        debounceTimer.current = window.setTimeout(() => {
            const myId = ++requestId.current;
            setCalcLoading(true);
            setCalcError(null);

            fetch("/api/orders/calculate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    submissionId: submission.id,
                    zone,
                    quantity,
                    currency,
                }),
            })
                .then(async (res) => {
                    const data = await res.json();
                    if (myId !== requestId.current) return;
                    if (!res.ok) {
                        setCalcError(data.error || "Could not calculate order");
                        setServerCalc(null);
                        setServerMessages([]);
                        setServerSuggestion(null);
                        return;
                    }
                    const payload = data as ServerCalcResponse;
                    setServerCalc(payload.order);
                    setServerMessages(payload.messages);
                    setServerSuggestion(payload.suggestion);
                    if (payload.meta) {
                        setConfig((prev) => ({
                            ...prev,
                            version: payload.meta.pricingConfigVersion,
                            priceTiers: payload.meta.priceTiers,
                            weightBands: payload.meta.weightBands,
                            weightPerBookGrams: payload.meta.weightPerBookGrams,
                            enabledZones: payload.meta.enabledZones,
                            currencyRates: payload.meta.currencyRates ??
                                prev.currencyRates,
                        }));
                    }
                })
                .catch(() => {
                    if (myId !== requestId.current) return;
                    setCalcError("Network error while calculating order");
                })
                .finally(() => {
                    if (myId === requestId.current) setCalcLoading(false);
                });
        }, DEBOUNCE_MS);

        return () => {
            if (debounceTimer.current) {
                window.clearTimeout(debounceTimer.current);
            }
        };
    }, [submission.id, zone, quantity, currency]);

    const breakdown = serverCalc ?? clientCalc;
    const messages = serverMessages.length ? serverMessages : clientMessages;
    const suggestion = serverSuggestion ?? clientSuggestion;

    const canPlaceOrder = submission.status === "APPROVED" &&
        submission.pdfReady &&
        !!breakdown &&
        !calcError;

    const placeOrderDisabledReason = submission.status !== "APPROVED"
        ? "Your Titchybook must be approved before printing."
        : !submission.pdfReady
        ? "Print-ready PDF is still being generated. Please try again shortly."
        : null;

    function isAddressValid(addr: AddressForm): boolean {
        return (
            addr.recipientName.trim().length > 0 &&
            addr.line1.trim().length > 0 &&
            addr.city.trim().length > 0 &&
            addr.postalCode.trim().length > 0 &&
            addr.countryCode.trim().length === 2
        );
    }

    async function handlePlaceOrder() {
        if (!canPlaceOrder || !breakdown) return;
        if (!isAddressValid(address)) {
            setShowAddress(true);
            toast.error("Please complete the shipping address.");
            return;
        }

        setSubmitting(true);
        try {
            const res = await fetch("/api/orders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    submissionId: submission.id,
                    zone,
                    quantity,
                    currency,
                    shippingAddress: {
                        recipientName: address.recipientName.trim(),
                        line1: address.line1.trim(),
                        line2: address.line2.trim() || undefined,
                        city: address.city.trim(),
                        postalCode: address.postalCode.trim(),
                        countryCode: address.countryCode.trim().toUpperCase(),
                        phone: address.phone.trim() || undefined,
                    },
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || "Could not place order");
            }
            toast.success("Order placed. Awaiting payment.");
            router.push(`/dashboard/orders/${data.order.id}`);
            router.refresh();
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : "Order failed",
            );
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <section className="rounded-[28px] border border-stone-300 bg-white/95 p-6 shadow-sm">
            <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                        Print &amp; Ship
                    </p>
                    <h2 className="text-2xl font-semibold text-stone-900">
                        Order printed copies
                    </h2>
                    {submissionTitle && (
                        <p className="text-sm text-stone-500">
                            For:{" "}
                            <span className="font-medium">
                                {submissionTitle}
                            </span>
                        </p>
                    )}
                </div>
                {!standalone && (
                    <p className="text-xs text-stone-500">
                        Prices shown in your selected currency. Shipping rates
                        from Magyar Posta.
                    </p>
                )}
            </header>

            <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                {/* Controls */}
                <div className="space-y-5">
                    <div>
                        <label className="flex items-center justify-between text-sm font-medium text-stone-700">
                            <span>Quantity</span>
                            <input
                                type="number"
                                min={QUANTITY_MIN}
                                max={QUANTITY_MAX}
                                value={quantity}
                                onChange={(event) => {
                                    const v = Number(event.target.value);
                                    if (Number.isFinite(v)) {
                                        setQuantity(
                                            Math.max(
                                                QUANTITY_MIN,
                                                Math.min(
                                                    QUANTITY_MAX,
                                                    Math.round(v),
                                                ),
                                            ),
                                        );
                                    }
                                }}
                                className="w-24 rounded-md border border-stone-300 px-2 py-1 text-right text-base font-semibold"
                            />
                        </label>
                        <input
                            type="range"
                            min={QUANTITY_MIN}
                            max={QUANTITY_MAX}
                            value={quantity}
                            onChange={(event) =>
                                setQuantity(Number(event.target.value))}
                            className="mt-2 w-full"
                        />
                        <div className="mt-1 flex flex-wrap gap-1 text-xs">
                            {PRICE_BREAK_QUANTITIES.map((qty) => (
                                <button
                                    key={qty}
                                    type="button"
                                    onClick={() => setQuantity(qty)}
                                    className={`rounded-full border px-2 py-0.5 transition ${
                                        quantity === qty
                                            ? "border-blue-500 bg-blue-50 text-blue-700"
                                            : "border-stone-300 text-stone-600 hover:bg-stone-50"
                                    }`}
                                    title={`Sweet spot: ${qty} copies`}
                                >
                                    {qty}
                                </button>
                            ))}
                            {suggestion &&
                                suggestion.suggestedQuantity !== quantity && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        setQuantity(
                                            suggestion.suggestedQuantity,
                                        )}
                                    className="rounded-full border border-emerald-400 bg-emerald-50 px-2 py-0.5 text-emerald-700 hover:bg-emerald-100"
                                >
                                    Try {suggestion.suggestedQuantity}{" "}
                                    (-{suggestion.savingsPct}% / book)
                                </button>
                            )}
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-stone-700">
                            Shipping destination
                        </label>
                        <select
                            value={zone}
                            onChange={(event) =>
                                setZone(event.target.value as Zone)}
                            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
                        >
                            {config.enabledZones.map((z) => (
                                <option key={z} value={z}>
                                    {ZONE_LABELS[z]}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-stone-700">
                            Display currency
                        </label>
                        <select
                            value={currency}
                            onChange={(event) => {
                                const next = event.target.value;
                                if (isCurrency(next)) setCurrency(next);
                            }}
                            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
                        >
                            {SUPPORTED_CURRENCIES.map((c) => (
                                <option key={c} value={c}>
                                    {CURRENCY_LABELS[c]}
                                </option>
                            ))}
                        </select>
                        <p className="mt-1 text-[11px] text-stone-500">
                            Amounts are calculated in HUF and converted using
                            reference exchange rates.
                        </p>
                    </div>

                    {messages.length > 0 && (
                        <ul className="space-y-1">
                            {messages.map((msg, idx) => (
                                <li
                                    key={`${msg.level}-${idx}`}
                                    className={`rounded-md px-3 py-2 text-xs ${
                                        msg.level === "tip"
                                            ? "bg-emerald-50 text-emerald-800"
                                            : msg.level === "warning"
                                            ? "bg-rose-50 text-rose-800"
                                            : "bg-amber-50 text-amber-800"
                                    }`}
                                >
                                    {msg.text}
                                </li>
                            ))}
                        </ul>
                    )}

                    <button
                        type="button"
                        onClick={() => setShowAddress((s) => !s)}
                        className="text-sm font-medium text-blue-600 hover:underline"
                    >
                        {showAddress ? "Hide" : "Add"} shipping address
                    </button>

                    {showAddress && (
                        <div className="grid gap-3 rounded-2xl border border-stone-200 bg-stone-50 p-4 sm:grid-cols-2">
                            <AddressInput
                                label="Recipient name"
                                value={address.recipientName}
                                onChange={(v) =>
                                    setAddress({
                                        ...address,
                                        recipientName: v,
                                    })}
                                full
                            />
                            <AddressInput
                                label="Address line 1"
                                value={address.line1}
                                onChange={(v) =>
                                    setAddress({ ...address, line1: v })}
                                full
                            />
                            <AddressInput
                                label="Address line 2 (optional)"
                                value={address.line2}
                                onChange={(v) =>
                                    setAddress({ ...address, line2: v })}
                                full
                            />
                            <AddressInput
                                label="City"
                                value={address.city}
                                onChange={(v) =>
                                    setAddress({ ...address, city: v })}
                            />
                            <AddressInput
                                label="Postal code"
                                value={address.postalCode}
                                onChange={(v) =>
                                    setAddress({ ...address, postalCode: v })}
                            />
                            <AddressInput
                                label="Country code (ISO)"
                                value={address.countryCode}
                                onChange={(v) =>
                                    setAddress({
                                        ...address,
                                        countryCode: v.toUpperCase().slice(
                                            0,
                                            2,
                                        ),
                                    })}
                            />
                            <AddressInput
                                label="Phone (optional)"
                                value={address.phone}
                                onChange={(v) =>
                                    setAddress({ ...address, phone: v })}
                            />
                        </div>
                    )}
                </div>

                {/* Breakdown */}
                <aside className="rounded-2xl border border-stone-200 bg-stone-50 p-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
                        Estimate
                    </p>
                    {breakdown
                        ? (
                            <dl className="mt-3 space-y-2 text-sm">
                                <Row
                                    label="Price per copy"
                                    value={formatMoney(
                                        breakdown.unitPriceHuf,
                                        currency,
                                        config.currencyRates,
                                    )}
                                />
                                <Row
                                    label="Print cost"
                                    value={formatMoney(
                                        breakdown.printCostHuf,
                                        currency,
                                        config.currencyRates,
                                    )}
                                />
                                {breakdown.handlingCostHuf > 0 && (
                                    <Row
                                        label="Handling"
                                        value={formatMoney(
                                            breakdown.handlingCostHuf,
                                            currency,
                                            config.currencyRates,
                                        )}
                                    />
                                )}
                                <Row
                                    label="Shipping"
                                    value={formatMoney(
                                        breakdown.shippingCostHuf,
                                        currency,
                                        config.currencyRates,
                                    )}
                                />
                                {breakdown.discountHuf > 0 && (
                                    <Row
                                        label="Discount"
                                        value={`-${
                                            formatMoney(
                                                breakdown.discountHuf,
                                                currency,
                                                config.currencyRates,
                                            )
                                        }`}
                                    />
                                )}
                                <div className="my-2 h-px bg-stone-300" />
                                <Row
                                    label="Total"
                                    value={formatMoney(
                                        breakdown.totalHuf,
                                        currency,
                                        config.currencyRates,
                                    )}
                                    emphasis
                                />
                                <Row
                                    label="Cost per book"
                                    value={formatMoney(
                                        breakdown.costPerBookHuf,
                                        currency,
                                        config.currencyRates,
                                    )}
                                    muted
                                />
                                <p className="text-xs text-stone-500">
                                    Shipment weight {breakdown.weightGrams}{" "}
                                    g · band {breakdown.shippingBand + 1} of
                                    {" "}
                                    {config.weightBands.length}
                                </p>
                            </dl>
                        )
                        : (
                            <p className="mt-3 text-sm text-stone-500">
                                {calcError ?? "Adjust quantity to see pricing."}
                            </p>
                        )}

                    {placeOrderDisabledReason && (
                        <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            {placeOrderDisabledReason}{" "}
                            {!standalone && (
                                <Link href="/dashboard" className="underline">
                                    See dashboard
                                </Link>
                            )}
                        </p>
                    )}

                    <button
                        type="button"
                        onClick={handlePlaceOrder}
                        disabled={!canPlaceOrder || submitting}
                        className="mt-4 w-full rounded-full bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {submitting
                            ? "Placing order..."
                            : calcLoading
                            ? "Calculating..."
                            : "Place order"}
                    </button>
                    <p className="mt-2 text-[11px] text-stone-500">
                        No charge yet. You will be invoiced once the order is
                        reviewed.
                    </p>
                </aside>
            </div>
        </section>
    );
}

function Row({
    label,
    value,
    emphasis,
    muted,
}: {
    label: string;
    value: string;
    emphasis?: boolean;
    muted?: boolean;
}) {
    return (
        <div className="flex items-center justify-between">
            <dt className={muted ? "text-xs text-stone-500" : "text-stone-600"}>
                {label}
            </dt>
            <dd
                className={emphasis
                    ? "text-base font-semibold text-stone-900"
                    : muted
                    ? "text-xs text-stone-500"
                    : "text-stone-800"}
            >
                {value}
            </dd>
        </div>
    );
}

function AddressInput({
    label,
    value,
    onChange,
    full,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    full?: boolean;
}) {
    return (
        <label className={`block text-xs ${full ? "sm:col-span-2" : ""}`}>
            <span className="text-stone-600">{label}</span>
            <input
                type="text"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
            />
        </label>
    );
}
