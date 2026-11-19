"use client";

import { useState } from "react";

/** Ordinary links let the browser own the transfer; JavaScript cannot confirm a disk save. */
export default function PdfDownloads(
  {
    submissionId,
    printAvailable,
    readingAvailable,
    basePath,
    className = "btn btn-outline btn-sm",
  }: {
    submissionId: string;
    printAvailable: boolean;
    readingAvailable: boolean;
    basePath?: string;
    className?: string;
  },
) {
  const [requested, setRequested] = useState(false);
  const base = basePath ??
    `/api/submissions/${encodeURIComponent(submissionId)}/downloads`;
  const previewKind = readingAvailable ? "reading" : "print";
  return (
    <div
      className="min-w-0 max-w-full space-y-2"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-2">
        {printAvailable && (
          <a
            href={`${base}?kind=print`}
            className={className}
            onClick={() => setRequested(true)}
          >
            Download print sheet
          </a>
        )}
        {readingAvailable && (
          <a
            href={`${base}?kind=reading`}
            className={className}
            onClick={() => setRequested(true)}
          >
            Download reading PDF
          </a>
        )}
        {(printAvailable || readingAvailable) && (
          <a
            href={`${base}?kind=${previewKind}&disposition=inline`}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
          >
            Preview {previewKind === "reading" ? "reading PDF" : "print sheet"}
          </a>
        )}
      </div>
      {requested && (
        <p role="status" className="text-xs">
          Download requested—check your browser downloads. If it failed, retry
          the download link.
        </p>
      )}
      {printAvailable && !readingAvailable && (
        <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          Reading PDF unavailable for this book.
        </p>
      )}
      {!printAvailable && readingAvailable && (
        <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          Print sheet unavailable for this book.
        </p>
      )}
      {!printAvailable && !readingAvailable && (
        <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          PDF artifacts unavailable.
        </p>
      )}
    </div>
  );
}
