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
            <div className="page-container py-10">
                <div className="mb-8">
                    <p className="section-label mb-2">Start from a template</p>
                    <h1
                        className="text-3xl font-semibold tracking-tight"
                        style={{ color: "var(--color-text)" }}
                    >
                        Choose a Template
                    </h1>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {[1, 2, 3].map((i) => (
                        <div
                            key={i}
                            className="card h-64 animate-pulse"
                            style={{ background: "var(--color-border)" }}
                        />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="page-container py-10">
            <div className="flex items-start justify-between mb-2">
                <div>
                    <p className="section-label mb-2">Start from a template</p>
                    <h1
                        className="text-3xl font-semibold tracking-tight"
                        style={{ color: "var(--color-text)" }}
                    >
                        Choose a Template
                    </h1>
                </div>
                <button
                    onClick={() => router.push("/create?new=true")}
                    className="btn btn-outline"
                >
                    Start from Scratch
                </button>
            </div>

            <p
                className="mb-8 text-sm leading-relaxed"
                style={{ color: "var(--color-text-muted)" }}
            >
                Pick a pre-designed template to get started quickly. Template
                elements are locked so you can focus on adding your own content
                on top.
            </p>

            {templates.length === 0
                ? (
                    <div className="card p-12 text-center">
                        <svg
                            className="mx-auto h-12 w-12"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                            style={{ color: "var(--color-text-subtle)" }}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                            />
                        </svg>
                        <p
                            className="mt-4 text-sm"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            No templates available yet.
                        </p>
                        <button
                            onClick={() => router.push("/create?new=true")}
                            className="btn btn-primary mt-4"
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
                                className="card card-hover overflow-hidden transition-transform hover:-translate-y-1"
                            >
                                <div
                                    className="h-48 flex items-center justify-center"
                                    style={{
                                        background:
                                            "var(--color-primary-muted)",
                                    }}
                                >
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
                                                    className="mx-auto h-12 w-12"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={1.5}
                                                    style={{
                                                        color:
                                                            "var(--color-text-subtle)",
                                                    }}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                                                    />
                                                </svg>
                                                <p
                                                    className="mt-2 text-xs"
                                                    style={{
                                                        color:
                                                            "var(--color-text-subtle)",
                                                    }}
                                                >
                                                    Preview coming soon
                                                </p>
                                            </div>
                                        )}
                                </div>
                                <div className="p-5">
                                    <h3
                                        className="font-semibold"
                                        style={{ color: "var(--color-text)" }}
                                    >
                                        {template.title || "Untitled Template"}
                                    </h3>
                                    <p
                                        className="mt-1 text-xs"
                                        style={{
                                            color: "var(--color-text-muted)",
                                        }}
                                    >
                                        {new Date(template.createdAt)
                                            .toLocaleDateString()}
                                    </p>
                                    <button
                                        onClick={() => handleCreateFromTemplate(
                                            template.id,
                                        )}
                                        disabled={creating === template.id}
                                        className="btn btn-primary btn-sm mt-4 w-full"
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
