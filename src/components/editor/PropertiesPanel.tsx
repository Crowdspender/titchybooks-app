"use client";

import {
  getNormalizedCropValue,
  getNormalizedZoomValue,
} from "@/lib/editor/crop";
import type { EditorElement } from "@/lib/editor/schema";
import type { RenderableEditorElement } from "@/lib/editor/template-types";

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
  /** Original (non-overridden) text of the selected template text element. */
  templateTextOriginal?: string;
  /** Clears the per-instance text override, restoring template default. */
  onResetTemplateText?: (elementId: string) => void;
}

function FieldLabel({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1 text-xs font-medium uppercase tracking-[0.16em] text-stone-500">
      <span>{children}</span>
    </label>
  );
}

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
  templateTextOriginal,
  onResetTemplateText,
}: PropertiesPanelProps) {
  // If in instance mode and the selected element is a template TEXT element,
  // show a simplified editor that only allows editing the text content.
  // The template layer's position, size, and styling remain fixed.
  if (
    selectedElement && isInstanceMode &&
    selectedElement.layer === "template" &&
    selectedElement.type === "text"
  ) {
    const isOverridden = templateTextOriginal !== undefined &&
      selectedElement.text !== templateTextOriginal;
    return (
      <aside className="space-y-4 rounded-[24px] border border-stone-300 bg-white p-5 shadow-sm">
        <div>
          <p className="text-sm font-semibold text-stone-800">Properties</p>
          <p className="mt-1 text-xs uppercase tracking-[0.18em] text-stone-500">
            Template Text
          </p>
        </div>

        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3">
          <p className="text-xs leading-5 text-blue-700">
            You can edit the text content of this template element. Its
            position, size, and styling are fixed by the template.
          </p>
        </div>

        <FieldLabel>
          Text
          <textarea
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
            className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm text-stone-800"
          />
        </FieldLabel>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-stone-500">
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
            className="rounded-full border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-stone-300 disabled:hover:bg-transparent"
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
      <aside className="rounded-[24px] border border-stone-300 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-stone-800">Properties</p>
        <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-50 p-4 text-center">
          <svg
            className="mx-auto h-8 w-8 text-stone-400"
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
          <p className="mt-2 text-sm font-medium text-stone-600">
            Template Element
          </p>
          <p className="mt-1 text-xs leading-5 text-stone-500">
            This element is part of the template and cannot be modified.
          </p>
        </div>
      </aside>
    );
  }

  if (!selectedElement) {
    return (
      <aside className="rounded-[24px] border border-stone-300 bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-stone-700">Properties</p>
        <p className="mt-2 text-sm leading-6 text-stone-500">
          Select an element on the page to edit its content, sizing, and layer
          order.
        </p>
      </aside>
    );
  }

  return (
    <aside className="space-y-4 rounded-[24px] border border-stone-300 bg-white p-5 shadow-sm">
      <div>
        <p className="text-sm font-semibold text-stone-800">Properties</p>
        <p className="mt-1 text-xs uppercase tracking-[0.18em] text-stone-500">
          {selectedElement.type}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FieldLabel>
          X
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
            className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm text-stone-800"
          />
        </FieldLabel>
        <FieldLabel>
          Y
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
            className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm text-stone-800"
          />
        </FieldLabel>
        <FieldLabel>
          Width
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
            className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm text-stone-800"
          />
        </FieldLabel>
        {/* Hide Height for line shapes — stroke width controls visual thickness */}
        {!(selectedElement.type === "shape" &&
          selectedElement.shape === "line") && (
          <FieldLabel>
            Height
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
              className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm text-stone-800"
            />
          </FieldLabel>
        )}
      </div>

      <FieldLabel>
        Rotation
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
          className="mt-2 w-full accent-blue-600"
        />
      </FieldLabel>

      <FieldLabel>
        Opacity
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
          className="mt-2 w-full accent-blue-600"
        />
      </FieldLabel>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onToggleVisibility(selectedElement.id)}
          className="rounded-full border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50"
        >
          {selectedElement.visible ? "Hide Layer" : "Show Layer"}
        </button>
        <button
          type="button"
          onClick={() => onToggleLock(selectedElement.id)}
          className="rounded-full border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50"
        >
          {selectedElement.locked ? "Unlock Layer" : "Lock Layer"}
        </button>
      </div>

      {selectedElement.type === "text"
        ? (
          <>
            <FieldLabel>
              Text
              <textarea
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
                className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm text-stone-800"
              />
            </FieldLabel>

            <div className="grid grid-cols-2 gap-3">
              <FieldLabel>
                Font Size
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
                  className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm text-stone-800"
                />
              </FieldLabel>
              <FieldLabel>
                Color
                <input
                  type="color"
                  value={selectedElement.color}
                  onChange={(event) => {
                    onChangeElement(selectedElement.id, (element) =>
                      element.type === "text"
                        ? {
                          ...element,
                          color: event.target.value,
                        }
                        : element);
                  }}
                  className="mt-1 h-11 w-full rounded-xl border border-stone-300 bg-white px-2"
                />
              </FieldLabel>
            </div>
          </>
        )
        : null}

      {selectedElement.type === "shape"
        ? (
          <>
            <div>
              <p className="text-sm font-semibold text-stone-800">
                Shape Style
              </p>
              <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">
                {selectedElement.shape}
              </p>
            </div>

            <FieldLabel>
              Fill Color
              <input
                type="color"
                value={selectedElement.fill === "transparent"
                  ? "#ffffff"
                  : selectedElement.fill}
                onChange={(event) => {
                  onChangeElement(selectedElement.id, (element) =>
                    element.type === "shape"
                      ? {
                        ...element,
                        fill: event.target.value,
                      }
                      : element);
                }}
                className="mt-1 h-11 w-full rounded-xl border border-stone-300 bg-white px-2"
              />
            </FieldLabel>

            <FieldLabel>
              Stroke Color
              <input
                type="color"
                value={selectedElement.stroke ?? "#000000"}
                onChange={(event) => {
                  onChangeElement(selectedElement.id, (element) =>
                    element.type === "shape"
                      ? {
                        ...element,
                        stroke: event.target.value,
                      }
                      : element);
                }}
                className="mt-1 h-11 w-full rounded-xl border border-stone-300 bg-white px-2"
              />
            </FieldLabel>

            <FieldLabel>
              Stroke Width
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
                className="mt-2 w-full accent-blue-600"
              />
            </FieldLabel>
          </>
        )
        : null}

      {selectedElement.type === "image"
        ? (
          <>
            <div>
              <p className="text-sm font-semibold text-stone-800">Crop</p>
              <p className="mt-1 text-xs leading-5 text-stone-500">
                Adjust zoom and focal point inside the image frame.
              </p>
            </div>

            <FieldLabel>
              Zoom
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
                className="mt-2 w-full accent-blue-600"
              />
            </FieldLabel>

            <FieldLabel>
              Horizontal Focus
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
                className="mt-2 w-full accent-blue-600"
              />
            </FieldLabel>

            <FieldLabel>
              Vertical Focus
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
                className="mt-2 w-full accent-blue-600"
              />
            </FieldLabel>

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
              className="w-full rounded-full border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50"
            >
              Reset Crop
            </button>
          </>
        )
        : null}

      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => onDuplicateElement(selectedElement.id)}
          className="rounded-full border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50"
        >
          Duplicate
        </button>
        <button
          type="button"
          onClick={() => onSendBackward(selectedElement.id)}
          className="rounded-full border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50"
        >
          Send Back
        </button>
        <button
          type="button"
          onClick={() => onBringForward(selectedElement.id)}
          className="rounded-full border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:bg-stone-50"
        >
          Bring Front
        </button>
      </div>

      <button
        type="button"
        onClick={() => onDeleteElement(selectedElement.id)}
        className="w-full rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700"
      >
        Delete Element
      </button>
    </aside>
  );
}
