"use client";

import { useEffect, useState } from "react";

interface DrainRun {
    id: string;
    queue: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    claimed: number;
    finished: number;
    yielded: number;
    errored: boolean;
}

interface QueueHealth {
    queue: "ai" | "render";
    due: number;
    processing: number;
    failed: number;
    failedRecent: number;
    oldestDueAt: string | null;
    oldestDueAgeMs: number | null;
    lastRun: DrainRun | null;
    lastRunAgeMs: number | null;
    healthy: boolean;
    reasons: string[];
}

interface QueueHealthReport {
    healthy: boolean;
    checkedAt: string;
    staleAfterMs: number;
    backlogAfterMs: number;
    queues: QueueHealth[];
}

interface FailedAiJob {
    id: string;
    concept: string;
    stage: string;
    attempts: number;
    maxAttempts: number;
    errorMessage: string | null;
    completedAt: string | null;
    createdAt: string;
    submissionId: string | null;
    user: { email: string; name: string | null };
    submission: { title: string | null } | null;
}

interface FailedRenderJob {
    id: string;
    attempts: number;
    maxAttempts: number;
    errorMessage: string | null;
    completedAt: string | null;
    createdAt: string;
    submissionId: string;
    submission: {
        title: string | null;
        user: { email: string; name: string | null };
    } | null;
}

interface QueueResponse {
    health: QueueHealthReport;
    failedAiJobs: FailedAiJob[];
    failedRenderJobs: FailedRenderJob[];
    recentRuns: DrainRun[];
}

const REFRESH_MS = 30_000;
const QUEUE_LABELS: Record<string, string> = {
    ai: "AI book queue",
    render: "Render queue",
};
const REASON_LABELS: Record<string, string> = {
    "drain-never-ran": "No drain run has been recorded yet",
    "drain-stalled": "The scheduler has not run recently",
    "due-backlog": "Runnable jobs have been waiting too long",
    "last-run-error": "The last drain stopped on a database error",
};
const HEALTHY_BADGE = { background: "#DCFCE7", color: "#166534" };
const UNHEALTHY_BADGE = { background: "#FEE2E2", color: "#991B1B" };

function formatAge(ms: number | null): string {
    if (ms === null) return "—";
    if (ms < 60_000) return "just now";
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(ms: number): string {
    return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function formatDate(value: string | null): string {
    return value ? new Date(value).toLocaleString() : "—";
}

export default function QueueMonitor() {
    const [data, setData] = useState<QueueResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            try {
                const res = await fetch("/api/admin/queue");
                if (!res.ok) throw new Error(`Request failed (${res.status})`);
                const payload = (await res.json()) as QueueResponse;
                if (!cancelled) {
                    setData(payload);
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(
                        err instanceof Error
                            ? err.message
                            : "Failed to load queue status",
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
    }, [refreshKey]);

    useEffect(() => {
        const timer = setInterval(
            () => setRefreshKey((key) => key + 1),
            REFRESH_MS,
        );
        return () => clearInterval(timer);
    }, []);

    return (
        <div className="page-container py-10">
            <div className="mb-8 flex items-start justify-between gap-4">
                <div>
                    <p className="section-label mb-2">Administration</p>
                    <h1
                        className="text-3xl font-semibold tracking-tight"
                        style={{ color: "var(--color-text)" }}
                    >
                        Queue Operations
                    </h1>
                    <p
                        className="text-sm mt-1"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        Background AI and render pipelines, refreshed every 30
                        seconds.
                    </p>
                </div>
                <button
                    onClick={() => setRefreshKey((key) => key + 1)}
                    className="btn btn-ghost btn-sm"
                >
                    Refresh
                </button>
            </div>

            {loading && !data
                ? (
                    <div className="space-y-3">
                        {[1, 2].map((i) => (
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
                : error
                ? (
                    <div
                        className="card p-6 text-sm"
                        style={{ background: "#FEE2E2", color: "#991B1B" }}
                    >
                        {error}
                        <button
                            onClick={() => setRefreshKey((key) => key + 1)}
                            className="btn btn-ghost btn-sm ml-3"
                        >
                            Retry
                        </button>
                    </div>
                )
                : data
                ? (
                    <>
                        <div
                            className="card p-4 mb-6 flex flex-wrap items-center gap-2 text-sm"
                            style={data.health.healthy
                                ? { background: "#DCFCE7", color: "#166534" }
                                : { background: "#FEE2E2", color: "#991B1B" }}
                        >
                            <strong>
                                {data.health.healthy
                                    ? "All queues healthy"
                                    : "Queue attention required"}
                            </strong>
                            <span style={{ opacity: 0.8 }}>
                                Checked {formatDate(data.health.checkedAt)}{" "}
                                · scheduler considered stale after{" "}
                                {formatDuration(data.health.staleAfterMs)}{" "}
                                without a run · backlog alert after{" "}
                                {formatDuration(data.health.backlogAfterMs)}
                            </span>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2 mb-8">
                            {data.health.queues.map((queue) => (
                                <QueueCard key={queue.queue} queue={queue} />
                            ))}
                        </div>

                        <Section
                            title="Failed AI book jobs"
                            count={data.failedAiJobs.length}
                            empty="No failed AI book jobs."
                        >
                            <table className="w-full text-sm">
                                <thead>
                                    <TableHead
                                        columns={[
                                            "Concept",
                                            "Owner",
                                            "Stage",
                                            "Attempts",
                                            "Error",
                                            "Failed",
                                        ]}
                                    />
                                </thead>
                                <tbody>
                                    {data.failedAiJobs.map((job) => (
                                        <tr
                                            key={job.id}
                                            className="align-top"
                                            style={{
                                                borderBottom:
                                                    "1px solid var(--color-border)",
                                            }}
                                        >
                                            <td className="px-5 py-4 max-w-xs">
                                                <div
                                                    className="font-medium truncate"
                                                    style={{
                                                        color:
                                                            "var(--color-text)",
                                                    }}
                                                >
                                                    {job.submission?.title ||
                                                        job.concept}
                                                </div>
                                                <div
                                                    className="text-xs truncate"
                                                    style={{
                                                        color:
                                                            "var(--color-text-subtle)",
                                                    }}
                                                >
                                                    {job.concept}
                                                </div>
                                            </td>
                                            <td
                                                className="px-5 py-4 text-xs"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                            >
                                                <div>
                                                    {job.user.name || "—"}
                                                </div>
                                                <div>{job.user.email}</div>
                                            </td>
                                            <td className="px-5 py-4 text-xs">
                                                {job.stage}
                                            </td>
                                            <td className="px-5 py-4 text-xs">
                                                {job.attempts}/{job.maxAttempts}
                                            </td>
                                            <td
                                                className="px-5 py-4 text-xs max-w-xs"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                                title={job.errorMessage ??
                                                    undefined}
                                            >
                                                {job.errorMessage || "—"}
                                            </td>
                                            <td
                                                className="px-5 py-4 text-xs"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                            >
                                                {formatDate(
                                                    job.completedAt ??
                                                        job.createdAt,
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Section>

                        <Section
                            title="Failed render jobs"
                            count={data.failedRenderJobs.length}
                            empty="No failed render jobs."
                        >
                            <table className="w-full text-sm">
                                <thead>
                                    <TableHead
                                        columns={[
                                            "Book",
                                            "Owner",
                                            "Attempts",
                                            "Error",
                                            "Failed",
                                        ]}
                                    />
                                </thead>
                                <tbody>
                                    {data.failedRenderJobs.map((job) => (
                                        <tr
                                            key={job.id}
                                            className="align-top"
                                            style={{
                                                borderBottom:
                                                    "1px solid var(--color-border)",
                                            }}
                                        >
                                            <td className="px-5 py-4 max-w-xs">
                                                <div
                                                    className="font-medium"
                                                    style={{
                                                        color:
                                                            "var(--color-text)",
                                                    }}
                                                >
                                                    {job.submission?.title ||
                                                        "Titchybooks"}
                                                </div>
                                                <div
                                                    className="text-xs"
                                                    style={{
                                                        color:
                                                            "var(--color-text-subtle)",
                                                    }}
                                                >
                                                    {job.submissionId}
                                                </div>
                                            </td>
                                            <td
                                                className="px-5 py-4 text-xs"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                            >
                                                <div>
                                                    {job.submission?.user
                                                        .name || "—"}
                                                </div>
                                                <div>
                                                    {job.submission?.user
                                                        .email || "—"}
                                                </div>
                                            </td>
                                            <td className="px-5 py-4 text-xs">
                                                {job.attempts}/{job.maxAttempts}
                                            </td>
                                            <td
                                                className="px-5 py-4 text-xs max-w-xs"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                                title={job.errorMessage ??
                                                    undefined}
                                            >
                                                {job.errorMessage || "—"}
                                            </td>
                                            <td
                                                className="px-5 py-4 text-xs"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                            >
                                                {formatDate(
                                                    job.completedAt ??
                                                        job.createdAt,
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Section>

                        <Section
                            title="Recent drain runs"
                            count={data.recentRuns.length}
                            empty="No drain runs recorded yet."
                        >
                            <table className="w-full text-sm">
                                <thead>
                                    <TableHead
                                        columns={[
                                            "Started",
                                            "Queue",
                                            "Duration",
                                            "Claimed",
                                            "Finished",
                                            "Yielded",
                                            "Status",
                                        ]}
                                    />
                                </thead>
                                <tbody>
                                    {data.recentRuns.map((run) => (
                                        <tr
                                            key={run.id}
                                            style={{
                                                borderBottom:
                                                    "1px solid var(--color-border)",
                                            }}
                                        >
                                            <td
                                                className="px-5 py-3 text-xs"
                                                style={{
                                                    color:
                                                        "var(--color-text-muted)",
                                                }}
                                            >
                                                {formatDate(run.startedAt)}
                                            </td>
                                            <td className="px-5 py-3 text-xs">
                                                {QUEUE_LABELS[run.queue] ??
                                                    run.queue}
                                            </td>
                                            <td className="px-5 py-3 text-xs">
                                                {formatDuration(run.durationMs)}
                                            </td>
                                            <td className="px-5 py-3 text-xs">
                                                {run.claimed}
                                            </td>
                                            <td className="px-5 py-3 text-xs">
                                                {run.finished}
                                            </td>
                                            <td className="px-5 py-3 text-xs">
                                                {run.yielded}
                                            </td>
                                            <td className="px-5 py-3 text-xs">
                                                <span
                                                    className="badge text-[10px]"
                                                    style={run.errored
                                                        ? UNHEALTHY_BADGE
                                                        : HEALTHY_BADGE}
                                                >
                                                    {run.errored
                                                        ? "error"
                                                        : "ok"}
                                                </span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Section>
                    </>
                )
                : null}
        </div>
    );
}

function QueueCard({ queue }: { queue: QueueHealth }) {
    return (
        <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
                <h2
                    className="font-semibold"
                    style={{ color: "var(--color-text)" }}
                >
                    {QUEUE_LABELS[queue.queue] ?? queue.queue}
                </h2>
                <span
                    className="badge text-[11px]"
                    style={queue.healthy ? HEALTHY_BADGE : UNHEALTHY_BADGE}
                >
                    {queue.healthy ? "Healthy" : "Attention"}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4">
                <Metric label="Runnable now" value={queue.due} />
                <Metric label="Processing" value={queue.processing} />
                <Metric label="Failed (24h)" value={queue.failedRecent} />
                <Metric label="Failed (total)" value={queue.failed} />
            </div>

            <div
                className="text-xs space-y-1"
                style={{
                    color: "var(--color-text-muted)",
                    borderTop: "1px solid var(--color-border)",
                    paddingTop: "0.75rem",
                }}
            >
                <div>
                    Last drain:{" "}
                    {queue.lastRun ? formatAge(queue.lastRunAgeMs) : "never"}
                    {queue.lastRun
                        ? ` · ${
                            formatDuration(queue.lastRun.durationMs)
                        } · claimed ${queue.lastRun.claimed}, finished ${queue.lastRun.finished}, yielded ${queue.lastRun.yielded}`
                        : ""}
                </div>
                <div>
                    Oldest runnable:{" "}
                    {queue.oldestDueAt
                        ? formatAge(queue.oldestDueAgeMs)
                        : "none"}
                </div>
                {queue.reasons.length > 0 && (
                    <ul className="mt-2 space-y-1" style={{ color: "#991B1B" }}>
                        {queue.reasons.map((reason) => (
                            <li key={reason}>
                                • {REASON_LABELS[reason] ?? reason}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

function Metric({ label, value }: { label: string; value: number }) {
    return (
        <div
            className="rounded-lg p-3"
            style={{ background: "var(--color-surface)" }}
        >
            <div
                className="text-xl font-semibold"
                style={{ color: "var(--color-text)" }}
            >
                {value}
            </div>
            <div
                className="text-[11px] uppercase tracking-wider"
                style={{ color: "var(--color-text-muted)" }}
            >
                {label}
            </div>
        </div>
    );
}

function Section({
    title,
    count,
    empty,
    children,
}: {
    title: string;
    count: number;
    empty: string;
    children: React.ReactNode;
}) {
    return (
        <div className="mb-8">
            <h2
                className="text-lg font-semibold mb-3"
                style={{ color: "var(--color-text)" }}
            >
                {title}
            </h2>
            {count === 0
                ? (
                    <div
                        className="card p-5 text-sm"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        {empty}
                    </div>
                )
                : (
                    <div className="card overflow-hidden">
                        <div className="overflow-x-auto">{children}</div>
                    </div>
                )}
        </div>
    );
}

function TableHead({ columns }: { columns: string[] }) {
    return (
        <tr
            style={{
                background: "var(--color-surface)",
                borderBottom: "1px solid var(--color-border)",
            }}
        >
            {columns.map((column) => (
                <th key={column} className="text-left px-5 py-3 section-label">
                    {column}
                </th>
            ))}
        </tr>
    );
}
