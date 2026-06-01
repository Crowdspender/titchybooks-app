"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import StatusBadge from "./StatusBadge";

interface Submission {
  id: string;
  title: string | null;
  mode: string;
  status: string;
  pdfS3Key: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

export default function SubmissionList() {
  const router = useRouter();
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSubmissions();
  }, []);

  async function fetchSubmissions() {
    setLoading(true);
    try {
      const res = await fetch("/api/submissions");
      const data = await res.json();
      setSubmissions(data.submissions || []);
    } finally {
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

      setSubmissions((current) =>
        current.filter((sub) => sub.id !== submissionId)
      );

      const ACTIVE_DRAFT_STORAGE_KEY = "titchybook-active-editor-draft";
      const storedDraftId = localStorage.getItem(ACTIVE_DRAFT_STORAGE_KEY);
      if (storedDraftId === submissionId) {
        localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
      }

      toast.success("Draft deleted successfully");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete failed");
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
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
          Create your first booklet and start designing.
        </p>
        <Link href="/create" className="btn btn-primary">
          Create your first Titchybooks
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {submissions.map((sub) => (
        <SubmissionCard key={sub.id} submission={sub} onDelete={handleDelete} />
      ))}
    </div>
  );
}

function SubmissionCard({
  submission,
  onDelete,
}: {
  submission: Submission;
  onDelete: (id: string) => void;
}) {
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDownload() {
    setLoadingPdf(true);
    try {
      const res = await fetch(`/api/submissions/${submission.id}`);
      const data = await res.json();
      if (data.pdfDownloadUrl) {
        window.open(data.pdfDownloadUrl, "_blank");
      }
    } finally {
      setLoadingPdf(false);
    }
  }

  async function handleDeleteClick() {
    setDeleting(true);
    try {
      await onDelete(submission.id);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="card card-hover p-5 flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
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
          Created{" "}
          {new Date(submission.createdAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </p>
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

      <div className="flex items-center gap-2 flex-shrink-0">
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

        {submission.status === "APPROVED" && submission.pdfS3Key && (
          <>
            <Link
              href={`/dashboard/orders/new?submissionId=${submission.id}`}
              className="btn btn-secondary btn-sm"
            >
              Order prints
            </Link>
            <button
              onClick={handleDownload}
              disabled={loadingPdf}
              className="btn btn-success btn-sm"
            >
              {loadingPdf ? "Loading..." : "Download PDF"}
            </button>
          </>
        )}

        {submission.status === "REJECTED" && (
          <Link href="/create" className="btn btn-primary btn-sm">
            Re-upload
          </Link>
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
