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
        vaultFeeHuf?: number;
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
    const [vaultAddOn, setVaultAddOn] = useState(false);
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
                    vaultFeeHuf: data.vaultFeeHuf ??
                        DEFAULT_RESOLVED_CONFIG.vaultFeeHuf,
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
            return calculateOrder(zone, quantity, config, { vaultAddOn });
        } catch {
            return null;
        }
    }, [zone, quantity, config, vaultAddOn]);

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
                    vaultAddOn,
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
                            vaultFeeHuf: payload.meta.vaultFeeHuf ??
                                prev.vaultFeeHuf,
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
    }, [submission.id, zone, quantity, currency, vaultAddOn]);

    const breakdown = serverCalc ?? clientCalc;
    const messages = serverMessages.length ? serverMessages : clientMessages;
    const suggestion = serverSuggestion ?? clientSuggestion;

    const canPlaceOrder = submission.status === "APPROVED" &&
        submission.pdfReady &&
        !!breakdown &&
        !calcError;

    const placeOrderDisabledReason = submission.status !== "APPROVED"
        ? "Your Titchybooks must be approved before printing."
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
                    vaultAddOn,
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
        <section className="card p-6">
            <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                    <p className="section-label">
                        Print &amp; Ship
                    </p>
                    <h2
                        className="text-2xl font-semibold mt-1"
                        style={{ color: "var(--color-text)" }}
                    >
                        Order printed copies
                    </h2>
                    {submissionTitle && (
                        <p
                            className="text-sm mt-1"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            For:{" "}
                            <span className="font-medium">
                                {submissionTitle}
                            </span>
                        </p>
                    )}
                </div>
                {!standalone && (
                    <p
                        className="text-xs"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        Prices shown in your selected currency. Shipping rates
                        from Magyar Posta.
                    </p>
                )}
            </header>

            <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                {/* Controls */}
                <div className="space-y-5">
                    <div>
                        <label className="flex items-center justify-between">
                            <span className="label">Quantity</span>
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
                                className="input"
                                style={{
                                    width: "6rem",
                                    textAlign: "right",
                                    fontWeight: 600,
                                }}
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
                            style={{ accentColor: "var(--color-primary)" }}
                        />
                        <div className="mt-1 flex flex-wrap gap-1 text-xs">
                            {PRICE_BREAK_QUANTITIES.map((qty) => (
                                <button
                                    key={qty}
                                    type="button"
                                    onClick={() => setQuantity(qty)}
                                    className="rounded-full px-2 py-0.5 transition"
                                    style={{
                                        border: quantity === qty
                                            ? "1.5px solid var(--color-primary)"
                                            : "1px solid var(--color-border-strong)",
                                        background: quantity === qty
                                            ? "var(--color-primary-muted)"
                                            : "transparent",
                                        color: quantity === qty
                                            ? "var(--color-primary)"
                                            : "var(--color-text-muted)",
                                    }}
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
                                    className="rounded-full px-2 py-0.5"
                                    style={{
                                        border:
                                            "1px solid var(--color-success)",
                                        background:
                                            "var(--color-success-light)",
                                        color: "#065F46",
                                    }}
                                >
                                    Try {suggestion.suggestedQuantity}{" "}
                                    (-{suggestion.savingsPct}% / book)
                                </button>
                            )}
                        </div>
                    </div>

                    <div>
                        <label className="label">
                            Shipping destination
                        </label>
                        <select
                            value={zone}
                            onChange={(event) =>
                                setZone(event.target.value as Zone)}
                            className="input mt-1"
                        >
                            {config.enabledZones.map((z) => (
                                <option key={z} value={z}>
                                    {ZONE_LABELS[z]}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="label">
                            Display currency
                        </label>
                        <select
                            value={currency}
                            onChange={(event) => {
                                const next = event.target.value;
                                if (isCurrency(next)) setCurrency(next);
                            }}
                            className="input mt-1"
                        >
                            {SUPPORTED_CURRENCIES.map((c) => (
                                <option key={c} value={c}>
                                    {CURRENCY_LABELS[c]}
                                </option>
                            ))}
                        </select>
                        <p
                            className="mt-1 text-[11px]"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Amounts are calculated in HUF and converted using
                            reference exchange rates.
                        </p>
                    </div>

                    {/* Vault storage add-on */}
                    <label
                        className="flex items-start gap-3 rounded-xl p-4 cursor-pointer transition"
                        style={{
                            border: vaultAddOn
                                ? "1.5px solid var(--color-primary)"
                                : "1px solid var(--color-border)",
                            background: vaultAddOn
                                ? "var(--color-primary-muted)"
                                : "var(--color-surface)",
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={vaultAddOn}
                            onChange={(e) => setVaultAddOn(e.target.checked)}
                            className="mt-0.5"
                            style={{ accentColor: "var(--color-primary)" }}
                        />
                        <div>
                            <span
                                className="text-sm font-medium"
                                style={{ color: "var(--color-text)" }}
                            >
                                Add 2 copies to the Titchybook Vault
                            </span>
                            <p
                                className="mt-0.5 text-xs"
                                style={{ color: "var(--color-text-muted)" }}
                            >
                                Two printed copies will be stored indefinitely in
                                the Titchybook Vault, a long-term paper storage
                                service. Your book will be catalogued with its
                                title and author in the{" "}
                                <a
                                    href="/vault"
                                    className="underline"
                                    style={{ color: "var(--color-primary)" }}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    official directory
                                </a>.
                            </p>
                            {config.vaultFeeHuf > 0 && (
                                <p
                                    className="mt-1 text-xs font-medium"
                                    style={{ color: "var(--color-primary)" }}
                                >
                                    +{" "}
                                    {formatMoney(
                                        config.vaultFeeHuf,
                                        currency,
                                        config.currencyRates,
                                    )}{" "}
                                    flat fee
                                </p>
                            )}
                        </div>
                    </label>

                    {messages.length > 0 && (
                        <ul className="space-y-1">
                            {messages.map((msg, idx) => (
                                <li
                                    key={`${msg.level}-${idx}`}
                                    className="rounded-lg px-3 py-2 text-xs"
                                    style={{
                                        background: msg.level === "tip"
                                            ? "var(--color-success-light)"
                                            : msg.level === "warning"
                                            ? "var(--color-error-light)"
                                            : "var(--color-accent-light)",
                                        color: msg.level === "tip"
                                            ? "#065F46"
                                            : msg.level === "warning"
                                            ? "#991B1B"
                                            : "#92400E",
                                    }}
                                >
                                    {msg.text}
                                </li>
                            ))}
                        </ul>
                    )}

                    <button
                        type="button"
                        onClick={() => setShowAddress((s) => !s)}
                        className="text-sm font-medium transition"
                        style={{ color: "var(--color-secondary)" }}
                    >
                        {showAddress ? "Hide" : "Add"} shipping address
                    </button>

                    {showAddress && (
                        <div
                            className="grid gap-3 rounded-xl p-4 sm:grid-cols-2"
                            style={{
                                border: "1px solid var(--color-border)",
                                background: "var(--color-surface)",
                            }}
                        >
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
                <aside
                    className="rounded-xl p-5"
                    style={{
                        border: "1px solid var(--color-border)",
                        background: "var(--color-surface)",
                    }}
                >
                    <p className="section-label">
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
                                {breakdown.vaultFeeHuf > 0 && (
                                    <Row
                                        label="Vault storage (2 copies)"
                                        value={formatMoney(
                                            breakdown.vaultFeeHuf,
                                            currency,
                                            config.currencyRates,
                                        )}
                                    />
                                )}
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
                                <div
                                    className="my-2 h-px"
                                    style={{
                                        background:
                                            "var(--color-border-strong)",
                                    }}
                                />
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
                                <p
                                    className="text-xs"
                                    style={{ color: "var(--color-text-muted)" }}
                                >
                                    Shipment weight {breakdown.weightGrams}{" "}
                                    g · band {breakdown.shippingBand + 1} of
                                    {" "}
                                    {config.weightBands.length}
                                </p>
                            </dl>
                        )
                        : (
                            <p
                                className="mt-3 text-sm"
                                style={{ color: "var(--color-text-muted)" }}
                            >
                                {calcError ?? "Adjust quantity to see pricing."}
                            </p>
                        )}

                    {placeOrderDisabledReason && (
                        <p
                            className="mt-4 rounded-lg px-3 py-2 text-xs"
                            style={{
                                background: "var(--color-accent-light)",
                                color: "#92400E",
                            }}
                        >
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
                        className="btn btn-primary w-full mt-4"
                    >
                        {submitting
                            ? "Placing order..."
                            : calcLoading
                            ? "Calculating..."
                            : "Place order"}
                    </button>
                    <p
                        className="mt-2 text-[11px]"
                        style={{ color: "var(--color-text-muted)" }}
                    >
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
            <dt
                className={muted ? "text-xs" : "text-sm"}
                style={{
                    color: muted
                        ? "var(--color-text-muted)"
                        : "var(--color-text-muted)",
                }}
            >
                {label}
            </dt>
            <dd
                className={emphasis
                    ? "text-base font-semibold"
                    : muted
                    ? "text-xs"
                    : "text-sm"}
                style={{
                    color: emphasis
                        ? "var(--color-text)"
                        : muted
                        ? "var(--color-text-muted)"
                        : "var(--color-text)",
                }}
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
            <span style={{ color: "var(--color-text-muted)" }}>{label}</span>
            <input
                type="text"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="input mt-1"
                style={{ padding: "0.375rem 0.5rem", fontSize: "0.875rem" }}
            />
        </label>
    );
}
