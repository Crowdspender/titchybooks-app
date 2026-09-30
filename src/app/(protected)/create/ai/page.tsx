"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

interface PublicTemplate {
  id: string;
  title: string | null;
}

interface JobStatus {
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  stage: "CONCEPT" | "CONTENT" | "COMPOSE" | "RENDER" | "QA";
  submissionId: string | null;
  errorMessage: string | null;
}

const STAGES: Array<{ key: JobStatus["stage"]; label: string }> = [
  { key: "CONCEPT", label: "Concept" },
  { key: "CONTENT", label: "Writing" },
  { key: "COMPOSE", label: "Layout" },
  { key: "RENDER", label: "Rendering" },
  { key: "QA", label: "Quality check" },
];

type Phase = "form" | "running" | "done" | "failed";

export default function AiCreatePage() {
  const [templates, setTemplates] = useState<PublicTemplate[]>([]);
  const [concept, setConcept] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [workerStale, setWorkerStale] = useState(false);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queuedAtRef = useRef<number | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/templates/public");
        const data = await res.json();
        setTemplates(data.templates || []);
      } catch {
        // Optional selector; ignore load failures.
      }
    }
    load();
    return () => clearTimeout(timerRef.current);
  }, []);

  function stopPolling() {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }

  async function poll(jobId: string) {
    try {
      const res = await fetch(`/api/ai/books/${jobId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("status unavailable");
      const data = (await res.json()) as JobStatus;
      setJob(data);

      // Distinguish "queued, waiting for a worker" from "actively processing".
      // If a job sits in QUEUED too long, no background worker is claiming jobs.
      if (data.status === "QUEUED") {
        if (queuedAtRef.current && Date.now() - queuedAtRef.current > 45_000) {
          setWorkerStale(true);
        }
      } else {
        setWorkerStale(false);
      }

      if (data.status === "COMPLETED") {
        stopPolling();
        setSubmissionId(data.submissionId);
        setPhase("done");
        if (data.submissionId) {
          try {
            const rs = await fetch(
              `/api/submissions/${data.submissionId}/render-status`,
              { cache: "no-store" },
            );
            const rsData = await rs.json();
            if (rsData.pdfUrl) setPdfUrl(rsData.pdfUrl as string);
          } catch {
            // Download link is optional.
          }
        }
        return;
      }
      if (data.status === "FAILED") {
        stopPolling();
        setPhase("failed");
        return;
      }
    } catch {
      // Transient; keep polling.
    }
    timerRef.current = setTimeout(() => void poll(jobId), 3000);
  }

  async function handleSubmit() {
    const trimmed = concept.trim();
    if (!trimmed) {
      toast.error("Describe your book idea first.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/ai/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept: trimmed,
          templateId: templateId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start AI creation");
      setJob(null);
      setPdfUrl(null);
      setSubmissionId(null);
      setWorkerStale(false);
      queuedAtRef.current = Date.now();
      setPhase("running");
      timerRef.current = setTimeout(
        () => void poll(data.jobId as string),
        1500,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start AI creation",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    stopPolling();
    setPhase("form");
    setJob(null);
    setPdfUrl(null);
    setSubmissionId(null);
    setWorkerStale(false);
    queuedAtRef.current = null;
  }

  const currentStageIdx = job
    ? STAGES.findIndex((s) => s.key === job.stage)
    : -1;

  return (
    <div className="page-container py-10">
      <div className="mb-8">
        <p className="section-label mb-2">Autonomous creation</p>
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Create with AI
        </h1>
        <p
          className="mt-1.5 text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          Describe your idea and the AI will write, lay out, render, and
          quality-check a print-ready Titchybook automatically.
        </p>
      </div>

      {phase === "form" && (
        <div className="card p-6 max-w-2xl">
          <label
            className="block text-sm font-medium mb-2"
            style={{ color: "var(--color-text)" }}
          >
            Your book concept
          </label>
          <textarea
            value={concept}
            onChange={(e) => setConcept(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="e.g. A gentle bedtime story about a lonely lighthouse that makes friends with the stars."
            className="w-full rounded-md border px-3 py-2 text-sm"
            style={{
              borderColor: "var(--color-border)",
              background: "var(--color-bg)",
              color: "var(--color-text)",
            }}
          />
          <p
            className="mt-1 text-xs"
            style={{ color: "var(--color-text-subtle)" }}
          >
            {concept.length}/2000
          </p>

          {templates.length > 0 && (
            <>
              <label
                className="block text-sm font-medium mt-4 mb-2"
                style={{ color: "var(--color-text)" }}
              >
                Template (optional)
              </label>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
                style={{
                  borderColor: "var(--color-border)",
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                }}
              >
                <option value="">Let the AI choose</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title || "Untitled template"}
                  </option>
                ))}
              </select>
            </>
          )}

          <div className="mt-6 flex items-center gap-2">
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="btn btn-primary"
            >
              {submitting ? "Starting..." : "Create my book"}
            </button>
            <Link href="/dashboard" className="btn btn-outline">Cancel</Link>
          </div>
        </div>
      )}

      {phase === "running" && (
        <div className="card p-6 max-w-2xl">
          <h2
            className="font-semibold mb-4"
            style={{ color: "var(--color-text)" }}
          >
            The AI is building your book...
          </h2>
          <ol className="space-y-3">
            {STAGES.map((s, i) => {
              const done = currentStageIdx > i || job?.status === "COMPLETED";
              const active = currentStageIdx === i &&
                job?.status !== "COMPLETED";
              return (
                <li key={s.key} className="flex items-center gap-3 text-sm">
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-full border text-xs"
                    style={{
                      borderColor: done
                        ? "var(--color-primary)"
                        : "var(--color-border)",
                      background: done ? "var(--color-primary)" : "transparent",
                      color: done ? "#fff" : "var(--color-text-muted)",
                    }}
                  >
                    {done ? "\u2713" : i + 1}
                  </span>
                  <span
                    style={{
                      color: active
                        ? "var(--color-text)"
                        : "var(--color-text-muted)",
                    }}
                  >
                    {s.label}
                    {active && (
                      <span className="ml-2 animate-pulse">
                        {job?.status === "QUEUED"
                          ? workerStale ? "waiting for worker..." : "queued..."
                          : "working..."}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
          {workerStale && (
            <p
              className="mt-4 rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: "var(--color-border)",
                color: "var(--color-text-subtle)",
              }}
            >
              This job is queued but no background worker has claimed it yet.
              The AI worker process may not be running in this environment.
            </p>
          )}
          <p
            className="mt-6 text-xs"
            style={{ color: "var(--color-text-subtle)" }}
          >
            This can take a minute. You can safely leave this page and check
            your dashboard later.
          </p>
        </div>
      )}

      {phase === "done" && (
        <div className="card p-6 max-w-2xl text-center">
          <h2
            className="text-xl font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            Your book is ready
          </h2>
          <p
            className="mt-2 text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            The AI finished writing, layout, rendering, and quality checks. It
            is approved and print-ready.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {submissionId && (
              <Link
                href={`/create?submissionId=${submissionId}`}
                className="btn btn-primary"
              >
                View in editor
              </Link>
            )}
            {pdfUrl && (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline"
              >
                Download PDF
              </a>
            )}
            <Link href="/dashboard" className="btn btn-outline">
              Go to dashboard
            </Link>
            <button onClick={reset} className="btn btn-outline">
              Create another
            </button>
          </div>
        </div>
      )}

      {phase === "failed" && (
        <div className="card p-6 max-w-2xl text-center">
          <h2
            className="text-xl font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            We couldn&apos;t finish this book
          </h2>
          <p
            className="mt-2 text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            {job?.errorMessage || "Something went wrong. Please try again."}
          </p>
          <div className="mt-6 flex items-center justify-center gap-2">
            <button onClick={reset} className="btn btn-primary">
              Try again
            </button>
            <Link href="/dashboard" className="btn btn-outline">
              Go to dashboard
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
