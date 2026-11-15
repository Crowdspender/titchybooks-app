"use client";

import {
  getNormalizedCropValue,
  getNormalizedZoomValue,
} from "@/lib/editor/crop";
import type { EditorElement } from "@/lib/editor/schema";
import type { RenderableEditorElement } from "@/lib/editor/template-types";
import {
  DPI_HARD_THRESHOLD,
  DPI_WARNING_THRESHOLD,
  getElementDpi,
} from "@/lib/editor/validation";
import ColorPicker from "./ColorPicker";
import {
  DESIGN_ROLES,
  type DesignRole,
  SPACING_LIMITS,
  type SpacingProperty,
  STYLE_PROPERTIES,
} from "@/lib/editor/design-schema";
import { isProtectedDesign } from "@/lib/editor/design";

interface PropertiesPanelProps {
  selectedElement: RenderableEditorElement | null;
  onChangeElement: (
    elementId: string,
    updater: (element: EditorElement) => EditorElement,
  ) => void;
  onDeleteElement: (elementId: string) => void;
  onDuplicateElement: (elementId: string) => void;
  onToggleVisibility: (elementId: string) => void;
  onToggleLock: (elementId: string) => void;
  onBringForward: (elementId: string) => void;
  onSendBackward: (elementId: string) => void;
  isInstanceMode?: boolean;
  isTemplateAuthor?: boolean;
  guidedTypography?: boolean;
  /** Original (non-overridden) text of the selected template text element. */
  templateTextOriginal?: string;
  /** Clears the per-instance text override, restoring template default. */
  onResetTemplateText?: (elementId: string) => void;
  /** Asset native dimensions map: assetId -> { width, height } */
  assetDimensions?: Map<string, { width: number; height: number }>;
  /** Current page physical dimensions in mm */
  physicalWidthMm?: number;
  physicalHeightMm?: number;
}

function FieldLabel({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1">
      <span
        className="block text-xs font-semibold uppercase tracking-[0.16em]"
        style={{ color: "var(--color-text-muted)" }}
      >
        {typeof children === "string" ? children : children}
      </span>
    </label>
  );
}

const inputClass = "input";
const selectBtnClass = "btn btn-outline btn-sm";

export default function PropertiesPanel({
  selectedElement,
  onChangeElement,
  onDeleteElement,
  onDuplicateElement,
  onToggleVisibility,
  onToggleLock,
  onBringForward,
  onSendBackward,
  isInstanceMode = false,
  isTemplateAuthor = false,
  guidedTypography = false,
  templateTextOriginal,
  onResetTemplateText,
  assetDimensions,
  physicalWidthMm,
  physicalHeightMm,
}: PropertiesPanelProps) {
  // If in instance mode and the selected element is a template TEXT element,
  // show a simplified editor that only allows editing the text content.
  if (
    selectedElement && isInstanceMode &&
    selectedElement.layer === "template" &&
    selectedElement.type === "text" && !selectedElement.locked &&
    !isProtectedDesign(selectedElement)
  ) {
    const isOverridden = templateTextOriginal !== undefined &&
      selectedElement.text !== templateTextOriginal;
    return (
      <aside className="card space-y-4 p-5">
        <div>
          <p
            className="text-sm font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            Properties
          </p>
          <p className="mt-1 section-label">
            Template Text
          </p>
        </div>

        <div
          className="rounded-xl p-3"
          style={{
            background: "var(--color-info-light)",
            border: "1px solid var(--color-info)",
          }}
        >
          <p
            className="text-xs leading-5"
            style={{ color: "var(--color-secondary)" }}
          >
            Edit this text here and its permitted typography in Book Design. The
            template keeps its position and frame size fixed.
          </p>
        </div>

        <div>
          <FieldLabel>Text</FieldLabel>
          <textarea
            aria-label="Element text"
            value={selectedElement.text}
            onChange={(event) => {
              onChangeElement(selectedElement.id, (element) =>
                element.type === "text"
                  ? {
                    ...element,
                    text: event.target.value,
                  }
                  : element);
            }}
            rows={5}
            className={inputClass}
            style={{ marginTop: "0.25rem", resize: "vertical" }}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {isOverridden
              ? "Modified from template default."
              : "Using template default."}
          </p>
          <button
            type="button"
            disabled={!isOverridden || !onResetTemplateText}
            onClick={() => {
              if (onResetTemplateText && isOverridden) {
                onResetTemplateText(selectedElement.id);
              }
            }}
            className={selectBtnClass}
          >
            Reset to default
          </button>
        </div>
      </aside>
    );
  }

  // If in instance mode and the selected element is a non-text template
  // element, show the locked element message.
  if (
    selectedElement && isInstanceMode && selectedElement.layer === "template"
  ) {
    return (
      <aside className="card p-5">
        <p
          className="text-sm font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          Properties
        </p>
        <div
          className="mt-4 rounded-xl p-4 text-center"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
          }}
        >
          <svg
            className="mx-auto h-8 w-8"
            style={{ color: "var(--color-text-subtle)" }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
          <p
            className="mt-2 text-sm font-medium"
            style={{ color: "var(--color-text-muted)" }}
          >
            Template Element
          </p>
          <p
            className="mt-1 text-xs leading-5"
            style={{ color: "var(--color-text-subtle)" }}
          >
            This element is part of the template and cannot be modified.
          </p>
        </div>
      </aside>
    );
  }

  if (!selectedElement) {
    return (
      <aside className="card p-5">
        <p
          className="text-sm font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          Properties
        </p>
        <p
          className="mt-2 text-sm leading-6"
          style={{ color: "var(--color-text-muted)" }}
        >
          Select an element on the page to edit its content, sizing, and layer
          order.
        </p>
      </aside>
    );
  }

  return (
    <aside className="card space-y-4 p-5">
      <div>
        <p
          className="text-sm font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          Properties
        </p>
        <p className="mt-1 section-label">
          {selectedElement.type}
        </p>
      </div>

      {isTemplateAuthor && (
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Template design permissions
          </summary>
          <label className="mt-3 block text-xs">
            Visual role (not an AI content role)
            <select
              aria-label="Visual role"
              className="input mt-1"
              value={selectedElement.designRole ?? ""}
              onChange={(event) =>
                onChangeElement(
                  selectedElement.id,
                  (element) => ({
                    ...element,
                    designRole: (event.target.value || undefined) as
                      | DesignRole
                      | undefined,
                  }),
                )}
            >
              <option value="">Untagged</option>
              {DESIGN_ROLES.map((role) => <option key={role}>{role}</option>)}
            </select>
          </label>
          {selectedElement.type === "text" && (
            <>
              <p className="mt-3 text-xs">
                Allowed formatting (locked text remains protected)
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {STYLE_PROPERTIES.map((property) => (
                  <label
                    key={property}
                    className="flex items-center gap-1 text-[11px]"
                  >
                    <input
                      type="checkbox"
                      checked={(selectedElement.stylePolicy?.allowed ??
                        STYLE_PROPERTIES).includes(property)}
                      onChange={(event) =>
                        onChangeElement(selectedElement.id, (element) => ({
                          ...element,
                          stylePolicy: {
                            ...element.stylePolicy,
                            allowed: event.target.checked
                              ? [
                                ...new Set([
                                  ...(element.stylePolicy?.allowed ??
                                    STYLE_PROPERTIES),
                                  property,
                                ]),
                              ]
                              : (element.stylePolicy?.allowed ??
                                STYLE_PROPERTIES).filter((key) =>
                                  key !== property
                                ),
                          },
                        }))}
                    />
                    {property}
                  </label>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {(["minFontSize", "maxFontSize"] as const).map((key) => (
                  <label key={key} className="text-xs">
                    {key === "minFontSize" ? "Minimum px" : "Maximum px"}
                    <input
                      aria-label={key}
                      className="input mt-1"
                      type="number"
                      min="12"
                      max="120"
                      value={selectedElement.stylePolicy?.[key] ??
                        (key === "minFontSize" ? 12 : 120)}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (
                          value < 12 || value > 120 ||
                          (key === "minFontSize" &&
                            value >
                              (selectedElement.stylePolicy?.maxFontSize ??
                                120)) ||
                          (key === "maxFontSize" &&
                            value <
                              (selectedElement.stylePolicy?.minFontSize ?? 12))
                        ) return;
                        onChangeElement(
                          selectedElement.id,
                          (element) => ({
                            ...element,
                            stylePolicy: {
                              allowed: [...STYLE_PROPERTIES],
                              ...element.stylePolicy,
                              [key]: value,
                            },
                          }),
                        );
                      }}
                    />
                  </label>
                ))}
              </div>
              {(Object.keys(SPACING_LIMITS) as SpacingProperty[]).map(
                (property) => {
                  const [floor, ceiling] = SPACING_LIMITS[property];
                  const range =
                    selectedElement.stylePolicy?.limits?.[property] ??
                      { min: floor, max: ceiling };
                  return (
                    <fieldset key={property} className="mt-3">
                      <legend className="text-xs">{property} bounds</legend>
                      <div className="grid grid-cols-2 gap-2">
                        {(["min", "max"] as const).map((bound) => (
                          <label key={bound} className="text-xs">
                            {bound}
                            <input
                              aria-label={`${property} ${bound}`}
                              className="input mt-1"
                              type="number"
                              step="0.01"
                              min={floor}
                              max={ceiling}
                              value={range[bound]}
                              onChange={(event) => {
                                const value = Number(event.target.value);
                                if (
                                  !Number.isFinite(value) || value < floor ||
                                  value > ceiling || (bound === "min"
                                    ? value > range.max
                                    : value < range.min)
                                ) return;
                                onChangeElement(
                                  selectedElement.id,
                                  (element) => ({
                                    ...element,
                                    stylePolicy: {
                                      allowed: [...STYLE_PROPERTIES],
                                      ...element.stylePolicy,
                                      limits: {
                                        ...element.stylePolicy?.limits,
                                        [property]: {
                                          ...range,
                                          [bound]: value,
                                        },
                                      },
                                    },
                                  }),
                                );
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  );
                },
              )}
            </>
          )}
          {selectedElement.type === "shape" && (
            <label className="mt-3 block text-xs">
              Palette binding<select
                aria-label="Palette binding"
                className="input mt-1"
                value={selectedElement.paletteBinding ?? ""}
                onChange={(event) =>
                  onChangeElement(
                    selectedElement.id,
                    (element) => ({
                      ...element,
                      paletteBinding: (event.target.value || undefined) as
                        | "ink"
                        | "accent"
                        | undefined,
                    }),
                  )}
              >
                <option value="">Protected original color</option>
                <option value="ink">Ink</option>
                <option value="accent">Accent</option>
              </select>
            </label>
          )}
        </details>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>X</FieldLabel>
          <input
            type="number"
            value={Math.round(selectedElement.x)}
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onChangeElement(selectedElement.id, (element) => ({
                ...element,
                x: Number.isFinite(nextValue) ? nextValue : element.x,
              }));
            }}
            className={inputClass}
          />
        </div>
        <div>
          <FieldLabel>Y</FieldLabel>
          <input
            type="number"
            value={Math.round(selectedElement.y)}
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onChangeElement(selectedElement.id, (element) => ({
                ...element,
                y: Number.isFinite(nextValue) ? nextValue : element.y,
              }));
            }}
            className={inputClass}
          />
        </div>
        <div>
          <FieldLabel>Width</FieldLabel>
          <input
            type="number"
            value={Math.round(selectedElement.width)}
            onChange={(event) => {
              const nextValue = Number(event.target.value);
              onChangeElement(selectedElement.id, (element) => ({
                ...element,
                width: Number.isFinite(nextValue) && nextValue > 0
                  ? nextValue
                  : element.width,
              }));
            }}
            className={inputClass}
          />
        </div>
        {/* Hide Height for line shapes — stroke width controls visual thickness */}
        {!(selectedElement.type === "shape" &&
          selectedElement.shape === "line") && (
          <div>
            <FieldLabel>Height</FieldLabel>
            <input
              type="number"
              value={Math.round(selectedElement.height)}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                onChangeElement(selectedElement.id, (element) => ({
                  ...element,
                  height: Number.isFinite(nextValue) && nextValue > 0
                    ? nextValue
                    : element.height,
                }));
              }}
              className={inputClass}
            />
          </div>
        )}
      </div>

      <div>
        <FieldLabel>Rotation</FieldLabel>
        <input
          type="range"
          min="-180"
          max="180"
          value={Math.round(selectedElement.rotation)}
          onChange={(event) => {
            onChangeElement(selectedElement.id, (element) => ({
              ...element,
              rotation: Number(event.target.value),
            }));
          }}
          className="mt-2 w-full"
          style={{ accentColor: "var(--color-primary)" }}
        />
      </div>

      <div>
        <FieldLabel>Opacity</FieldLabel>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={selectedElement.opacity}
          onChange={(event) => {
            onChangeElement(selectedElement.id, (element) => ({
              ...element,
              opacity: Number(event.target.value),
            }));
          }}
          className="mt-2 w-full"
          style={{ accentColor: "var(--color-primary)" }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onToggleVisibility(selectedElement.id)}
          className={selectBtnClass}
        >
          {selectedElement.visible ? "Hide Layer" : "Show Layer"}
        </button>
        <button
          type="button"
          onClick={() => onToggleLock(selectedElement.id)}
          className={selectBtnClass}
        >
          {selectedElement.locked ? "Unlock Layer" : "Lock Layer"}
        </button>
      </div>

      {selectedElement.type === "text"
        ? (
          <>
            <div>
              <FieldLabel>Text</FieldLabel>
              <textarea
                aria-label="Element text"
                value={selectedElement.text}
                onChange={(event) => {
                  onChangeElement(selectedElement.id, (element) =>
                    element.type === "text"
                      ? {
                        ...element,
                        text: event.target.value,
                      }
                      : element);
                }}
                rows={5}
                className={inputClass}
                style={{ resize: "vertical" }}
              />
            </div>

            {!guidedTypography && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel>Font Size</FieldLabel>
                  <input
                    type="number"
                    value={selectedElement.fontSize}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      onChangeElement(selectedElement.id, (element) =>
                        element.type === "text" &&
                          Number.isFinite(nextValue) &&
                          nextValue > 0
                          ? {
                            ...element,
                            fontSize: nextValue,
                          }
                          : element);
                    }}
                    className={inputClass}
                  />
                </div>
                <div>
                  <FieldLabel>Color</FieldLabel>
                  <ColorPicker
                    value={selectedElement.color}
                    onChange={(color) => {
                      onChangeElement(selectedElement.id, (element) =>
                        element.type === "text"
                          ? {
                            ...element,
                            color: color,
                          }
                          : element);
                    }}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </>
        )
        : null}

      {selectedElement.type === "shape"
        ? (
          <>
            <div>
              <p
                className="text-sm font-semibold"
                style={{ color: "var(--color-text)" }}
              >
                Shape Style
              </p>
              <p className="mt-1 section-label">
                {selectedElement.shape}
              </p>
            </div>

            <div>
              <FieldLabel>Fill Color</FieldLabel>
              <ColorPicker
                value={selectedElement.fill === "transparent"
                  ? "#ffffff"
                  : selectedElement.fill}
                onChange={(color) => {
                  onChangeElement(selectedElement.id, (element) =>
                    element.type === "shape"
                      ? {
                        ...element,
                        fill: color === "transparent" ? "transparent" : color,
                      }
                      : element);
                }}
                className="w-full"
                showTransparent
              />
            </div>

            <div>
              <FieldLabel>Stroke Color</FieldLabel>
              <ColorPicker
                value={selectedElement.stroke ?? "#000000"}
                onChange={(color) => {
                  onChangeElement(selectedElement.id, (element) =>
                    element.type === "shape"
                      ? {
                        ...element,
                        stroke: color,
                      }
                      : element);
                }}
                className="w-full"
              />
            </div>

            <div>
              <FieldLabel>Stroke Width</FieldLabel>
              <input
                type="range"
                min="0"
                max="20"
                step="1"
                value={selectedElement.strokeWidth ?? 0}
                onChange={(event) => {
                  onChangeElement(selectedElement.id, (element) =>
                    element.type === "shape"
                      ? {
                        ...element,
                        strokeWidth: Number(event.target.value),
                      }
                      : element);
                }}
                className="mt-2 w-full"
                style={{ accentColor: "var(--color-primary)" }}
              />
            </div>
          </>
        )
        : null}

      {selectedElement.type === "image"
        ? (
          <>
            {/* DPI indicator */}
            {(() => {
              if (
                !assetDimensions || !physicalWidthMm || !physicalHeightMm
              ) return null;
              const dims = assetDimensions.get(selectedElement.assetId);
              if (!dims) return null;
              const dpi = getElementDpi(
                selectedElement,
                dims.width,
                dims.height,
                physicalWidthMm,
                physicalHeightMm,
              );
              const isLow = dpi < DPI_HARD_THRESHOLD;
              const isWarning = dpi >= DPI_HARD_THRESHOLD &&
                dpi < DPI_WARNING_THRESHOLD;
              return (
                <div
                  className="flex items-center gap-2 rounded-lg px-3 py-2"
                  style={{
                    background: isLow
                      ? "var(--color-error-light, #FEE2E2)"
                      : isWarning
                      ? "var(--color-accent-light, #FEF3C7)"
                      : "var(--color-success-light, #DCFCE7)",
                    border: `1px solid ${
                      isLow ? "#FCA5A5" : isWarning ? "#FCD34D" : "#86EFAC"
                    }`,
                  }}
                >
                  <span
                    className="text-xs font-bold"
                    style={{
                      color: isLow
                        ? "#991B1B"
                        : isWarning
                        ? "#92400E"
                        : "#065F46",
                    }}
                  >
                    ~{dpi} DPI
                  </span>
                  <span
                    className="text-xs"
                    style={{
                      color: isLow
                        ? "#B91C1C"
                        : isWarning
                        ? "#B45309"
                        : "#047857",
                    }}
                  >
                    {isLow
                      ? "Very low resolution — may print poorly"
                      : isWarning
                      ? "Low resolution — may not be sharp"
                      : "Good print quality"}
                  </span>
                </div>
              );
            })()}

            <div>
              <p
                className="text-sm font-semibold"
                style={{ color: "var(--color-text)" }}
              >
                Crop
              </p>
              <p
                className="mt-1 text-xs leading-5"
                style={{ color: "var(--color-text-muted)" }}
              >
                Adjust zoom and focal point inside the image frame.
              </p>
            </div>

            <div>
              <FieldLabel>Zoom</FieldLabel>
              <input
                type="range"
                min="1"
                max="4"
                step="0.05"
                value={selectedElement.crop.scaleX}
                onChange={(event) => {
                  const zoom = getNormalizedZoomValue(
                    Number(event.target.value),
                  );
                  onChangeElement(selectedElement.id, (element) =>
                    element.type === "image"
                      ? {
                        ...element,
                        crop: {
                          ...element.crop,
                          scaleX: zoom,
                          scaleY: zoom,
                        },
                      }
                      : element);
                }}
                className="mt-2 w-full"
                style={{ accentColor: "var(--color-primary)" }}
              />
            </div>

            <div>
              <FieldLabel>Horizontal Focus</FieldLabel>
              <input
                type="range"
                min="-100"
                max="100"
                step="1"
                value={Math.round(selectedElement.crop.x * 100)}
                onChange={(event) => {
                  const nextValue = getNormalizedCropValue(
                    Number(event.target.value) / 100,
                  );
                  onChangeElement(selectedElement.id, (element) =>
                    element.type === "image"
                      ? {
                        ...element,
                        crop: {
                          ...element.crop,
                          x: nextValue,
                        },
                      }
                      : element);
                }}
                className="mt-2 w-full"
                style={{ accentColor: "var(--color-primary)" }}
              />
            </div>

            <div>
              <FieldLabel>Vertical Focus</FieldLabel>
              <input
                type="range"
                min="-100"
                max="100"
                step="1"
                value={Math.round(selectedElement.crop.y * 100)}
                onChange={(event) => {
                  const nextValue = getNormalizedCropValue(
                    Number(event.target.value) / 100,
                  );
                  onChangeElement(selectedElement.id, (element) =>
                    element.type === "image"
                      ? {
                        ...element,
                        crop: {
                          ...element.crop,
                          y: nextValue,
                        },
                      }
                      : element);
                }}
                className="mt-2 w-full"
                style={{ accentColor: "var(--color-primary)" }}
              />
            </div>

            <button
              type="button"
              onClick={() => {
                onChangeElement(selectedElement.id, (element) =>
                  element.type === "image"
                    ? {
                      ...element,
                      crop: {
                        x: 0,
                        y: 0,
                        scaleX: 1,
                        scaleY: 1,
                      },
                    }
                    : element);
              }}
              className="btn btn-outline w-full"
            >
              Reset Crop
            </button>
          </>
        )
        : null}

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() =>
            onDuplicateElement(selectedElement.id)}
          className={selectBtnClass}
        >
          Duplicate
        </button>
        <button
          type="button"
          onClick={() =>
            onSendBackward(selectedElement.id)}
          className={selectBtnClass}
        >
          Send Back
        </button>
        <button
          type="button"
          onClick={() => onBringForward(selectedElement.id)}
          className={selectBtnClass}
        >
          Bring Front
        </button>
      </div>

      <button
        type="button"
        onClick={() => onDeleteElement(selectedElement.id)}
        className="btn btn-danger w-full"
      >
        Delete Element
      </button>
    </aside>
  );
}
