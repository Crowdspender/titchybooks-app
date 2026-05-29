"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface TemplateItem {
    id: string;
    title: string | null;
    status: string;
    version: number;
    publishedAt: string | null;
    createdAt: string;
    instanceCount: number;
}

export default function TemplateManager() {
    const router = useRouter();
    const [templates, setTemplates] = useState<TemplateItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [filter, setFilter] = useState<string>("");

    useEffect(() => {
        let cancelled = false;
        async function load() {
            setLoading(true);
            const res = await fetch("/api/admin/templates");
            const data = await res.json();
            if (!cancelled) {
                setTemplates(data.templates || []);
                setLoading(false);
            }
        }
        load();
        return () => {
            cancelled = true;
        };
    }, [filter]);

    async function handleCreate() {
        setCreating(true);
        try {
            const res = await fetch("/api/admin/templates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: "New Template" }),
            });

            if (!res.ok) {
                throw new Error("Could not create template");
            }

            const data = await res.json();
            toast.success("Template created");
            // Open the editor with the new template
            router.push(`/create?submissionId=${data.template.id}`);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to create template",
            );
        } finally {
            setCreating(false);
        }
    }

    async function handlePublish(id: string) {
        try {
            const res = await fetch(`/api/admin/templates/${id}/publish`, {
                method: "POST",
            });

            if (!res.ok) {
                throw new Error("Could not publish template");
            }

            toast.success("Template published");
            // Refresh the list
            const data = await (await fetch("/api/admin/templates")).json();
            setTemplates(data.templates || []);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to publish template",
            );
        }
    }

    async function handleDelete(id: string, instanceCount: number) {
        const message = instanceCount > 0
            ? `This template has ${instanceCount} instance(s). Deleting it will remove the template layer from those drafts. Continue?`
            : "Delete this template?";

        if (!confirm(message)) {
            return;
        }

        try {
            const res = await fetch(`/api/admin/templates/${id}`, {
                method: "DELETE",
            });

            if (!res.ok) {
                throw new Error("Could not delete template");
            }

            toast.success("Template deleted");
            setTemplates((prev) => prev.filter((t) => t.id !== id));
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to delete template",
            );
        }
    }

    const filteredTemplates = filter
        ? templates.filter((t) => t.status === filter)
        : templates;

    return (
        <div>
            <div className="flex items-center justify-between mb-6">
                <h2
                    className="text-xl font-semibold"
                    style={{ color: "var(--color-text)" }}
                >
                    Templates
                </h2>
                <button
                    onClick={handleCreate}
                    disabled={creating}
                    className="btn btn-primary btn-sm"
                >
                    {creating ? "Creating..." : "+ Create Template"}
                </button>
            </div>

            <div
                className="flex gap-2 mb-6 pb-6"
                style={{ borderBottom: "1px solid var(--color-border)" }}
            >
                {["", "DRAFT", "APPROVED"].map((s) => (
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
                                    style={{
                                        background:
                                            "var(--color-border-strong)",
                                    }}
                                />
                            </div>
                        ))}
                    </div>
                )
                : filteredTemplates.length === 0
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
                                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                                />
                            </svg>
                        </div>
                        <p
                            className="font-medium mb-1"
                            style={{ color: "var(--color-text)" }}
                        >
                            No templates yet
                        </p>
                        <p
                            className="text-sm mb-4"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Create templates that users can apply to their
                            Titchybooks.
                        </p>
                        <button
                            onClick={handleCreate}
                            disabled={creating}
                            className="btn btn-primary"
                        >
                            {creating ? "Creating..." : "Create first template"}
                        </button>
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
                                            borderBottom:
                                                "1px solid var(--color-border)",
                                        }}
                                    >
                                        <th className="text-left px-5 py-3 section-label">
                                            Title
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Status
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Version
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Instances
                                        </th>
                                        <th className="text-left px-5 py-3 section-label">
                                            Created
                                        </th>
                                        <th className="text-right px-5 py-3 section-label">
                                            Actions
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredTemplates.map((template) => (
                                        <tr
                                            key={template.id}
                                            style={{
                                                borderBottom:
                                                    "1px solid var(--color-border)",
                                            }}
                                        >
                                            <td
                                                className="px-5 py-4 font-medium"
                                                style={{
                                                    color: "var(--color-text)",
                                                }}
                                            >
                                                {template.title || "Untitled"}
                                            </td>
                                            <td className="px-5 py-4">
                                                <span
                                                    className={`badge ${
                                                        template.status ===
                                                                "APPROVED"
                                                            ? "badge-approved"
                                                            : "badge-pending"
                                                    }`}
                                                >
                                                    {template.status}
                                                </span>
                                            </td>
                                            <td
                                                className="px-5 py-4"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                            >
                                                v{template.version}
                                            </td>
                                            <td
                                                className="px-5 py-4"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                            >
                                                {template.instanceCount}
                                            </td>
                                            <td
                                                className="px-5 py-4"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                            >
                                                {new Date(template.createdAt)
                                                    .toLocaleDateString()}
                                            </td>
                                            <td className="px-5 py-4 text-right">
                                                <div className="flex gap-2 justify-end">
                                                    <button
                                                        onClick={() =>
                                                            router.push(
                                                                `/create?submissionId=${template.id}`,
                                                            )}
                                                        className="btn btn-primary btn-sm text-xs"
                                                    >
                                                        Edit
                                                    </button>
                                                    {template.status !==
                                                            "APPROVED" && (
                                                        <button
                                                            onClick={() =>
                                                                handlePublish(
                                                                    template.id,
                                                                )}
                                                            className="btn btn-success btn-sm text-xs"
                                                        >
                                                            Publish
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() =>
                                                            handleDelete(
                                                                template.id,
                                                                template
                                                                    .instanceCount,
                                                            )}
                                                        className="btn btn-ghost btn-sm text-xs"
                                                        style={{
                                                            color:
                                                                "var(--color-error)",
                                                        }}
                                                    >
                                                        Delete
                                                    </button>
                                                </div>
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
