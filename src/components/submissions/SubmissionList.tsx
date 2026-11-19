"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import RenderProgress from "./RenderProgress";
import { toast } from "sonner";
import StatusBadge from "./StatusBadge";
import PdfDownloads from "./PdfDownloads";
import OpenInEditorButton from "./OpenInEditorButton";
import { draftPointerStorage } from "@/lib/editor/persistence";

interface Submission {
  id: string;
  title: string | null;
  mode: string;
  status: string;
  pdfS3Key: string | null;
  readingPdfS3Key: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export default function SubmissionList() {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadInFlight = useRef(false);
  const deletedIds = useRef(new Set<string>());

  useEffect(() => {
    fetchSubmissions();
  }, []);

  async function fetchSubmissions() {
    // One list request in flight: a second retry cannot race an older
    // snapshot over a newer one.
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    try {
      const res = await fetch("/api/submissions", { cache: "no-store" });
      // Non-OK statuses are handled before parsing: a 401 with an empty or
      // non-JSON body must still surface the sign-in guidance.
      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? "Sign in again to load your library."
            : "Could not refresh submissions. Your books have not been changed.",
        );
      }
      const data = await res.json();
      if (!Array.isArray(data.submissions)) {
        throw new Error(
          "Could not refresh submissions. Your books have not been changed.",
        );
      }
      // A snapshot taken before a deletion must not restore the deleted draft.
      setSubmissions(
        data.submissions.filter(
          (sub: Submission) => !deletedIds.current.has(sub.id),
        ),
      );
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not refresh submissions. Retry loading your library.",
      );
    } finally {
      loadInFlight.current = false;
      setLoading(false);
    }
  }

  async function handleDelete(submissionId: string) {
    if (
      !confirm(
        "Are you sure you want to delete this draft? This action cannot be undone.",
      )
    ) {
      return;
    }

    try {
      const response = await fetch(`/api/submissions/${submissionId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete submission");
      }

      // Tombstone the deletion so any in-flight or later snapshot cannot
      // restore the card.
      deletedIds.current.add(submissionId);
      setSubmissions((current) =>
        current.filter((sub) => sub.id !== submissionId)
      );

      const ACTIVE_DRAFT_STORAGE_KEY = "titchybook-active-editor-draft";
      const storedDraftId = draftPointerStorage.getItem(
        ACTIVE_DRAFT_STORAGE_KEY,
      );
      if (storedDraftId === submissionId) {
        draftPointerStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
        window.dispatchEvent(new Event("storage"));
      }

      toast.success("Draft deleted successfully");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete failed");
    }
  }

  if (loading) {
    return (
      <div
        className="space-y-3"
        role="status"
        aria-label="Loading your library"
      >
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="card p-5 animate-pulse"
            style={{ background: "var(--color-border)" }}
          >
            <div className="flex items-center gap-3">
              <div
                className="h-4 w-32 rounded"
                style={{ background: "var(--color-border-strong)" }}
              />
              <div
                className="h-5 w-16 rounded-full"
                style={{ background: "var(--color-border-strong)" }}
              />
            </div>
            <div
              className="mt-2 h-3 w-24 rounded"
              style={{ background: "var(--color-border-strong)" }}
            />
          </div>
        ))}
      </div>
    );
  }

  const errorNotice = loadError && (
    <div role="alert" className="card p-5 mb-3">
      <p>{loadError}</p>
      <button
        type="button"
        className="btn btn-outline btn-sm mt-2"
        onClick={() => {
          void fetchSubmissions();
        }}
      >
        Retry loading library
      </button>
    </div>
  );
  if (loadError && submissions.length === 0) return errorNotice;

  if (submissions.length === 0) {
    return (
      <div
        className="card p-12 text-center"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div
          className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-4"
          style={{ background: "var(--color-primary-muted)" }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 28 28"
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth="1.5"
          >
            <rect x="4" y="3" width="16" height="22" rx="2" />
            <rect x="8" y="3" width="16" height="22" rx="2" />
            <path d="M12 9h8M12 13h8M12 17h5" />
          </svg>
        </div>
        <p
          className="font-medium mb-1"
          style={{ color: "var(--color-text)" }}
        >
          No Titchybooks yet
        </p>
        <p
          className="text-sm mb-6"
          style={{ color: "var(--color-text-muted)" }}
        >
          Start with a blank eight-page booklet, a template, or AI. Save a
          draft, preview it, then submit for review. Order prints after
          approval.
        </p>
        <Link href="/create?new=true" className="btn btn-primary">
          Create your first Titchybooks
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {errorNotice}
      {submissions.map((sub) => (
        <SubmissionCard
          key={sub.id}
          submission={sub}
          onDelete={handleDelete}
          onChange={() => {
            void fetchSubmissions();
          }}
        />
      ))}
    </div>
  );
}

function SubmissionCard({
  submission,
  onDelete,
  onChange,
}: {
  submission: Submission;
  onDelete: (id: string) => void;
  onChange: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDeleteClick() {
    setDeleting(true);
    try {
      await onDelete(submission.id);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="card card-hover p-5 flex flex-col items-start justify-between gap-4 lg:flex-row">
      <div className="w-full flex-1 min-w-0">
        <div className="flex items-center gap-2.5 mb-1.5">
          <span
            className="font-semibold text-[0.9375rem] truncate"
            style={{ color: "var(--color-text)" }}
          >
            {submission.title || "Untitled Titchybooks"}
          </span>
          <StatusBadge status={submission.status} />
        </div>
        <p
          className="text-xs"
          style={{ color: "var(--color-text-subtle)" }}
        >
          Created {new Date(submission.createdAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </p>
        <RenderProgress
          submissionId={submission.id}
          status={submission.status}
          onChange={onChange}
        />
        {submission.status === "REJECTED" && submission.rejectionReason && (
          <div
            className="mt-2 flex items-center gap-1.5 text-xs p-2 rounded-md"
            style={{
              background: "var(--color-error-light)",
              color: "var(--color-error)",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 9.5a.75.75 0 001.5 0v-4a.75.75 0 00-1.5 0v4zM8 5a.75.75 0 100-1.5A.75.75 0 008 5z"
              />
            </svg>
            {submission.rejectionReason}
          </div>
        )}
      </div>

      <div className="flex w-full flex-col items-start gap-2 lg:w-auto lg:max-w-[65%] lg:flex-row">
        {submission.status === "DRAFT" && (
          <>
            <Link
              href={`/create?submissionId=${submission.id}`}
              className="btn btn-primary btn-sm"
            >
              Edit
            </Link>
            <button
              onClick={handleDeleteClick}
              disabled={deleting}
              className="btn btn-ghost btn-sm"
              style={{ color: "var(--color-error)" }}
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </>
        )}

        {submission.status === "APPROVED" && (
          <>
            {submission.pdfS3Key && (
              <Link
                href={`/dashboard/orders/new?submissionId=${submission.id}`}
                className="btn btn-secondary btn-sm"
              >
                Order prints
              </Link>
            )}
            <PdfDownloads
              submissionId={submission.id}
              printAvailable={Boolean(submission.pdfS3Key)}
              readingAvailable={Boolean(submission.readingPdfS3Key)}
              className="btn btn-success btn-sm"
            />
          </>
        )}

        {submission.status === "REJECTED" && (
          <div>
            {submission.mode === "EDITOR"
              ? (
                <OpenInEditorButton
                  submissionId={submission.id}
                  label="Make a correction copy"
                  className="btn btn-primary btn-sm"
                />
              )
              : (
                <Link
                  href={`/create/upload?replaces=${
                    encodeURIComponent(submission.id)
                  }`}
                  className="btn btn-primary btn-sm"
                >
                  Re-upload corrected images
                </Link>
              )}
            <p
              className="mt-1 text-xs"
              style={{ color: "var(--color-text-muted)" }}
            >
              {submission.mode === "EDITOR"
                ? "Copies all pages and the protected template into a new draft."
                : "Upload eight corrected pages as a separate submission."}{" "}
              The original review and PDFs stay unchanged.
            </p>
          </div>
        )}

        {submission.status === "PENDING" && (
          <span
            className="flex items-center gap-1.5 text-xs font-medium"
            style={{ color: "var(--color-accent)" }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ background: "var(--color-accent)" }}
            />
            Awaiting review
          </span>
        )}

        {submission.status === "PROCESSING" && (
          <span
            className="flex items-center gap-1.5 text-xs font-medium"
            style={{ color: "var(--color-info)" }}
          >
            <svg
              className="animate-spin"
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="30"
                strokeDashoffset="10"
              />
            </svg>
            Generating PDF...
          </span>
        )}

        {submission.status === "FAILED" && (
          <span
            className="flex items-center gap-1.5 text-xs font-medium"
            style={{ color: "var(--color-error)" }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 9.5a.75.75 0 001.5 0v-4a.75.75 0 00-1.5 0v4zM8 5a.75.75 0 100-1.5A.75.75 0 008 5z"
              />
            </svg>
            Generation failed
          </span>
        )}
      </div>
    </div>
  );
}
