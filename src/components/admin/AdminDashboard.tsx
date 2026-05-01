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
    return () => { cancelled = true; };
  }, [filter, refreshKey]);

  async function handleAction(
    id: string,
    action: "APPROVE" | "REJECT"
  ) {
    const rejectionReason =
      action === "REJECT" ? prompt("Rejection reason (optional):") : undefined;

    const res = await fetch(`/api/admin/submissions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, rejectionReason: rejectionReason || undefined }),
    });

    if (res.ok) {
      toast.success(`Submission ${action.toLowerCase()}d`);
      setRefreshKey((k) => k + 1);
    } else {
      toast.error("Action failed");
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Admin Dashboard</h1>

      <div className="flex gap-2 mb-4">
        {["", "PENDING", "APPROVED", "REJECTED"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 text-sm rounded-md ${
              filter === s
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {s || "All"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 bg-gray-100 rounded-lg animate-pulse"
            />
          ))}
        </div>
      ) : submissions.length === 0 ? (
        <p className="text-gray-500 text-center py-12">No submissions found.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium">User</th>
                <th className="text-left px-4 py-2 font-medium">Date</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">PDF</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {submissions.map((sub) => (
                <tr key={sub.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{sub.user.name || "—"}</div>
                    <div className="text-xs text-gray-500">
                      {sub.user.email}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {new Date(sub.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={sub.status} />
                  </td>
                  <td className="px-4 py-3">
                    {sub.pdfDownloadUrl ? (
                      <a
                        href={sub.pdfDownloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline text-xs"
                      >
                        Preview PDF
                      </a>
                    ) : (
                      <span className="text-xs text-gray-400">
                        Generating...
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {sub.status === "PENDING" && (
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => handleAction(sub.id, "APPROVE")}
                          className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => handleAction(sub.id, "REJECT")}
                          className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                    {sub.status !== "PENDING" && (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
