"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

interface PublicTemplate {
    id: string;
    title: string | null;
    previewImage: string | null;
    createdAt: string;
}

export default function TemplateGallery() {
    const router = useRouter();
    const [templates, setTemplates] = useState<PublicTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState<string | null>(null);

    useEffect(() => {
        async function load() {
            try {
                const res = await fetch("/api/templates/public");
                const data = await res.json();
                setTemplates(data.templates || []);
            } catch {
                toast.error("Failed to load templates");
            } finally {
                setLoading(false);
            }
        }
        load();
    }, []);

    async function handleCreateFromTemplate(templateId: string) {
        setCreating(templateId);
        try {
            const res = await fetch("/api/submissions/from-template", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ templateId }),
            });

            if (!res.ok) {
                throw new Error("Could not create from template");
            }

            const data = await res.json();
            toast.success("Created from template!");
            router.push(`/create?submissionId=${data.submission.id}`);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Failed to create from template",
            );
        } finally {
            setCreating(null);
        }
    }

    if (loading) {
        return (
            <div className="max-w-4xl mx-auto px-4 py-8">
                <h1 className="text-2xl font-bold mb-6">Choose a Template</h1>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {[1, 2, 3].map((i) => (
                        <div
                            key={i}
                            className="h-64 bg-gray-100 rounded-xl animate-pulse"
                        />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto px-4 py-8">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-2xl font-bold">Choose a Template</h1>
                <button
                    onClick={() => router.push("/create?new=true")}
                    className="px-4 py-2 border border-stone-300 text-stone-700 rounded-md hover:bg-stone-50 text-sm"
                >
                    Start from Scratch
                </button>
            </div>

            <p className="text-stone-600 mb-6">
                Pick a pre-designed template to get started quickly. Template
                elements are locked so you can focus on adding your own content
                on top.
            </p>

            {templates.length === 0
                ? (
                    <div className="text-center py-12">
                        <p className="text-gray-500">
                            No templates available yet.
                        </p>
                        <button
                            onClick={() => router.push("/create?new=true")}
                            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
                        >
                            Create from Scratch
                        </button>
                    </div>
                )
                : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                        {templates.map((template) => (
                            <div
                                key={template.id}
                                className="rounded-2xl border border-stone-300 bg-white shadow-sm overflow-hidden transition hover:shadow-md"
                            >
                                <div className="h-48 bg-stone-100 flex items-center justify-center">
                                    {template.previewImage
                                        ? (
                                            <img
                                                src={template.previewImage}
                                                alt={template.title ||
                                                    "Template preview"}
                                                className="h-full w-full object-cover"
                                            />
                                        )
                                        : (
                                            <div className="text-center">
                                                <svg
                                                    className="mx-auto h-12 w-12 text-stone-300"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={1.5}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                                                    />
                                                </svg>
                                                <p className="mt-2 text-xs text-stone-400">
                                                    Preview coming soon
                                                </p>
                                            </div>
                                        )}
                                </div>
                                <div className="p-4">
                                    <h3 className="font-semibold text-stone-800">
                                        {template.title || "Untitled Template"}
                                    </h3>
                                    <p className="mt-1 text-xs text-stone-500">
                                        {new Date(template.createdAt)
                                            .toLocaleDateString()}
                                    </p>
                                    <button
                                        onClick={() =>
                                            handleCreateFromTemplate(
                                                template.id,
                                            )}
                                        disabled={creating === template.id}
                                        className="mt-3 w-full rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {creating === template.id
                                            ? "Creating..."
                                            : "Use This Template"}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
        </div>
    );
}
