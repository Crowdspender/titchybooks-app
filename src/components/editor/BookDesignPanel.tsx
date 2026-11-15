"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { allowedStyleProperties, DESIGN_PRESETS } from "@/lib/editor/design";
import {
    DESIGN_FAMILIES,
    type StyleOverride,
    type StyleProperty,
} from "@/lib/editor/design-schema";
import type { DesignAction } from "@/lib/editor/design-actions";
import type { EditorElement, EditorScene } from "@/lib/editor/schema";
import { faceId, loadBrowserDesignFont } from "@/lib/editor/design-fonts";
import { layoutDesignText } from "@/lib/editor/design-text-layout";
import {
    type DesignIssue,
    pointsPerScenePixel,
} from "@/lib/editor/design-preflight";

function PresetPreview(
    { presetId, retry, onStatus }: {
        presetId: keyof typeof DESIGN_PRESETS;
        retry: number;
        onStatus: (id: string, failed: boolean) => void;
    },
) {
    const preset = DESIGN_PRESETS[presetId];
    const [ready, setReady] = useState(false);
    const [error, setError] = useState(false);
    const element = useMemo(() => ({
        id: "preview",
        type: "text" as const,
        x: 0,
        y: 0,
        width: 280,
        height: 70,
        rotation: 0,
        opacity: 1,
        locked: false,
        visible: true,
        zIndex: 0,
        text: "A little story",
        fontFamily: preset.family,
        fontSize: 30,
        fontWeight: 400,
        lineHeight: 1.2,
        letterSpacing: 0,
        color: preset.palette.ink,
        align: "left" as const,
        verticalAlign: "top" as const,
        typographyVersion: 1 as const,
    }), [preset]);
    useEffect(() => {
        let cancelled = false;
        loadBrowserDesignFont(faceId(element)).then(() => {
            if (!cancelled) {
                setReady(true);
                setError(false);
                onStatus(presetId, false);
            }
        }, () => {
            if (!cancelled) {
                setError(true);
                onStatus(presetId, true);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [element, retry, presetId, onStatus]);
    if (!ready) {
        return (
            <span className="block py-3 text-xs">
                {error ? "Font unavailable" : "Loading font…"}
            </span>
        );
    }
    return (
        <svg
            viewBox="0 0 280 52"
            className="w-full"
            role="img"
            aria-label={`${preset.name} text preview`}
        >
            <path
                fill={preset.palette.ink}
                d={layoutDesignText(element).path}
            />
        </svg>
    );
}

export default function BookDesignPanel(
    {
        scene,
        pageLabel,
        selectedElement,
        onApply,
        onGestureStart,
        onGestureEnd,
        issues,
        fontStatus,
        onRetryFonts,
    }: {
        scene: EditorScene;
        pageLabel: string;
        selectedElement: EditorElement | null;
        onApply: (
            action: DesignAction,
            scope: "element" | "page" | "book",
        ) => void;
        onGestureStart: () => void;
        onGestureEnd: () => void;
        issues: DesignIssue[];
        fontStatus: string | null;
        onRetryFonts: () => void;
    },
) {
    const [previewRetry, setPreviewRetry] = useState(0);
    const [failedPreviews, setFailedPreviews] = useState<string[]>([]);
    const onPreviewStatus = useCallback((id: string, failed: boolean) => {
        setFailedPreviews((previous) =>
            previous.includes(id) === failed
                ? previous
                : failed
                ? [...previous, id]
                : previous.filter((value) => value !== id)
        );
    }, []);
    const [scope, setScope] = useState<"page" | "book">("page");
    const [textScope, setTextScope] = useState<"element" | "page" | "book">(
        "element",
    );
    const text = selectedElement?.type === "text" ? selectedElement : null;
    const allowed = text ? allowedStyleProperties(text) : [];
    const palette = scene.design?.palette ??
        DESIGN_PRESETS[scene.design?.presetId ?? "classic"].palette;
    const factor = pointsPerScenePixel(scene, pageLabel);
    const field = (key: StyleProperty, value: StyleOverride[StyleProperty]) =>
        onApply({
            type: "style",
            patch: { [key]: value },
            elementId: textScope === "element" ? text?.id : undefined,
            role: text?.designRole,
        }, textScope);
    const gesture = {
        onPointerDown: onGestureStart,
        onPointerUp: onGestureEnd,
        onPointerCancel: onGestureEnd,
        onBlur: onGestureEnd,
        onKeyDown: onGestureStart,
        onKeyUp: onGestureEnd,
    };
    const slider = (
        key: "lineHeight" | "tracking" | "paragraphGap" | "firstLineIndent",
        label: string,
        min: number,
        max: number,
        step: number,
        fallback: number,
    ) => (
        <label className="block text-xs" key={key}>
            <span className="flex justify-between">
                <span>{label}</span>
                <output>{(text?.[key] ?? fallback).toFixed(2)}</output>
            </span>
            <input
                aria-label={label}
                type="range"
                className="mt-2 w-full accent-amber-700"
                min={text?.stylePolicy?.limits?.[key]?.min ?? min}
                max={text?.stylePolicy?.limits?.[key]?.max ?? max}
                step={step}
                value={text?.[key] ?? fallback}
                disabled={!allowed.includes(key)}
                {...gesture}
                onChange={(event) => field(key, Number(event.target.value))}
            />
        </label>
    );
    return (
        <aside className="card space-y-4 p-5" aria-label="Book Design">
            <div className="flex items-start justify-between gap-2">
                <div>
                    <p className="section-label">The finishing touches</p>
                    <h2 className="mt-1 text-lg font-semibold">Book Design</h2>
                </div>
                <span className="rounded-full border px-2 py-1 text-[10px] uppercase tracking-widest">
                    01 / Style
                </span>
            </div>
            <label className="block text-xs">
                Apply design to
                <select
                    aria-label="Design scope"
                    className="input mt-1"
                    value={scope}
                    onChange={(event) =>
                        setScope(event.target.value as typeof scope)}
                >
                    <option value="page">This page</option>
                    <option value="book">All eight pages</option>
                </select>
            </label>
            <div className="space-y-2">
                {(Object.keys(DESIGN_PRESETS) as Array<
                    keyof typeof DESIGN_PRESETS
                >).map((id) => {
                    const preset = DESIGN_PRESETS[id];
                    return (
                        <button
                            key={id}
                            type="button"
                            aria-pressed={scene.design?.presetId === id}
                            onClick={() =>
                                onApply(
                                    { type: "preset", presetId: id },
                                    scope,
                                )}
                            className="w-full rounded-xl border p-3 text-left transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2"
                            style={{
                                background: preset.palette.paper,
                                color: preset.palette.ink,
                                borderColor: scene.design?.presetId === id
                                    ? preset.palette.accent
                                    : "#d9d5cd",
                            }}
                        >
                            <span className="flex items-center justify-between text-xs font-semibold">
                                <span>{preset.name}</span>
                                <span
                                    className="h-2 w-7 rounded-full"
                                    style={{
                                        background: preset.palette.accent,
                                    }}
                                />
                            </span>
                            <PresetPreview
                                presetId={id}
                                retry={previewRetry}
                                onStatus={onPreviewStatus}
                            />
                            <span className="block text-[11px]">
                                {preset.description}
                            </span>
                        </button>
                    );
                })}
            </div>
            <div className="grid grid-cols-3 gap-2">
                {(["paper", "ink", "accent"] as const).map((key) => (
                    <label key={key} className="text-xs capitalize">
                        {key}
                        <input
                            aria-label={`${key} palette color`}
                            type="color"
                            className="mt-1 h-8 w-full cursor-pointer rounded border"
                            value={palette[key]}
                            {...gesture}
                            onChange={(event) =>
                                onApply({
                                    type: "palette",
                                    palette: {
                                        ...palette,
                                        [key]: event.target.value,
                                    },
                                }, scope)}
                        />
                    </label>
                ))}
            </div>
            <p className="text-xs leading-5 opacity-70">
                Layout and words stay in place. Box-specific overrides are
                preserved. Presets are starting points; check fit before
                printing.
            </p>
            <details className="border-t pt-3" open={text ? true : undefined}>
                <summary className="cursor-pointer text-sm font-semibold">
                    Advanced typography
                </summary>
                {!text
                    ? (
                        <p className="mt-3 text-xs">
                            Select a text box to format it.
                        </p>
                    )
                    : !allowed.length
                    ? (
                        <p className="mt-3 text-xs">
                            This text is protected by the template.
                        </p>
                    )
                    : (
                        <div className="mt-3 space-y-3">
                            <label className="block text-xs">
                                Typography scope<select
                                    aria-label="Typography scope"
                                    className="input mt-1"
                                    value={textScope}
                                    onChange={(event) =>
                                        setTextScope(
                                            event.target
                                                .value as typeof textScope,
                                        )}
                                >
                                    <option value="element">
                                        This whole text box
                                    </option>
                                    <option value="page">
                                        Matching role on this page
                                    </option>
                                    <option value="book">
                                        Matching role in book
                                    </option>
                                </select>
                            </label>
                            <label className="block text-xs">
                                Font family<select
                                    aria-label="Font family"
                                    className="input mt-1"
                                    value={DESIGN_FAMILIES.includes(
                                            text.fontFamily as typeof DESIGN_FAMILIES[
                                                number
                                            ],
                                        )
                                        ? text.fontFamily
                                        : ""}
                                    disabled={!allowed.includes("fontFamily")}
                                    onChange={(event) =>
                                        field(
                                            "fontFamily",
                                            event.target
                                                .value as StyleOverride[
                                                    "fontFamily"
                                                ],
                                        )}
                                >
                                    <option value="" disabled>
                                        Legacy font · {text.fontFamily}
                                    </option>
                                    {DESIGN_FAMILIES.map((family) => (
                                        <option key={family}>{family}</option>
                                    ))}
                                </select>
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                <label className="text-xs">
                                    Folded size (pt)<input
                                        aria-label="Folded font size"
                                        className="input mt-1"
                                        type="number"
                                        min={(text.stylePolicy?.minFontSize ??
                                            12) * factor}
                                        max={(text.stylePolicy?.maxFontSize ??
                                            120) * factor}
                                        step="0.1"
                                        value={Number(
                                            (text.fontSize * factor).toFixed(2),
                                        )}
                                        disabled={!allowed.includes("fontSize")}
                                        onChange={(event) => {
                                            const size =
                                                Number(event.target.value) /
                                                factor;
                                            if (
                                                size >=
                                                    (text.stylePolicy
                                                        ?.minFontSize ?? 12) &&
                                                size <=
                                                    (text.stylePolicy
                                                        ?.maxFontSize ?? 120)
                                            ) field("fontSize", size);
                                        }}
                                    />
                                </label>
                                <label className="text-xs">
                                    Text color<input
                                        aria-label="Guided text color"
                                        type="color"
                                        className="mt-1 h-10 w-full rounded border"
                                        value={text.color}
                                        disabled={!allowed.includes("color")}
                                        {...gesture}
                                        onChange={(event) =>
                                            field("color", event.target.value)}
                                    />
                                </label>
                            </div>
                            <p className="text-[11px] opacity-70">
                                Reading PDF:{" "}
                                {(text.fontSize *
                                    pointsPerScenePixel(scene, pageLabel, true))
                                    .toFixed(2)}{" "}
                                pt. For complete Latin Extended-A coverage,
                                choose Source Sans 3.
                            </p>
                            <div className="flex gap-2">
                                <button
                                    className="btn btn-outline btn-sm font-bold"
                                    aria-pressed={text.fontWeight >= 600}
                                    disabled={!allowed.includes("fontWeight")}
                                    onClick={() =>
                                        field(
                                            "fontWeight",
                                            text.fontWeight >= 600 ? 400 : 700,
                                        )}
                                >
                                    Bold
                                </button>
                                <button
                                    className="btn btn-outline btn-sm italic"
                                    aria-pressed={Boolean(text.italic)}
                                    disabled={!allowed.includes("italic")}
                                    onClick={() =>
                                        field("italic", !text.italic)}
                                >
                                    Italic
                                </button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <label className="text-xs">
                                    Alignment<select
                                        aria-label="Text alignment"
                                        className="input mt-1"
                                        value={text.align}
                                        disabled={!allowed.includes("align")}
                                        onChange={(event) =>
                                            field(
                                                "align",
                                                event.target
                                                    .value as StyleOverride[
                                                        "align"
                                                    ],
                                            )}
                                    >
                                        {["left", "center", "right"].map(
                                            (value) => (
                                                <option key={value}>
                                                    {value}
                                                </option>
                                            )
                                        )}
                                    </select>
                                </label>
                                <label className="text-xs">
                                    Vertical<select
                                        aria-label="Vertical alignment"
                                        className="input mt-1"
                                        value={text.verticalAlign}
                                        disabled={!allowed.includes(
                                            "verticalAlign",
                                        )}
                                        onChange={(event) =>
                                            field(
                                                "verticalAlign",
                                                event.target
                                                    .value as StyleOverride[
                                                        "verticalAlign"
                                                    ],
                                            )}
                                    >
                                        {["top", "middle", "bottom"].map(
                                            (value) => (
                                                <option key={value}>
                                                    {value}
                                                </option>
                                            )
                                        )}
                                    </select>
                                </label>
                            </div>
                            {slider(
                                "lineHeight",
                                "Line height",
                                1.1,
                                1.8,
                                0.05,
                                1.45,
                            )}
                            {slider(
                                "tracking",
                                "Tracking (em)",
                                -0.02,
                                0.12,
                                0.01,
                                0,
                            )}
                            {slider(
                                "paragraphGap",
                                "Paragraph gap (em)",
                                0,
                                1.5,
                                0.05,
                                0,
                            )}
                            {slider(
                                "firstLineIndent",
                                "First-line indent (em)",
                                0,
                                2,
                                0.1,
                                0,
                            )}
                            <button
                                className="btn btn-outline btn-sm w-full"
                                onClick={() =>
                                    onApply({
                                        type: "reset",
                                        elementId: text.id,
                                    }, "element")}
                            >
                                Reset box formatting
                            </button>
                        </div>
                    )}
            </details>
            {(fontStatus || failedPreviews.length > 0) && (
                <div
                    role="status"
                    className="rounded-lg border border-amber-500 p-3 text-xs"
                >
                    {fontStatus ?? "Some font previews are unavailable."}
                    <button
                        className="mt-2 block underline"
                        onClick={() => {
                            setPreviewRetry((value) => value + 1);
                            onRetryFonts();
                        }}
                    >
                        Retry fonts
                    </button>
                </div>
            )}
            {issues.length > 0 && (
                <div
                    role="status"
                    className="max-h-40 space-y-2 overflow-auto rounded-lg border border-amber-500 p-3 text-xs"
                >
                    <p className="font-semibold">
                        Print checks · {issues.length}
                    </p>
                    {issues.map((issue, index) => (
                        <p key={`${issue.elementId}-${index}`}>
                            {issue.severity === "error"
                                ? "Fix before printing"
                                : "Advisory"}: {issue.message}
                        </p>
                    ))}
                </div>
            )}
            <button
                className="btn btn-outline btn-sm w-full"
                onClick={() => onApply({ type: "reset" }, scope)}
            >
                Reset {scope === "book" ? "book" : "page"} formatting
            </button>
            <p className="text-[11px] opacity-70">
                Reset never changes your words.
            </p>
        </aside>
    );
}
