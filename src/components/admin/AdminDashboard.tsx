"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import StatusBadge from "@/components/submissions/StatusBadge";
import RenderProgress from "@/components/submissions/RenderProgress";
import PdfDownloads from "@/components/submissions/PdfDownloads";

interface PagePreview {
  pageLabel: string;
  order: number;
  previewUrl: string | null;
}

interface AdminSubmission {
  id: string;
  status: string;
  mode: string;
  title: string | null;
  pdfS3Key: string | null;
  readingPdfS3Key: string | null;
  pdfDownloadUrl: string | null;
  artifacts: { printSheet: boolean; readingPdf: boolean };
  rejectionReason: string | null;
  createdAt: string;
  aiGenerated: boolean;
  qaSampled: boolean;
  pagePreviews: PagePreview[];
  user: {
    id: string;
    email: string;
    name: string | null;
  };
}

const SPOT_CHECK = "SPOT_CHECK";

export default function AdminDashboard() {
  const [submissions, setSubmissions] = useState<AdminSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const actionLocks = useRef(new Set<string>());
  // The action error a "Reload submissions" click intends to clear; only a
  // successful reload clears it, and only if no newer error replaced it.
  const reloadForError = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      const params = filter === SPOT_CHECK
        ? "?spotCheck=true"
        : filter
        ? `?status=${filter}`
        : "";
      try {
        const res = await fetch(`/api/admin/submissions${params}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(
            data.error ||
              `Submissions could not be loaded (HTTP ${res.status})`,
          );
        }
        if (!Array.isArray(data.submissions)) {
          throw new Error("The submission list response is unavailable");
        }
        if (!cancelled) {
          setSubmissions(data.submissions);
          if (reloadForError.current !== null) {
            const capturedError = reloadForError.current;
            setActionError((current) =>
              current === capturedError ? null : current
            );
            reloadForError.current = null;
          }
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Submissions could not be loaded. Check your connection and retry.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [filter, refreshKey]);

  async function handleAction(
    id: string,
    action: "APPROVE" | "REJECT",
  ) {
    if (actionLocks.current.has(id)) return;
    setActionError(null);
    let rejectionReason: string | undefined;
    if (action === "REJECT") {
      const reason = prompt(
        "Explain what needs correcting (10–1000 characters). Cancel makes no changes.",
      );
      if (reason === null) return;
      rejectionReason = reason.trim();
      if (rejectionReason.length < 10 || rejectionReason.length > 1000) {
        const message =
          "Explain the required correction in 10–1000 characters.";
        setActionError(message);
        toast.error(message);
        return;
      }
    }
    actionLocks.current.add(id);
    setPendingIds(new Set(actionLocks.current));
    try {
      const res = await fetch(`/api/admin/submissions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(rejectionReason ? { rejectionReason } : {}),
        }),
      });
      // Check status before touching the body: a committed review with an
      // unreadable 2xx body must still confirm and refresh, and a failure with
      // an unreadable body reports the HTTP status instead of a parse error.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          data.error ||
            `Review was not confirmed (HTTP ${res.status}); reload before retrying.`,
        );
      }
      toast.success(
        action === "APPROVE"
          ? "Submission approved"
          : "Submission rejected with correction guidance",
      );
      setRefreshKey((k) => k + 1);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Review was not confirmed. Check your connection and reload before retrying.";
      setActionError(message);
      toast.error(message);
    } finally {
      actionLocks.current.delete(id);
      setPendingIds(new Set(actionLocks.current));
    }
  }

  return (
    <div className="page-container py-10">
      <div className="mb-8">
        <p className="section-label mb-2">Administration</p>
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Submissions
        </h1>
      </div>

      {/* Filter bar */}
      <div
        className="flex flex-wrap gap-2 mb-6 pb-6"
        role="group"
        aria-label="Submission filters"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        {["", "PROCESSING", "FAILED", "PENDING", "APPROVED", "REJECTED"].map((
          s,
        ) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            aria-pressed={filter === s}
            className={`btn btn-sm ${
              filter === s ? "btn-primary" : "btn-ghost"
            }`}
          >
            {s || "All"}
          </button>
        ))}
        <button
          onClick={() => setFilter(SPOT_CHECK)}
          aria-pressed={filter === SPOT_CHECK}
          className={`btn btn-sm ${
            filter === SPOT_CHECK ? "btn-primary" : "btn-ghost"
          }`}
        >
          Spot-check
        </button>
      </div>

      {actionError && (
        <div role="alert" className="card p-4 mb-4">
          <p style={{ color: "var(--color-error)" }}>{actionError}</p>
          <button
            className="btn btn-outline btn-sm mt-2"
            onClick={() => {
              reloadForError.current = actionError;
              setRefreshKey((k) => k + 1);
            }}
          >
            Reload submissions
          </button>
        </div>
      )}
      {loading
        ? (
          <div
            className="space-y-3"
            role="status"
            aria-label="Loading submissions"
          >
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="card p-5 animate-pulse"
                style={{ background: "var(--color-border)" }}
              >
                <div
                  className="h-4 w-40 rounded"
                  style={{ background: "var(--color-border-strong)" }}
                />
              </div>
            ))}
          </div>
        )
        : loadError
        ? (
          <div className="card p-6" role="alert">
            <p style={{ color: "var(--color-error)" }}>{loadError}</p>
            <button
              className="btn btn-outline btn-sm mt-3"
              onClick={() => setRefreshKey((k) => k + 1)}
            >
              Retry loading submissions
            </button>
          </div>
        )
        : submissions.length === 0
        ? (
          <div className="card p-12 text-center">
            <div
              className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4"
              style={{ background: "var(--color-primary-muted)" }}
            >
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--color-primary)"
                strokeWidth="1.5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z"
                />
              </svg>
            </div>
            <p
              className="font-medium mb-1"
              style={{ color: "var(--color-text)" }}
            >
              {filter
                ? "No submissions match this filter"
                : "No submissions yet"}
            </p>
            <p
              className="text-sm"
              style={{ color: "var(--color-text-muted)" }}
            >
              Submissions will appear here once users start creating
              Titchybooks.
            </p>
          </div>
        )
        : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    style={{
                      background: "var(--color-surface)",
                      borderBottom: "1px solid var(--color-border)",
                    }}
                  >
                    <th className="text-left px-5 py-3 section-label">User</th>
                    <th className="text-left px-5 py-3 section-label">Date</th>
                    <th className="text-left px-5 py-3 section-label">
                      Status
                    </th>
                    <th className="text-left px-5 py-3 section-label">PDF</th>
                    <th className="text-right px-5 py-3 section-label">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((sub) => (
                    <Fragment key={sub.id}>
                      <tr
                        key={sub.id}
                        style={{
                          borderBottom: "1px solid var(--color-border)",
                          cursor: sub.pagePreviews.length > 0
                            ? "pointer"
                            : "default",
                        }}
                        onClick={() => {
                          if (sub.pagePreviews.length > 0) {
                            setExpandedId(
                              expandedId === sub.id ? null : sub.id,
                            );
                          }
                        }}
                      >
                        <td className="px-5 py-4">
                          <div
                            className="font-medium"
                            style={{ color: "var(--color-text)" }}
                          >
                            {sub.user.name || "\u2014"}
                          </div>
                          <div
                            className="text-xs"
                            style={{ color: "var(--color-text-subtle)" }}
                          >
                            {sub.user.email}
                          </div>
                          {sub.title && (
                            <div
                              className="text-xs mt-0.5 italic"
                              style={{ color: "var(--color-text-muted)" }}
                            >
                              {sub.title}
                            </div>
                          )}
                          {sub.aiGenerated && (
                            <span
                              className="badge text-[10px] mt-1 inline-block"
                              style={{
                                background: "var(--color-primary-muted)",
                                color: "var(--color-primary)",
                              }}
                              title={sub.qaSampled
                                ? "AI-created, sampled for spot-check"
                                : "AI-created"}
                            >
                              AI{sub.qaSampled ? " · spot-check" : ""}
                            </span>
                          )}
                        </td>
                        <td
                          className="px-5 py-4"
                          style={{ color: "var(--color-text-muted)" }}
                        >
                          {new Date(sub.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-5 py-4">
                          <StatusBadge status={sub.status} />
                          {sub.rejectionReason && (
                            <p className="text-xs mt-2">
                              Correction needed: {sub.rejectionReason}
                            </p>
                          )}
                          <RenderProgress
                            submissionId={sub.id}
                            status={sub.status}
                            onChange={() => setRefreshKey((k) => k + 1)}
                          />
                        </td>
                        <td className="px-5 py-4">
                          {sub.artifacts.printSheet || sub.artifacts.readingPdf
                            ? (
                              <PdfDownloads
                                submissionId={sub.id}
                                printAvailable={sub.artifacts.printSheet}
                                readingAvailable={sub.artifacts.readingPdf}
                              />
                            )
                            : (
                              <span
                                className="text-xs"
                                style={{ color: "var(--color-text-subtle)" }}
                              >
                                {sub.status === "PROCESSING"
                                  ? "Rendering…"
                                  : sub.status === "FAILED"
                                  ? "Rendering failed"
                                  : "PDF unavailable"}
                              </span>
                            )}
                        </td>
                        <td className="px-5 py-4 text-right">
                          {sub.status === "PENDING"
                            ? (
                              <div className="flex gap-2 justify-end">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleAction(sub.id, "APPROVE");
                                  }}
                                  className="btn btn-success btn-sm"
                                  disabled={pendingIds.has(sub.id)}
                                >
                                  Approve
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleAction(sub.id, "REJECT");
                                  }}
                                  className="btn btn-danger btn-sm"
                                  disabled={pendingIds.has(sub.id)}
                                >
                                  Reject
                                </button>
                              </div>
                            )
                            : (
                              <span
                                style={{ color: "var(--color-text-subtle)" }}
                              >
                                —
                              </span>
                            )}
                        </td>
                      </tr>

                      {/* Expanded preview strip */}
                      {expandedId === sub.id && sub.pagePreviews.length > 0 && (
                        <tr
                          key={`${sub.id}-previews`}
                          style={{
                            borderBottom: "1px solid var(--color-border)",
                          }}
                        >
                          <td colSpan={5} className="px-5 py-4">
                            <p
                              className="text-xs font-semibold uppercase tracking-wider mb-3"
                              style={{ color: "var(--color-text-muted)" }}
                            >
                              Page Previews
                            </p>
                            <div className="flex gap-3 overflow-x-auto pb-2">
                              {sub.pagePreviews.map((page) => (
                                <div
                                  key={page.pageLabel}
                                  className="flex-shrink-0 text-center"
                                >
                                  <div
                                    className="rounded-lg overflow-hidden mb-1.5"
                                    style={{
                                      width: "80px",
                                      height: "114px",
                                      background: "var(--color-surface)",
                                      border: "1px solid var(--color-border)",
                                    }}
                                  >
                                    {page.previewUrl
                                      ? (
                                        // Signed preview URLs are fetched directly without an image optimizer.
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                          src={page.previewUrl}
                                          alt={page.pageLabel}
                                          className="w-full h-full object-contain"
                                        />
                                      )
                                      : (
                                        <div
                                          className="w-full h-full flex items-center justify-center text-xs"
                                          style={{
                                            color: "var(--color-text-subtle)",
                                          }}
                                        >
                                          No preview
                                        </div>
                                      )}
                                  </div>
                                  <span
                                    className="text-[10px] font-medium"
                                    style={{ color: "var(--color-text-muted)" }}
                                  >
                                    {page.pageLabel.replace("_", " ")}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
    </div>
  );
}
