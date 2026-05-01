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
    <aside className="rounded-[24px] border border-stone-300 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-stone-800">Layers</p>
        <span className="text-xs uppercase tracking-[0.18em] text-stone-500">
          {totalElements} total
        </span>
      </div>

      {totalElements === 0
        ? (
          <p className="mt-3 text-sm leading-6 text-stone-500">
            Add text boxes or images to populate this page&apos;s layer stack.
          </p>
        )
        : (
          <div className="mt-4 space-y-2">
            {/* Template Elements Section */}
            {hasTemplateElements && (
              <>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-400">
                  Template Elements
                </p>
                {orderedTemplateElements.map((element, index) => {
                  const isTextEditable = element.type === "text";
                  const isSelected = selectedElementId === element.id;
                  const commonClass = `rounded-2xl border p-3 transition ${
                    isSelected
                      ? "border-blue-500 bg-blue-50"
                      : "border-stone-200 bg-stone-50/50 opacity-70"
                  }`;
                  const body = (
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p
                          className={`truncate text-sm font-medium ${
                            isTextEditable ? "text-stone-700" : "text-stone-600"
                          }`}
                        >
                          {getLayerTitle(element, index)}
                        </p>
                        <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-400">
                          {isTextEditable
                            ? `${element.type} · editable text`
                            : element.type}
                        </p>
                      </div>
                      <svg
                        className="h-4 w-4 text-stone-400"
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
                        key={element.id}
                        type="button"
                        onClick={() => onSelectElement(element.id)}
                        className={`w-full text-left ${commonClass}`}
                      >
                        {body}
                      </button>
                    );
                  }

                  return (
                    <div key={element.id} className={commonClass}>
                      {body}
                    </div>
                  );
                })}
                <div className="border-t border-stone-200 my-2" />
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
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
                  className={`rounded-2xl border p-3 transition ${
                    isSelected
                      ? "border-blue-500 bg-blue-50"
                      : "border-stone-300 bg-stone-50"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectElement(element.id)}
                    className="flex w-full items-center justify-between gap-3 text-left"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-stone-800">
                        {getLayerTitle(element, index)}
                      </p>
                      <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">
                        {element.type}
                      </p>
                    </div>
                    <span className="text-xs text-stone-500">
                      z{element.zIndex}
                    </span>
                  </button>

                  <div className="mt-3 grid grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => onToggleVisibility(element.id)}
                      className="rounded-full border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 transition hover:border-stone-400 hover:bg-white"
                    >
                      {element.visible ? "Hide" : "Show"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleLock(element.id)}
                      className="rounded-full border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 transition hover:border-stone-400 hover:bg-white"
                    >
                      {element.locked ? "Unlock" : "Lock"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDuplicateElement(element.id)}
                      className="rounded-full border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 transition hover:border-stone-400 hover:bg-white"
                    >
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteElement(element.id)}
                      className="rounded-full border border-red-200 px-2 py-1 text-xs font-medium text-red-700 transition hover:bg-red-50"
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
