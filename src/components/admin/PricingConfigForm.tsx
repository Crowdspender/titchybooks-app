"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
    DEFAULT_CURRENCY_RATES,
    DEFAULT_PRICE_TIERS,
    type PriceTier,
    type Zone,
    ZONE_LABELS,
    ZONES,
} from "@/lib/pricing/constants";
import { calculateOrder } from "@/lib/pricing/engine";
import { CURRENCY_LABELS } from "@/lib/pricing/currency";

interface CurrencyRatesState {
    HUF: 1;
    EUR: number;
    GBP: number;
}

interface PricingConfigState {
    weightPerBookGrams: number;
    handlingFixedHuf: number;
    handlingPercent: number;
    enabledZones: Zone[];
    weightBands: number[];
    shippingTable: Record<Zone, number[]>;
    priceTiers: PriceTier[];
    currencyRates: CurrencyRatesState;
    vaultFeeHuf: number;
}

const EMPTY_TIER: PriceTier = { min: 1, max: 1, pricePerCopy: 0 };

export default function PricingConfigForm() {
    const [config, setConfig] = useState<PricingConfigState | null>(null);
    const [version, setVersion] = useState<number>(0);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = await fetch("/api/admin/pricing-config");
                const data = await res.json();
                if (cancelled) return;
                if (!res.ok) {
                    toast.error(data.error || "Could not load pricing config");
                    return;
                }
                const cfg = data.config;
                setVersion(cfg.version);
                setConfig({
                    weightPerBookGrams: cfg.weightPerBookGrams,
                    handlingFixedHuf: cfg.handlingFixedHuf,
                    handlingPercent: cfg.handlingPercent,
                    enabledZones: cfg.enabledZones,
                    weightBands: cfg.weightBands,
                    shippingTable: cfg.shippingTable,
                    priceTiers: cfg.priceTiers,
                    currencyRates: {
                        HUF: 1,
                        EUR: cfg.currencyRates?.EUR ??
                            DEFAULT_CURRENCY_RATES.EUR,
                        GBP: cfg.currencyRates?.GBP ??
                            DEFAULT_CURRENCY_RATES.GBP,
                    },
                    vaultFeeHuf: cfg.vaultFeeHuf ?? 2000,
                });
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const tierError = useMemo(() => {
        if (!config) return null;
        const sorted = [...config.priceTiers].sort((a, b) => a.min - b.min);
        if (sorted.length === 0) return "Add at least one tier";
        if (sorted[0].min !== 1) return "Tiers must start at quantity 1";
        for (let i = 1; i < sorted.length; i += 1) {
            if (sorted[i].min !== sorted[i - 1].max + 1) {
                return `Gap or overlap between tier ${i} and ${i + 1}`;
            }
        }
        return null;
    }, [config]);

    // Canonical quantities for the live preview. Picked to sit inside each
    // default tier so admins can eyeball the effect of tier edits at a glance.
    const PREVIEW_QUANTITIES = useMemo(() => [1, 8, 40, 80, 160, 333], []);

    const tierPreview = useMemo(() => {
        if (!config || tierError) return null;
        const previewZone: Zone = config.enabledZones[0] ?? "hungary";
        const cfg = {
            version: 0,
            weightPerBookGrams: config.weightPerBookGrams,
            handlingFixedHuf: config.handlingFixedHuf,
            handlingPercent: config.handlingPercent,
            enabledZones: config.enabledZones,
            weightBands: config.weightBands,
            shippingTable: config.shippingTable,
            priceTiers: config.priceTiers,
            currencyRates: config.currencyRates,
            vaultFeeHuf: config.vaultFeeHuf,
        };
        return {
            zone: previewZone,
            rows: PREVIEW_QUANTITIES.map((qty) => {
                try {
                    const result = calculateOrder(previewZone, qty, cfg);
                    return {
                        quantity: qty,
                        unitPriceHuf: result.unitPriceHuf,
                        printCostHuf: result.printCostHuf,
                        costPerBookHuf: result.costPerBookHuf,
                        ok: true as const,
                    };
                } catch (error) {
                    return {
                        quantity: qty,
                        unitPriceHuf: 0,
                        printCostHuf: 0,
                        costPerBookHuf: 0,
                        ok: false as const,
                        error: error instanceof Error
                            ? error.message
                            : "cannot calculate",
                    };
                }
            }),
        };
    }, [config, tierError, PREVIEW_QUANTITIES]);

    if (loading || !config) {
        return (
            <div className="page-container py-10">
                <div
                    className="card p-10 animate-pulse"
                    style={{ background: "var(--color-border)" }}
                >
                    <div
                        className="h-6 w-48 rounded"
                        style={{ background: "var(--color-border-strong)" }}
                    />
                </div>
            </div>
        );
    }

    function updateConfig(patch: Partial<PricingConfigState>) {
        setConfig((c) => (c ? { ...c, ...patch } : c));
    }

    function setShippingCell(zone: Zone, bandIdx: number, value: number) {
        if (!config) return;
        const next = { ...config.shippingTable };
        next[zone] = config.shippingTable[zone].map((v, i) =>
            i === bandIdx ? value : v
        );
        updateConfig({ shippingTable: next });
    }

    function setBand(idx: number, value: number) {
        if (!config) return;
        updateConfig({
            weightBands: config.weightBands.map((
                v,
                i,
            ) => (i === idx ? value : v)),
        });
    }

    function setTierField(idx: number, patch: Partial<PriceTier>) {
        if (!config) return;
        updateConfig({
            priceTiers: config.priceTiers.map((tier, i) =>
                i === idx ? { ...tier, ...patch } : tier
            ),
        });
    }

    function addTier() {
        if (!config) return;
        const last = config.priceTiers[config.priceTiers.length - 1];
        const nextMin = last ? last.max + 1 : 1;
        updateConfig({
            priceTiers: [
                ...config.priceTiers,
                { ...EMPTY_TIER, min: nextMin, max: nextMin, pricePerCopy: 0 },
            ],
        });
    }

    function removeTier(idx: number) {
        if (!config) return;
        updateConfig({
            priceTiers: config.priceTiers.filter((_, i) => i !== idx),
        });
    }

    function resetTiersToDefaults() {
        if (!config) return;
        const confirmed = typeof window === "undefined" ? true : window.confirm(
            "Replace the current price tiers with the built-in defaults? " +
                "Unsaved changes to tiers will be lost — you'll still need to click Save to persist.",
        );
        if (!confirmed) return;
        updateConfig({
            priceTiers: DEFAULT_PRICE_TIERS.map((tier) => ({ ...tier })),
        });
        toast.success("Price tiers reset to defaults (not saved yet)");
    }

    function setCurrencyRate(currency: "EUR" | "GBP", value: number) {
        if (!config) return;
        updateConfig({
            currencyRates: {
                ...config.currencyRates,
                [currency]: value,
            },
        });
    }

    function resetRatesToDefaults() {
        if (!config) return;
        updateConfig({
            currencyRates: {
                HUF: 1,
                EUR: DEFAULT_CURRENCY_RATES.EUR,
                GBP: DEFAULT_CURRENCY_RATES.GBP,
            },
        });
        toast.success("Currency rates reset to defaults (not saved yet)");
    }

    function toggleZone(zone: Zone) {
        if (!config) return;
        const enabled = config.enabledZones.includes(zone)
            ? config.enabledZones.filter((z) => z !== zone)
            : [...config.enabledZones, zone];
        updateConfig({ enabledZones: enabled });
    }

    async function save() {
        if (!config) return;
        if (tierError) {
            toast.error(tierError);
            return;
        }
        setSaving(true);
        try {
            const res = await fetch("/api/admin/pricing-config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(config),
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || "Save failed");
            }
            setVersion(data.config.version);
            toast.success(`Pricing saved (v${data.config.version})`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Save failed");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="page-container py-10 space-y-6">
            <div className="flex items-center justify-between mb-2">
                <div>
                    <p className="section-label mb-2">Administration</p>
                    <h1
                        className="text-3xl font-semibold tracking-tight"
                        style={{ color: "var(--color-text)" }}
                    >
                        Pricing Configuration
                    </h1>
                </div>
                <span
                    className="badge badge-draft"
                    style={{ fontSize: "0.75rem" }}
                >
                    Version {version}
                </span>
            </div>

            {/* Global numbers */}
            <section className="card p-6">
                <h2 className="section-label mb-4">Globals</h2>
                <div className="grid gap-4 sm:grid-cols-3">
                    <NumberField
                        label="Weight per book (g)"
                        value={config.weightPerBookGrams}
                        onChange={(v) =>
                            updateConfig({ weightPerBookGrams: v })}
                    />
                    <NumberField
                        label="Handling — fixed (HUF)"
                        value={config.handlingFixedHuf}
                        onChange={(v) => updateConfig({ handlingFixedHuf: v })}
                    />
                    <NumberField
                        label="Handling — percent of print"
                        value={config.handlingPercent}
                        onChange={(v) => updateConfig({ handlingPercent: v })}
                        step="0.1"
                    />
                </div>
            </section>

            {/* Enabled zones */}
            <section className="card p-6">
                <h2 className="section-label mb-4">Enabled zones</h2>
                <div className="flex flex-wrap gap-3">
                    {ZONES.map((zone) => (
                        <label
                            key={zone}
                            className="flex items-center gap-2 text-sm"
                        >
                            <input
                                type="checkbox"
                                checked={config.enabledZones.includes(zone)}
                                onChange={() => toggleZone(zone)}
                            />
                            {ZONE_LABELS[zone]}
                        </label>
                    ))}
                </div>
            </section>

            {/* Weight bands + shipping table */}
            <section className="card p-6">
                <h2 className="section-label mb-4">Shipping table (HUF)</h2>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead>
                            <tr>
                                <th className="px-3 py-2 text-left font-medium">
                                    Zone
                                </th>
                                {config.weightBands.map((band, idx) => (
                                    <th
                                        key={idx}
                                        className="px-3 py-2 text-left font-medium"
                                    >
                                        <span
                                            className="text-xs"
                                            style={{
                                                color:
                                                    "var(--color-text-subtle)",
                                            }}
                                        >
                                            ≤
                                        </span>
                                        <input
                                            type="number"
                                            min={1}
                                            value={band}
                                            onChange={(event) =>
                                                setBand(
                                                    idx,
                                                    Number(event.target.value),
                                                )}
                                            className="input w-20 py-0.5 px-1.5 text-xs inline-block"
                                        />
                                        g
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {ZONES.map((zone) => (
                                <tr
                                    key={zone}
                                    className="border-t border-stone-200"
                                >
                                    <td className="px-3 py-2 font-medium">
                                        {ZONE_LABELS[zone]}
                                    </td>
                                    {config.weightBands.map((_, idx) => (
                                        <td key={idx} className="px-3 py-2">
                                            <input
                                                type="number"
                                                min={0}
                                                value={config
                                                    .shippingTable[zone]
                                                    ?.[idx] ?? 0}
                                                onChange={(event) =>
                                                    setShippingCell(
                                                        zone,
                                                        idx,
                                                        Number(
                                                            event.target.value,
                                                        ),
                                                    )}
                                                className="input w-24 py-1 px-2 text-sm"
                                            />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* Price tiers */}
            <section className="card p-6">
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="section-label">Price tiers</h2>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={resetTiersToDefaults}
                            className="btn btn-outline btn-sm text-xs"
                        >
                            Reset to defaults
                        </button>
                        <button
                            type="button"
                            onClick={addTier}
                            className="btn btn-primary btn-sm text-xs"
                        >
                            Add tier
                        </button>
                    </div>
                </div>
                {tierError && (
                    <p
                        className="mb-3 rounded-lg px-3 py-2 text-xs"
                        style={{
                            background: "var(--color-accent-light)",
                            color: "#92400E",
                        }}
                    >
                        {tierError}
                    </p>
                )}
                <table className="w-full text-sm">
                    <thead>
                        <tr>
                            <th className="px-3 py-2 text-left font-medium">
                                Min qty
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                                Max qty
                            </th>
                            <th className="px-3 py-2 text-left font-medium">
                                Price per copy (HUF)
                            </th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {config.priceTiers.map((tier, idx) => (
                            <tr key={idx} className="border-t border-stone-200">
                                <td className="px-3 py-2">
                                    <input
                                        type="number"
                                        min={1}
                                        value={tier.min}
                                        onChange={(event) =>
                                            setTierField(idx, {
                                                min: Number(event.target.value),
                                            })}
                                        className="input w-20 py-1 px-2 text-sm"
                                    />
                                </td>
                                <td className="px-3 py-2">
                                    <input
                                        type="number"
                                        min={1}
                                        value={tier.max}
                                        onChange={(event) =>
                                            setTierField(idx, {
                                                max: Number(event.target.value),
                                            })}
                                        className="input w-20 py-1 px-2 text-sm"
                                    />
                                </td>
                                <td className="px-3 py-2">
                                    <input
                                        type="number"
                                        min={0}
                                        value={tier.pricePerCopy}
                                        onChange={(event) =>
                                            setTierField(idx, {
                                                pricePerCopy: Number(
                                                    event.target.value,
                                                ),
                                            })}
                                        className="input w-24 py-1 px-2 text-sm"
                                    />
                                </td>
                                <td className="px-3 py-2 text-right">
                                    <button
                                        type="button"
                                        onClick={() => removeTier(idx)}
                                        className="text-xs text-red-600 hover:underline"
                                    >
                                        Remove
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {/* Live preview — recalculated whenever tiers/config change */}
                {tierPreview && (
                    <div
                        className="mt-6 rounded-lg p-4"
                        style={{
                            background: "var(--color-surface)",
                            border: "1px solid var(--color-border)",
                        }}
                    >
                        <div className="mb-2 flex items-baseline justify-between">
                            <h3 className="section-label">Live preview</h3>
                            <span
                                className="text-xs"
                                style={{ color: "var(--color-text-subtle)" }}
                            >
                                Shipping zone: {ZONE_LABELS[tierPreview.zone]}
                                {" "}
                                (first enabled)
                            </span>
                        </div>
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-left text-stone-500">
                                    <th className="px-2 py-1 font-medium">
                                        Quantity
                                    </th>
                                    <th className="px-2 py-1 font-medium">
                                        Unit price (HUF)
                                    </th>
                                    <th className="px-2 py-1 font-medium">
                                        Print cost (HUF)
                                    </th>
                                    <th className="px-2 py-1 font-medium">
                                        Cost / book (HUF, incl. shipping)
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {tierPreview.rows.map((row) => (
                                    <tr
                                        key={row.quantity}
                                        className="border-t border-stone-200"
                                    >
                                        <td className="px-2 py-1 font-medium">
                                            {row.quantity}
                                        </td>
                                        {row.ok
                                            ? (
                                                <>
                                                    <td className="px-2 py-1">
                                                        {row.unitPriceHuf
                                                            .toLocaleString(
                                                                "en-US",
                                                            )}
                                                    </td>
                                                    <td className="px-2 py-1">
                                                        {row.printCostHuf
                                                            .toLocaleString(
                                                                "en-US",
                                                            )}
                                                    </td>
                                                    <td className="px-2 py-1">
                                                        {row.costPerBookHuf
                                                            .toLocaleString(
                                                                "en-US",
                                                            )}
                                                    </td>
                                                </>
                                            )
                                            : (
                                                <td
                                                    colSpan={3}
                                                    className="px-2 py-1 text-amber-700"
                                                >
                                                    {row.error}
                                                </td>
                                            )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <p className="mt-2 text-[11px] text-stone-500">
                            Preview recalculates instantly. Click Save to
                            persist changes.
                        </p>
                    </div>
                )}
            </section>

            {/* Currency rates */}
            <section className="card p-6">
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="section-label">Currency rates</h2>
                    <button
                        type="button"
                        onClick={resetRatesToDefaults}
                        className="btn btn-outline btn-sm text-xs"
                    >
                        Reset to defaults
                    </button>
                </div>
                <p
                    className="mb-3 text-xs"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    HUF is the base currency and always equals 1. The values
                    below are the factor applied when displaying a HUF amount in
                    the target currency (e.g. 1 HUF ≈ 0.0026 EUR). These feed
                    the Order panel&rsquo;s currency selector.
                </p>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-stone-500">
                            <th className="px-3 py-2 font-medium">Currency</th>
                            <th className="px-3 py-2 font-medium">
                                Factor (1 HUF →)
                            </th>
                            <th className="px-3 py-2 font-medium">
                                Example: 10 000 HUF
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr className="border-t border-stone-200">
                            <td className="px-3 py-2 font-medium">
                                {CURRENCY_LABELS.HUF}
                            </td>
                            <td className="px-3 py-2 text-stone-500">1</td>
                            <td className="px-3 py-2 text-stone-500">
                                10 000 Ft
                            </td>
                        </tr>
                        <tr className="border-t border-stone-200">
                            <td className="px-3 py-2 font-medium">
                                {CURRENCY_LABELS.EUR}
                            </td>
                            <td className="px-3 py-2">
                                <input
                                    type="number"
                                    min={0}
                                    step="0.0001"
                                    value={config.currencyRates.EUR}
                                    onChange={(event) =>
                                        setCurrencyRate(
                                            "EUR",
                                            Number(event.target.value),
                                        )}
                                    className="input w-32 py-1 px-2 text-sm"
                                />
                            </td>
                            <td className="px-3 py-2 text-stone-500">
                                ≈{" "}
                                {(10000 * config.currencyRates.EUR).toFixed(2)}
                                {" "}
                                €
                            </td>
                        </tr>
                        <tr className="border-t border-stone-200">
                            <td className="px-3 py-2 font-medium">
                                {CURRENCY_LABELS.GBP}
                            </td>
                            <td className="px-3 py-2">
                                <input
                                    type="number"
                                    min={0}
                                    step="0.0001"
                                    value={config.currencyRates.GBP}
                                    onChange={(event) => setCurrencyRate(
                                        "GBP",
                                        Number(event.target.value),
                                    )}
                                    className="input w-32 py-1 px-2 text-sm"
                                />
                            </td>
                            <td className="px-3 py-2 text-stone-500">
                                ≈{" "}
                                {(10000 * config.currencyRates.GBP).toFixed(2)}
                                {" "}
                                £
                            </td>
                        </tr>
                    </tbody>
                </table>
            </section>

            {/* Vault storage */}
            <section className="card p-6">
                <h2 className="section-label mb-4">Vault Storage</h2>
                <p
                    className="mb-3 text-xs"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Flat fee (HUF) charged when a user opts to have 2 printed
                    copies stored indefinitely in the Titchybook Vault. This fee
                    is added to the order total.
                </p>
                <NumberField
                    label="Vault add-on fee (HUF)"
                    value={config.vaultFeeHuf}
                    onChange={(v) => updateConfig({ vaultFeeHuf: v })}
                />
            </section>

            <div className="flex justify-end">
                <button
                    type="button"
                    onClick={save}
                    disabled={saving || !!tierError}
                    className="btn btn-primary btn-lg"
                >
                    {saving ? "Saving..." : "Save pricing"}
                </button>
            </div>
        </div>
    );
}

function NumberField({
    label,
    value,
    onChange,
    step,
}: {
    label: string;
    value: number;
    onChange: (v: number) => void;
    step?: string;
}) {
    return (
        <div>
            <label className="label">{label}</label>
            <input
                type="number"
                value={value}
                step={step ?? "1"}
                min={0}
                onChange={(event) => onChange(Number(event.target.value))}
                className="input"
            />
        </div>
    );
}
