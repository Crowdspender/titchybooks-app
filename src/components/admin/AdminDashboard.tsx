"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import StatusBadge from "@/components/submissions/StatusBadge";

interface AdminSubmission {
  id: string;
  status: string;
  pdfS3Key: string | null;
  pdfDownloadUrl: string | null;
  rejectionReason: string | null;
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
}

export default function AdminDashboard() {
  const [submissions, setSubmissions] = useState<AdminSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const params = filter ? `?status=${filter}` : "";
      const res = await fetch(`/api/admin/submissions${params}`);
      const data = await res.json();
      if (!cancelled) {
        setSubmissions(data.submissions || []);
        setLoading(false);
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
    const rejectionReason = action === "REJECT"
      ? prompt("Rejection reason (optional):")
      : undefined;

    const res = await fetch(`/api/admin/submissions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        rejectionReason: rejectionReason || undefined,
      }),
    });

    if (res.ok) {
      toast.success(`Submission ${action.toLowerCase()}d`);
      setRefreshKey((k) => k + 1);
    } else {
      toast.error("Action failed");
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
        className="flex gap-2 mb-6 pb-6"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        {["", "PENDING", "APPROVED", "REJECTED"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`btn btn-sm ${
              filter === s ? "btn-primary" : "btn-ghost"
            }`}
          >
            {s || "All"}
          </button>
        ))}
      </div>

      {loading
        ? (
          <div className="space-y-3">
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
              No submissions yet
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
                    <tr
                      key={sub.id}
                      style={{ borderBottom: "1px solid var(--color-border)" }}
                    >
                      <td className="px-5 py-4">
                        <div
                          className="font-medium"
                          style={{ color: "var(--color-text)" }}
                        >
                          {sub.user.name || "—"}
                        </div>
                        <div
                          className="text-xs"
                          style={{ color: "var(--color-text-subtle)" }}
                        >
                          {sub.user.email}
                        </div>
                      </td>
                      <td
                        className="px-5 py-4"
                        style={{ color: "var(--color-text-muted)" }}
                      >
                        {new Date(sub.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-4">
                        <StatusBadge status={sub.status} />
                      </td>
                      <td className="px-5 py-4">
                        {sub.pdfDownloadUrl
                          ? (
                            <a
                              href={sub.pdfDownloadUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-medium no-underline"
                              style={{ color: "var(--color-primary)" }}
                            >
                              Preview PDF
                            </a>
                          )
                          : (
                            <span
                              className="text-xs"
                              style={{ color: "var(--color-text-subtle)" }}
                            >
                              Generating...
                            </span>
                          )}
                      </td>
                      <td className="px-5 py-4 text-right">
                        {sub.status === "PENDING"
                          ? (
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => handleAction(sub.id, "APPROVE")}
                                className="btn btn-success btn-sm"
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => handleAction(sub.id, "REJECT")}
                                className="btn btn-danger btn-sm"
                              >
                                Reject
                              </button>
                            </div>
                          )
                          : (
                            <span style={{ color: "var(--color-text-subtle)" }}>
                              —
                            </span>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
    </div>
  );
}
