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
                <h2 className="text-xl font-bold">Templates</h2>
                <button
                    onClick={handleCreate}
                    disabled={creating}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm disabled:opacity-50"
                >
                    {creating ? "Creating..." : "+ Create Template"}
                </button>
            </div>

            <div className="flex gap-2 mb-4">
                {["", "DRAFT", "APPROVED"].map((s) => (
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

            {loading
                ? (
                    <div className="space-y-3">
                        {[1, 2, 3].map((i) => (
                            <div
                                key={i}
                                className="h-16 bg-gray-100 rounded-lg animate-pulse"
                            />
                        ))}
                    </div>
                )
                : filteredTemplates.length === 0
                ? (
                    <p className="text-gray-500 text-center py-12">
                        No templates found.
                    </p>
                )
                : (
                    <div className="border border-gray-200 rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Title
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Status
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Version
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Instances
                                    </th>
                                    <th className="text-left px-4 py-2 font-medium">
                                        Created
                                    </th>
                                    <th className="text-right px-4 py-2 font-medium">
                                        Actions
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200">
                                {filteredTemplates.map((template) => (
                                    <tr key={template.id}>
                                        <td className="px-4 py-3 font-medium">
                                            {template.title || "Untitled"}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span
                                                className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                                                    template.status ===
                                                            "APPROVED"
                                                        ? "bg-green-100 text-green-800"
                                                        : "bg-yellow-100 text-yellow-800"
                                                }`}
                                            >
                                                {template.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-gray-600">
                                            v{template.version}
                                        </td>
                                        <td className="px-4 py-3 text-gray-600">
                                            {template.instanceCount}
                                        </td>
                                        <td className="px-4 py-3 text-gray-600">
                                            {new Date(template.createdAt)
                                                .toLocaleDateString()}
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <div className="flex gap-2 justify-end">
                                                <button
                                                    onClick={() =>
                                                        router.push(
                                                            `/create?submissionId=${template.id}`,
                                                        )}
                                                    className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
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
                                                        className="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
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
                                                    className="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
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
                )}
        </div>
    );
}
