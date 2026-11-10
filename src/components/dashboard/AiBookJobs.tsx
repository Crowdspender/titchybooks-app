"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

interface AiJobItem {
    id: string;
    concept: string;
    title: string | null;
    submissionId: string | null;
    phase: {
        phase: string;
        label: string;
        message: string;
        terminal: boolean;
        retryable: boolean;
    };
    updatedAt: string;
    artifacts: {
        approved: boolean;
        printSheet: boolean;
        readingPdf: boolean;
        ready: boolean;
    };
}

const REFRESH_MS = 10_000;

/** Status tone per phase, using the badges the rest of the app already has. */
function badgeClass(phase: string): string {
    switch (phase) {
        case "completed":
            return "badge badge-approved";
        case "failed":
            return "badge badge-rejected";
        case "needs-review":
            return "badge badge-pending";
        default:
            return "badge badge-processing";
    }
}

/**
 * Active and recent AI generations.
 *
 * Listed separately from submissions because a job exists — and is worth
 * showing — before it has any submission to link to; hiding it until the draft
 * exists is what made a refresh mid-job look like the request was lost.
 */
export default function AiBookJobs() {
    const [jobs, setJobs] = useState<AiJobItem[]>([]);
    const [loading, setLoading] = useState(true);
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined,
    );

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/ai/books", { cache: "no-store" });
            if (res.status === 401) return;
            if (!res.ok) throw new Error("unavailable");
            const data = (await res.json()) as { jobs?: AiJobItem[] };
            setJobs(data.jobs ?? []);
        } catch {
            // Keep the last known list; the next tick retries.
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;

        async function tick() {
            await load();
            if (cancelled) return;
            timerRef.current = setTimeout(tick, REFRESH_MS);
        }

        void tick();
        return () => {
            cancelled = true;
            clearTimeout(timerRef.current);
        };
    }, [load]);

    if (loading || jobs.length === 0) return null;

    return (
        <section className="mb-8">
            <div className="flex items-center justify-between mb-3">
                <h2
                    className="text-sm font-semibold"
                    style={{ color: "var(--color-text)" }}
                >
                    AI books
                </h2>
                <Link
                    href="/create/ai"
                    className="text-xs underline"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Create another
                </Link>
            </div>

            <div className="space-y-2">
                {jobs.map((job) => (
                    <div
                        key={job.id}
                        className="card p-4 flex flex-wrap items-center gap-3"
                    >
                        <div className="min-w-0 flex-1">
                            <p
                                className="text-sm font-medium truncate"
                                style={{ color: "var(--color-text)" }}
                            >
                                {job.title ?? job.concept}
                            </p>
                            <p
                                className="text-xs mt-0.5"
                                style={{ color: "var(--color-text-muted)" }}
                            >
                                {job.phase.message}
                            </p>
                        </div>

                        <span className={badgeClass(job.phase.phase)}>
                            {job.phase.label}
                        </span>

                        <div className="flex items-center gap-2">
                            {!job.phase.terminal && (
                                <Link
                                    href={`/create/ai?job=${job.id}`}
                                    className="btn btn-outline btn-sm text-xs"
                                >
                                    View progress
                                </Link>
                            )}
                            {job.artifacts.printSheet &&
                                job.artifacts.approved && (
                                <a
                                    href={`/api/ai/books/${job.id}/downloads?kind=print`}
                                    className="btn btn-outline btn-sm text-xs"
                                    download
                                >
                                    Print sheet
                                </a>
                            )}
                            {job.artifacts.readingPdf &&
                                job.artifacts.approved && (
                                <a
                                    href={`/api/ai/books/${job.id}/downloads?kind=reading`}
                                    className="btn btn-outline btn-sm text-xs"
                                    download
                                >
                                    Reading PDF
                                </a>
                            )}
                            {job.phase.terminal && job.submissionId && (
                                <Link
                                    href={`/create?submissionId=${job.submissionId}`}
                                    className="btn btn-outline btn-sm text-xs"
                                >
                                    Open draft
                                </Link>
                            )}
                            {(job.phase.phase === "failed" ||
                                job.phase.phase === "needs-review") && (
                                <Link
                                    href="/create/ai"
                                    className="btn btn-primary btn-sm text-xs"
                                >
                                    Start again
                                </Link>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
