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

      // Remove the deleted submission from the list
      setSubmissions((current) =>
        current.filter((sub) => sub.id !== submissionId)
      );

      // Clear localStorage if the deleted submission was the active draft
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
            className="h-20 bg-gray-100 rounded-lg animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (submissions.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p className="mb-4">You haven&apos;t created any Titchybooks yet.</p>
        <Link
          href="/create"
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          Create your first Titchybook
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
    <div className="border border-gray-200 rounded-lg p-4 flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-medium text-sm truncate">
            {submission.title || "Titchybook"}
          </span>
          <StatusBadge status={submission.status} />
        </div>
        <p className="text-xs text-gray-500">
          Created: {new Date(submission.createdAt).toLocaleDateString()}
        </p>
        {submission.status === "REJECTED" && submission.rejectionReason && (
          <p className="text-xs text-red-600 mt-1">
            Reason: {submission.rejectionReason}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* DRAFT: Edit and Delete */}
        {submission.status === "DRAFT" && (
          <>
            <Link
              href={`/create?submissionId=${submission.id}`}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Edit
            </Link>
            <button
              onClick={handleDeleteClick}
              disabled={deleting}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </>
        )}

        {/* APPROVED: Download PDF + order prints */}
        {submission.status === "APPROVED" && submission.pdfS3Key && (
          <>
            <Link
              href={`/dashboard/orders/new?submissionId=${submission.id}`}
              className="px-3 py-1.5 text-sm bg-stone-900 text-white rounded-md hover:bg-stone-700"
            >
              Order prints
            </Link>
            <button
              onClick={handleDownload}
              disabled={loadingPdf}
              className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              {loadingPdf ? "Loading..." : "Download PDF"}
            </button>
          </>
        )}

        {/* REJECTED: Re-upload */}
        {submission.status === "REJECTED" && (
          <Link
            href="/create"
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Re-upload
          </Link>
        )}

        {/* PENDING: Status indicator */}
        {submission.status === "PENDING" && (
          <span className="text-xs text-yellow-600 whitespace-nowrap">
            Awaiting review
          </span>
        )}

        {/* PROCESSING: Status indicator */}
        {submission.status === "PROCESSING" && (
          <span className="text-xs text-blue-600 whitespace-nowrap">
            Generating PDF...
          </span>
        )}

        {/* FAILED: Status indicator */}
        {submission.status === "FAILED" && (
          <span className="text-xs text-red-600 whitespace-nowrap">
            Generation failed
          </span>
        )}
      </div>
    </div>
  );
}
