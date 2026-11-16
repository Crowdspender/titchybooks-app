"use client";

import { useEffect, useRef } from "react";
import {
  PAGE_LABEL_DISPLAY,
  PAGE_READING_ORDER,
  type PageLabel,
} from "@/lib/constants";

interface PageFilmstripProps {
  activePageLabel: PageLabel;
  thumbnails: Record<PageLabel, string | null>;
  elementCounts: Record<PageLabel, number>;
  disabled?: boolean;
  onSelect: (pageLabel: PageLabel) => void;
}

/**
 * Horizontal strip of all eight booklet pages in reading order. Keeps the
 * accessible contract of the former vertical page list: each tile is a
 * button named "Edit {page}" with aria-current marking the active page.
 */
export default function PageFilmstrip({
  activePageLabel,
  thumbnails,
  elementCounts,
  disabled = false,
  onSelect,
}: PageFilmstripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Partial<Record<PageLabel, HTMLButtonElement | null>>>(
    {},
  );

  // Keep the active tile in view horizontally without scrolling the page.
  useEffect(() => {
    const strip = stripRef.current;
    const item = itemRefs.current[activePageLabel];
    if (!strip || !item) return;
    const left = item.offsetLeft - strip.offsetLeft;
    const target = left - (strip.clientWidth - item.clientWidth) / 2;
    strip.scrollTo({
      left: Math.max(0, target),
      behavior: "smooth",
    });
  }, [activePageLabel]);

  return (
    <nav aria-label="Book pages" className="card p-3">
      <div
        ref={stripRef}
        className="flex gap-2 overflow-x-auto pb-1"
        style={{ scrollSnapType: "x proximity" }}
      >
        {PAGE_READING_ORDER.map((pageLabel, index) => {
          const isActive = pageLabel === activePageLabel;
          const thumbnail = thumbnails[pageLabel];
          return (
            <button
              key={pageLabel}
              ref={(node) => {
                itemRefs.current[pageLabel] = node;
              }}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(pageLabel)}
              aria-label={`Edit ${PAGE_LABEL_DISPLAY[pageLabel]}`}
              aria-current={isActive ? "page" : undefined}
              className="shrink-0 rounded-xl p-2 text-left transition"
              style={{
                width: "104px",
                scrollSnapAlign: "center",
                border: isActive
                  ? "2px solid var(--color-primary)"
                  : "1px solid var(--color-border)",
                background: isActive
                  ? "var(--color-primary-muted)"
                  : "var(--color-surface)",
                color: isActive
                  ? "var(--color-primary)"
                  : "var(--color-text)",
                opacity: disabled && !isActive ? 0.6 : 1,
              }}
            >
              <div
                className="mb-1.5 overflow-hidden rounded-md"
                style={{ border: "1px solid var(--color-border)" }}
              >
                {thumbnail
                  ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbnail}
                      alt={`${PAGE_LABEL_DISPLAY[pageLabel]} preview`}
                      className="h-16 w-full object-contain"
                    />
                  )
                  : (
                    <div
                      className="flex h-16 items-center justify-center text-[10px]"
                      style={{
                        background: "var(--color-surface)",
                        color: "var(--color-text-subtle)",
                      }}
                    >
                      No content
                    </div>
                  )}
              </div>
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-xs font-semibold">
                  {PAGE_LABEL_DISPLAY[pageLabel]}
                </span>
                <span
                  className="text-[10px] tabular-nums"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {index + 1}/8
                </span>
              </div>
              <p
                className="text-[10px]"
                style={{ color: "var(--color-text-muted)" }}
              >
                {elementCounts[pageLabel]} element
                {elementCounts[pageLabel] === 1 ? "" : "s"}
              </p>
            </button>
          );
        })}
      </div>
    </nav>
  );
}