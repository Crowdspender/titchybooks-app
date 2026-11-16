"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  PAGE_LABEL_DISPLAY,
  PAGE_READING_ORDER,
  type PageLabel,
} from "@/lib/constants";
import type { EditorScene } from "@/lib/editor/schema";
import {
  renderPageThumbnail,
  type ThumbnailAsset,
} from "@/lib/editor/page-thumbnail";

interface BookletPreviewProps {
  open: boolean;
  title: string;
  pages: Record<PageLabel, { scene: EditorScene; error: string }>;
  assets: ThumbnailAsset[];
  onClose: () => void;
  onJumpToPage: (pageLabel: PageLabel) => void;
}

const PREVIEW_WIDTH_PX = 300;

/**
 * Whole-booklet overview: all eight pages in reading order, rendered with
 * the same design-resolved scenes the editor shows. Clicking a page closes
 * the preview and jumps straight to that page in the editor.
 */
export default function BookletPreview({
  open,
  title,
  pages,
  assets,
  onClose,
  onJumpToPage,
}: BookletPreviewProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Pure derivation from the resolved scenes; the dialog only mounts on the
  // client, so the offscreen-canvas renders are safe to memoize.
  const previews = useMemo(() => {
    if (!open) return {} as Partial<Record<PageLabel, string | null>>;
    const next: Partial<Record<PageLabel, string | null>> = {};
    for (const label of PAGE_READING_ORDER) {
      const entry = pages[label];
      next[label] = entry.error
        ? null
        : renderPageThumbnail(entry.scene, assets, PREVIEW_WIDTH_PX);
    }
    return next;
  }, [open, pages, assets]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // Keep keyboard focus inside the dialog while it is open.
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => !node.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{ background: "rgba(15, 19, 28, 0.55)", backdropFilter: "blur(3px)" }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="booklet-preview-heading"
        className="card flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden"
        style={{ background: "var(--color-surface-raised)" }}
      >
        <div
          className="flex items-start justify-between gap-4 border-b p-5"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <p className="section-label">Booklet preview</p>
            <h2
              id="booklet-preview-heading"
              className="mt-1 text-xl font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {title.trim() || "Untitled Titchybooks"}
            </h2>
            <p
              className="mt-1 text-sm"
              style={{ color: "var(--color-text-muted)" }}
            >
              All eight pages in reading order. Select a page to keep editing
              it. Print-sheet imposition is handled when the PDF is generated.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="btn btn-outline btn-sm"
          >
            Close
          </button>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-4 overflow-y-auto p-5 md:grid-cols-4">
          {PAGE_READING_ORDER.map((label, index) => {
            const entry = pages[label];
            const preview = previews[label];
            return (
              <button
                key={label}
                type="button"
                onClick={() => onJumpToPage(label)}
                aria-label={`Go to ${PAGE_LABEL_DISPLAY[label]}`}
                className="group rounded-xl p-3 text-left transition"
                style={{
                  border: "1px solid var(--color-border)",
                  background: "var(--color-surface)",
                }}
              >
                <div
                  className="overflow-hidden rounded-lg"
                  style={{ border: "1px solid var(--color-border)" }}
                >
                  {entry.error
                    ? (
                      <div
                        className="flex aspect-[7/10] items-center justify-center p-3 text-center text-xs"
                        style={{
                          background: "var(--color-error-light)",
                          color: "#991B1B",
                        }}
                      >
                        {entry.error}
                      </div>
                    )
                    : preview
                    ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={preview}
                        alt={`${PAGE_LABEL_DISPLAY[label]} booklet preview`}
                        className="aspect-[7/10] w-full object-contain"
                      />
                    )
                    : (
                      <div
                        className="flex aspect-[7/10] items-center justify-center text-xs"
                        style={{
                          background: "var(--color-surface)",
                          color: "var(--color-text-subtle)",
                        }}
                      >
                        Rendering…
                      </div>
                    )}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span
                    className="text-sm font-semibold"
                    style={{ color: "var(--color-text)" }}
                  >
                    {PAGE_LABEL_DISPLAY[label]}
                  </span>
                  <span
                    className="text-xs tabular-nums"
                    style={{ color: "var(--color-text-muted)" }}
                  >
                    {index + 1}/8
                  </span>
                </div>
                <span
                  className="text-xs opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100"
                  style={{ color: "var(--color-primary)" }}
                >
                  Edit this page →
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}