"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    DEFAULT_RESOLVED_CONFIG,
    MAX_ORDER_QUANTITY,
    PRICE_BREAK_QUANTITIES,
    type ResolvedPricingConfig,
    type Zone,
    ZONE_LABELS,
} from "@/lib/pricing/constants";
import {
    type CalculatedOrder,
    type OptimalSuggestion,
    type UxMessage,
} from "@/lib/pricing/engine";
import {
    type Currency,
    CURRENCY_LABELS,
    DEFAULT_CURRENCY,
    formatCharge,
    formatMoney,
    isCurrency,
    SUPPORTED_CURRENCIES,
} from "@/lib/pricing/currency";
import { contactHref } from "@/lib/contact";
import {
    calculateOrderInputSchema,
    createOrderInputSchema,
    type QuoteInputs,
} from "@/lib/pricing/schema";

const CURRENCY_STORAGE_KEY = "titchybook-last-currency";
const QUANTITY_MIN = 1;
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
    offer: {
        token: string;
        inputs: QuoteInputs;
        expiresAt: number;
        charge: {
            currency: Currency;
            amountMinor: number;
            fxRate: string;
            rounding: string;
        };
        terms: { version: string; text: string };
        service: string;
    };
    meta: {
        enabledZones: Zone[];
        priceTiers: ResolvedPricingConfig["priceTiers"];
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
    const [requestedQuantity, setRequestedQuantity] = useState(40);
    const [zone, setZone] = useState<Zone>("hungary");
    const [currency, setCurrency] = useState<Currency>(DEFAULT_CURRENCY);
    const [config, setConfig] = useState<ResolvedPricingConfig>(
        DEFAULT_RESOLVED_CONFIG,
    );
    const [serverCalc, setServerCalc] = useState<CalculatedOrder | null>(null);
    const [quote, setQuote] = useState<
        { key: string; offer: ServerCalcResponse["offer"] } | null
    >(null);
    const [acceptedToken, setAcceptedToken] = useState<string | null>(null);
    const [clock, setClock] = useState(() => Date.now());
    const [quoteRevision, setQuoteRevision] = useState(0);
    const [uncertain, setUncertain] = useState(false);
    const [pendingReady, setPendingReady] = useState(false);
    const pendingRequest = useRef<Record<string, unknown> | null>(null);
    const submitLock = useRef(false);
    const pendingStorageKey = `titchybooks-pending-order:${submission.id}`;
    const [serverMessages, setServerMessages] = useState<UxMessage[]>([]);
    const [serverSuggestion, setServerSuggestion] = useState<
        OptimalSuggestion | null
    >(null);
    const [calcLoading, setCalcLoading] = useState(false);
    const [calcError, setCalcError] = useState<string | null>(null);
    const [vaultAddOn, setVaultAddOn] = useState(false);
    const [showAddress, setShowAddress] = useState(true);
    const [address, setAddress] = useState<AddressForm>(EMPTY_ADDRESS);
    const [submitting, setSubmitting] = useState(false);

    const debounceTimer = useRef<number | null>(null);
    const requestId = useRef(0);

    // Load public pricing meta + last-used zone once.
    useEffect(() => {
        // Read stored preferences synchronously: the persist effects below
        // run later in this same commit and would otherwise clobber the
        // stored values with defaults before they are read. The setState
        // itself is deferred off the effect's synchronous path (a microtask)
        // so it does not cause a cascading render wave.
        try {
            const storedCurrency = window.localStorage.getItem(
                CURRENCY_STORAGE_KEY,
            );
            queueMicrotask(() => {
                if (isCurrency(storedCurrency)) setCurrency(storedCurrency);
            });
        } catch {
            /* Optional preference; it must not prevent pending-request recovery. */
        }
        try {
            const storedRequest = window.sessionStorage.getItem(
                pendingStorageKey,
            );
            if (storedRequest) {
                const parsed = createOrderInputSchema.safeParse(
                    JSON.parse(storedRequest),
                );
                if (
                    !parsed.success ||
                    parsed.data.submissionId !== submission.id
                ) {
                    throw new Error();
                }
                queueMicrotask(() => {
                    pendingRequest.current = parsed.data;
                    setPendingReady(true);
                    setUncertain(true);
                });
            }
        } catch {
            queueMicrotask(() => {
                toast.error(
                    "Order-request storage is unavailable or unreadable. Check your orders before ordering again.",
                );
                setUncertain(true);
            });
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

    // Persist last-used currency.
    useEffect(() => {
        if (typeof window !== "undefined") {
            try {
                window.localStorage.setItem(CURRENCY_STORAGE_KEY, currency);
            } catch { /* Optional preference. */ }
        }
    }, [currency]);

    const quantityCap = MAX_ORDER_QUANTITY;
    // Never silently reduce the requested run to fit a guessed carrier.
    const quantity = requestedQuantity;

    // Anything checkout cannot price — a heavier run or an unlisted country —
    // is routed to support for a manual quote instead of silently capped.
    const clampedForCarrier = requestedQuantity > quantityCap;

    const parsedInputs = calculateOrderInputSchema.safeParse({
        submissionId: submission.id,
        quantity,
        currency,
        vaultAddOn,
        shippingAddress: address,
    });
    const inputKey = parsedInputs.success
        ? JSON.stringify(parsedInputs.data)
        : null;
    const currentOffer =
        quote && quote.key === inputKey && quote.offer.expiresAt > clock
            ? quote.offer
            : null;
    const quoteHref = contactHref({
        topic: clampedForCarrier ? "oversize_order" : "unlisted_region",
        zone: currentOffer ? serverCalc?.zone : undefined,
        quantity: requestedQuantity,
        weightGrams: currentOffer ? serverCalc?.weightGrams : undefined,
        reference: submission.id,
    });
    useEffect(() => {
        const timer = window.setInterval(() => setClock(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    // Reconcile with the server (authoritative).
    useEffect(() => {
        if (debounceTimer.current) {
            window.clearTimeout(debounceTimer.current);
        }

        const myId = ++requestId.current;
        const controller = new AbortController();
        queueMicrotask(() => {
            if (controller.signal.aborted) return;
            setQuote(null);
            setAcceptedToken(null);
            setCalcError(null);
            setCalcLoading(false);
        });
        if (!inputKey || uncertain) {
            return () => {
                controller.abort();
            };
        }
        debounceTimer.current = window.setTimeout(() => {
            setCalcLoading(true);
            setCalcError(null);

            fetch("/api/orders/calculate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: inputKey,
                signal: controller.signal,
            })
                .then(async (res) => {
                    const data = await res.json();
                    if (
                        controller.signal.aborted || myId !== requestId.current
                    ) return;
                    if (!res.ok) {
                        setCalcError(data.error || "Could not calculate order");
                        setServerCalc(null);
                        setServerMessages([]);
                        setServerSuggestion(null);
                        return;
                    }
                    const payload = data as ServerCalcResponse;
                    if (
                        !payload.offer?.token ||
                        JSON.stringify(payload.offer.inputs) !== inputKey
                    ) {
                        setCalcError(
                            "Quote does not match these inputs. Please request a fresh quote.",
                        );
                        return;
                    }
                    setQuote({ key: inputKey, offer: payload.offer });
                    setZone(payload.order.zone);
                    setServerCalc(payload.order);
                    setServerMessages(payload.messages);
                    setServerSuggestion(payload.suggestion);
                    if (payload.meta) {
                        setConfig((prev) => ({
                            ...prev,
                            version: payload.meta.pricingConfigVersion,
                            priceTiers: payload.meta.priceTiers,
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
                    if (
                        controller.signal.aborted || myId !== requestId.current
                    ) return;
                    setCalcError("Network error while calculating order");
                })
                .finally(() => {
                    if (
                        !controller.signal.aborted && myId === requestId.current
                    ) setCalcLoading(false);
                });
        }, DEBOUNCE_MS);

        return () => {
            controller.abort();
            if (debounceTimer.current) {
                window.clearTimeout(debounceTimer.current);
            }
        };
    }, [inputKey, quoteRevision, uncertain]);

    const breakdown = currentOffer ? serverCalc : null;
    const messages = currentOffer ? serverMessages : [];
    const suggestion = currentOffer ? serverSuggestion : null;

    const canPlaceOrder = submission.status === "APPROVED" &&
        submission.pdfReady &&
        !!currentOffer && acceptedToken === currentOffer.token &&
        !calcLoading && !calcError && !uncertain;

    const placeOrderDisabledReason = submission.status !== "APPROVED"
        ? "Your Titchybooks must be approved before printing."
        : !submission.pdfReady
        ? "Print-ready PDF is still being generated. Please try again shortly."
        : null;

    async function handlePlaceOrder() {
        if (submitLock.current) return;
        if (!pendingRequest.current) {
            if (
                uncertain || !canPlaceOrder || !currentOffer ||
                currentOffer.expiresAt <= Date.now()
            ) return;
            const payload = {
                ...currentOffer.inputs,
                offerToken: currentOffer.token,
                requestKey: crypto.randomUUID(),
                acceptTerms: true,
            };
            // Persist before the network call. Storage failure must not leave an
            // unrecoverable ambiguous request that could become a second order.
            try {
                const serialized = JSON.stringify(payload);
                window.sessionStorage.setItem(pendingStorageKey, serialized);
                if (
                    window.sessionStorage.getItem(pendingStorageKey) !==
                        serialized
                ) throw new Error();
            } catch {
                toast.error(
                    "Order-request storage is unavailable. Enable browser storage before ordering; no request was sent.",
                );
                return;
            }
            pendingRequest.current = payload;
            setPendingReady(true);
        }
        submitLock.current = true;
        setSubmitting(true);
        setUncertain(true);
        try {
            const res = await fetch("/api/orders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(pendingRequest.current),
            });
            const data = await res.json();
            if (!res.ok) {
                if (
                    data.code === "OFFER_REVIEW_REQUIRED" ||
                    data.code === "MANUAL_QUOTE_REQUIRED" || res.status === 400
                ) {
                    window.sessionStorage.removeItem(pendingStorageKey);
                    pendingRequest.current = null;
                    setPendingReady(false);
                    setUncertain(false);
                    setAcceptedToken(null);
                    setQuote(null);
                    setQuoteRevision((value) => value + 1);
                }
                throw new Error(
                    data.error ||
                        "Order outcome is uncertain. Retry the same request or check your orders.",
                );
            }
            if (!data.order?.id) {
                throw new Error(
                    "Order response is incomplete. Check your orders before retrying.",
                );
            }
            try {
                window.sessionStorage.removeItem(pendingStorageKey);
            } catch { /* Replaying the saved request is safe. */ }
            pendingRequest.current = null;
            setPendingReady(false);
            if (data.checkoutUrl) {
                window.location.assign(data.checkoutUrl);
                return;
            }
            if (data.paymentError) toast.error(data.paymentError);
            else {toast.success(
                    data.replayed
                        ? "Existing order recovered."
                        : "Order placed. Awaiting payment.",
                );}
            router.push(`/dashboard/orders/${data.order.id}`);
            router.refresh();
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Order outcome is uncertain. Check your orders.",
            );
        } finally {
            submitLock.current = false;
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
                <fieldset
                    className="space-y-5 min-w-0"
                    disabled={submitting || uncertain}
                >
                    <div>
                        <label className="flex items-center justify-between">
                            <span className="label">Quantity</span>
                            <input
                                type="number"
                                min={QUANTITY_MIN}
                                max={quantityCap}
                                value={quantity}
                                onChange={(event) => {
                                    const v = Number(event.target.value);
                                    if (Number.isFinite(v)) {
                                        setRequestedQuantity(
                                            Math.max(
                                                QUANTITY_MIN,
                                                Math.round(v),
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
                            max={quantityCap}
                            value={quantity}
                            onChange={(event) =>
                                setRequestedQuantity(
                                    Number(event.target.value),
                                )}
                            className="mt-2 w-full"
                            style={{ accentColor: "var(--color-primary)" }}
                        />
                        <div className="mt-1 flex flex-wrap gap-1 text-xs">
                            {PRICE_BREAK_QUANTITIES.filter(
                                (qty) => qty <= quantityCap,
                            ).map((qty) => (
                                <button
                                    key={qty}
                                    type="button"
                                    onClick={() => setRequestedQuantity(qty)}
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
                                        setRequestedQuantity(
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

                    {clampedForCarrier && (
                        <div
                            className="rounded-lg px-3 py-2 text-xs"
                            style={{
                                background: "var(--color-accent-light)",
                                color: "#92400E",
                            }}
                        >
                            <p>
                                This requested print run needs a manual quote.
                                The quantity has not been reduced.
                            </p>
                            <Link
                                href={quoteHref}
                                className="mt-1 inline-block font-medium underline"
                            >
                                Request a quote for{" "}
                                {requestedQuantity.toLocaleString("en-GB")}{" "}
                                copies
                            </Link>
                        </div>
                    )}

                    <div>
                        <p className="label">Shipping destination</p>
                        <p className="text-sm mt-1">
                            Country and postal code determine the approved
                            service{currentOffer
                                ? `: ${currentOffer.service} (${
                                    ZONE_LABELS[zone]
                                })`
                                : "."}
                        </p>
                        <p
                            className="mt-1 text-[11px]"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Country not listed, or need a heavier shipment?{" "}
                            <Link
                                href={quoteHref}
                                className="underline"
                                style={{ color: "var(--color-primary)" }}
                            >
                                Ask for a manual quote
                            </Link>
                            .
                        </p>
                    </div>

                    <div>
                        <label
                            className="label"
                            htmlFor={`order-currency-${submission.id}`}
                        >
                            Charge currency
                        </label>
                        <select
                            id={`order-currency-${submission.id}`}
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
                                Two printed copies will be stored indefinitely
                                in the Titchybook Vault, a long-term paper
                                storage service. Public visibility requires your
                                separate consent in the{" "}
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
                                    + {formatMoney(
                                        config.vaultFeeHuf,
                                        currency,
                                        config.currencyRates,
                                    )} flat fee
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
                </fieldset>

                {/* Breakdown */}
                <aside
                    className="rounded-xl p-5"
                    style={{
                        border: "1px solid var(--color-border)",
                        background: "var(--color-surface)",
                    }}
                >
                    <p className="section-label">
                        Matching server quote
                    </p>
                    {breakdown
                        ? (
                            <dl className="mt-3 space-y-2 text-sm">
                                <Row
                                    label="Price per copy"
                                    value={formatMoney(
                                        breakdown.unitPriceHuf,
                                        "HUF",
                                        config.currencyRates,
                                    )}
                                />
                                <Row
                                    label="Print cost"
                                    value={formatMoney(
                                        breakdown.printCostHuf,
                                        "HUF",
                                        config.currencyRates,
                                    )}
                                />
                                {breakdown.handlingCostHuf > 0 && (
                                    <Row
                                        label="Handling"
                                        value={formatMoney(
                                            breakdown.handlingCostHuf,
                                            "HUF",
                                            config.currencyRates,
                                        )}
                                    />
                                )}
                                <Row
                                    label="Shipping"
                                    value={formatMoney(
                                        breakdown.shippingCostHuf,
                                        "HUF",
                                        config.currencyRates,
                                    )}
                                />
                                {breakdown.vaultFeeHuf > 0 && (
                                    <Row
                                        label="Vault storage (2 copies)"
                                        value={formatMoney(
                                            breakdown.vaultFeeHuf,
                                            "HUF",
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
                                                "HUF",
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
                                    label="HUF total"
                                    value={formatMoney(
                                        breakdown.totalHuf,
                                        "HUF",
                                        config.currencyRates,
                                    )}
                                    emphasis
                                />
                                <Row
                                    label="Cost per book"
                                    value={formatMoney(
                                        breakdown.costPerBookHuf,
                                        "HUF",
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
                                    {config.shippingTable[zone]?.length ?? 0}
                                </p>
                            </dl>
                        )
                        : (
                            <p
                                className="mt-3 text-sm"
                                role={calcError ? "alert" : "status"}
                                style={{ color: "var(--color-text-muted)" }}
                            >
                                {uncertain
                                    ? "An order request is awaiting confirmation. Retry that same request or check your orders before starting another."
                                    : !inputKey
                                    ? "Complete the shipping address to request a matching quote."
                                    : calcError ??
                                        "Quote pending or expired. Request a fresh quote before ordering."}
                            </p>
                        )}

                    {currentOffer && (
                        <div className="mt-4 space-y-3 text-sm">
                            <p className="font-semibold">
                                Exact charge:{" "}
                                {formatCharge(
                                    currentOffer.charge.amountMinor,
                                    currentOffer.charge.currency,
                                )}
                            </p>
                            <p className="text-xs">
                                HUF total:{" "}
                                {breakdown?.totalHuf.toLocaleString("en-US")}
                                {" "}
                                HUF. Original FX:{" "}
                                {currentOffer.charge.fxRate}. Rounded to minor
                                units; payment retries retain this charge.
                            </p>
                            <p className="text-xs">
                                Preview valid until{" "}
                                {new Date(currentOffer.expiresAt)
                                    .toLocaleTimeString()}. An accepted pending
                                order does not expire or reprice.
                            </p>
                            <p className="text-xs whitespace-pre-wrap break-words">
                                {currentOffer.terms.text}
                            </p>
                            <label className="flex items-start gap-2">
                                <input
                                    type="checkbox"
                                    checked={acceptedToken ===
                                        currentOffer.token}
                                    disabled={submitting || uncertain}
                                    onChange={(e) =>
                                        setAcceptedToken(
                                            e.target.checked
                                                ? currentOffer.token
                                                : null,
                                        )}
                                />
                                <span>
                                    I accept this exact charge, shipping
                                    address, and terms ({currentOffer.terms
                                        .version}).
                                </span>
                            </label>
                        </div>
                    )}
                    {!uncertain && (
                        <button
                            type="button"
                            className="btn btn-ghost w-full mt-3"
                            disabled={!inputKey || submitting}
                            onClick={() => {
                                setQuote(null);
                                setAcceptedToken(null);
                                setQuoteRevision((value) => value + 1);
                            }}
                        >
                            Request fresh quote
                        </button>
                    )}
                    <Link
                        href={quoteHref}
                        className="block mt-3 text-xs underline"
                    >
                        Ask for a manual quote
                    </Link>
                    {uncertain && (
                        <Link
                            href="/dashboard/orders"
                            className="block mt-3 text-sm underline"
                        >
                            Check existing orders
                        </Link>
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
                        disabled={submitting ||
                            (uncertain ? !pendingReady : !canPlaceOrder)}
                        className="btn btn-primary w-full mt-4"
                    >
                        {submitting
                            ? "Placing order..."
                            : calcLoading
                            ? "Calculating..."
                            : uncertain
                            ? "Retry same order request"
                            : "Place order"}
                    </button>
                    <p
                        className="mt-2 text-[11px]"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        Continue to secure payment after accepting the displayed
                        charge. Payment is confirmed separately.
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
