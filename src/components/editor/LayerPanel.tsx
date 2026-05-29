"use client";

import type { EditorElement } from "@/lib/editor/schema";

interface LayerPanelProps {
  elements: EditorElement[];
  templateElements: EditorElement[];
  selectedElementId: string | null;
  onSelectElement: (elementId: string) => void;
  onToggleVisibility: (elementId: string) => void;
  onToggleLock: (elementId: string) => void;
  onDuplicateElement: (elementId: string) => void;
  onDeleteElement: (elementId: string) => void;
  isInstanceMode?: boolean;
}

function getLayerTitle(element: EditorElement, index: number): string {
  if (element.type === "text") {
    const trimmed = element.text.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 28) : `Text ${index + 1}`;
  }

  if (element.type === "image") {
    return `Image ${index + 1}`;
  }

  return `Shape ${index + 1}`;
}

export default function LayerPanel({
  elements,
  templateElements,
  selectedElementId,
  onSelectElement,
  onToggleVisibility,
  onToggleLock,
  onDuplicateElement,
  onDeleteElement,
  isInstanceMode = false,
}: LayerPanelProps) {
  const orderedUserElements = elements
    .slice()
    .sort((left, right) => right.zIndex - left.zIndex);

  const orderedTemplateElements = templateElements
    .slice()
    .sort((left, right) => right.zIndex - left.zIndex);

  const hasTemplateElements = isInstanceMode &&
    orderedTemplateElements.length > 0;
  const totalElements = elements.length +
    (isInstanceMode ? templateElements.length : 0);

  return (
    <aside className="card p-5">
      <div className="flex items-center justify-between">
        <p
          className="text-sm font-semibold"
          style={{ color: "var(--color-text)" }}
        >
          Layers
        </p>
        <span className="section-label">
          {totalElements} total
        </span>
      </div>

      {totalElements === 0
        ? (
          <p
            className="mt-3 text-sm leading-6"
            style={{ color: "var(--color-text-muted)" }}
          >
            Add text boxes or images to populate this page&apos;s layer stack.
          </p>
        )
        : (
          <div className="mt-4 space-y-2">
            {/* Template Elements Section */}
            {hasTemplateElements && (
              <>
                <p className="section-label">
                  Template Elements
                </p>
                {orderedTemplateElements.map((element, index) => {
                  const isTextEditable = element.type === "text";
                  const isSelected = selectedElementId === element.id;
                  return (
                    <TemplateLayerItem
                      key={element.id}
                      element={element}
                      index={index}
                      isSelected={isSelected}
                      isTextEditable={isTextEditable}
                      onSelect={() => onSelectElement(element.id)}
                    />
                  );
                })}
                <div className="divider my-2" />
                <p className="section-label">
                  Your Elements
                </p>
              </>
            )}

            {/* User Elements Section */}
            {orderedUserElements.map((element, index) => {
              const isSelected = element.id === selectedElementId;

              return (
                <div
                  key={element.id}
                  className="rounded-xl p-3 transition"
                  style={{
                    border: isSelected
                      ? "2px solid var(--color-primary)"
                      : "1px solid var(--color-border)",
                    background: isSelected
                      ? "var(--color-primary-muted)"
                      : "var(--color-surface)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelectElement(element.id)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <div className="min-w-0">
                      <p
                        className="truncate text-sm font-semibold"
                        style={{ color: "var(--color-text)" }}
                      >
                        {getLayerTitle(element, index)}
                      </p>
                      <p className="mt-1 section-label">
                        {element.type}
                      </p>
                    </div>
                    <span
                      className="text-xs"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      z{element.zIndex}
                    </span>
                  </button>

                  <div className="mt-3 grid grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => onToggleVisibility(element.id)}
                      className="btn btn-outline btn-sm"
                      style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
                    >
                      {element.visible ? "Hide" : "Show"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleLock(element.id)}
                      className="btn btn-outline btn-sm"
                      style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
                    >
                      {element.locked ? "Unlock" : "Lock"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDuplicateElement(element.id)}
                      className="btn btn-outline btn-sm"
                      style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteElement(element.id)}
                      className="btn btn-sm"
                      style={{
                        fontSize: "0.75rem",
                        padding: "0.25rem 0.5rem",
                        border: "1px solid var(--color-error-light)",
                        color: "var(--color-error)",
                        background: "transparent",
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </aside>
  );
}

function TemplateLayerItem({
  element,
  index,
  isSelected,
  isTextEditable,
  onSelect,
}: {
  element: EditorElement;
  index: number;
  isSelected: boolean;
  isTextEditable: boolean;
  onSelect: () => void;
}) {
  const commonStyle = {
    border: isSelected
      ? "2px solid var(--color-info)"
      : "1px solid var(--color-border)",
    background: isSelected ? "var(--color-info-light)" : "var(--color-surface)",
    opacity: isTextEditable ? 1 : 0.7,
  };

  const body = (
    <div className="flex items-center justify-between">
      <div className="min-w-0">
        <p
          className="truncate text-sm font-medium"
          style={{
            color: isTextEditable
              ? "var(--color-text)"
              : "var(--color-text-muted)",
          }}
        >
          {getLayerTitle(element, index)}
        </p>
        <p className="mt-1 section-label">
          {isTextEditable ? `${element.type} · editable text` : element.type}
        </p>
      </div>
      <svg
        className="h-4 w-4"
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
    </div>
  );

  if (isTextEditable) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className="w-full rounded-xl p-3 text-left transition"
        style={commonStyle}
      >
        {body}
      </button>
    );
  }

  return (
    <div className="rounded-xl p-3 transition" style={commonStyle}>
      {body}
    </div>
  );
}
