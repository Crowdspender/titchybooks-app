"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

interface AiTemplate {
  id: string;
  title: string | null;
}

type AiBookPhase =
  | "queued"
  | "generating"
  | "repairing"
  | "waiting-for-render"
  | "reviewing"
  | "needs-review"
  | "completed"
  | "failed";

type Stage = "CONCEPT" | "CONTENT" | "COMPOSE" | "RENDER" | "QA";

interface JobStatus {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  stage: Stage;
  phase: {
    phase: AiBookPhase;
    label: string;
    message: string;
    terminal: boolean;
    retryable: boolean;
  };
  submissionId: string | null;
  title: string | null;
  errorMessage: string | null;
  attempts: { used: number; allowed: number };
  repairs: { used: number; allowed: number };
  createdAt: string;
  updatedAt: string;
  queue: {
    due: number;
    processing: number;
    oldestDueAgeMs: number | null;
    lastRunAgeMs: number | null;
    lastRunErrored: boolean;
    backlogAfterMs: number;
    stalled: boolean;
  };
  artifacts: {
    approved: boolean;
    printSheet: boolean;
    readingPdf: boolean;
    ready: boolean;
  };
}

const STAGES: Array<{ key: Stage; label: string }> = [
  { key: "CONCEPT", label: "Concept" },
  { key: "CONTENT", label: "Writing" },
  { key: "COMPOSE", label: "Layout" },
  { key: "RENDER", label: "Rendering" },
  { key: "QA", label: "Quality check" },
];

/** Phases that map onto a stage row in the checklist. */
const PHASE_STAGE: Partial<Record<AiBookPhase, Stage>> = {
  generating: "CONTENT",
  repairing: "CONTENT",
  "waiting-for-render": "RENDER",
  reviewing: "QA",
};

const POLL_START_MS = 1_500;
const POLL_MAX_MS = 15_000;
/** Long enough that a normal drain cadence is not reported as a stall. */
const SLOW_AFTER_MS = 5 * 60_000;

type Phase = "form" | "running" | "done" | "failed" | "review";

/**
 * One idempotency key per deliberate generation. A network retry re-sends the
 * same key so the server returns the existing job instead of paying for a
 * second book; "create another" deliberately mints a new one.
 */
function newRequestKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function AiCreatePage() {
  const [templates, setTemplates] = useState<AiTemplate[]>([]);
  const [concept, setConcept] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<JobStatus | null>(null);
  /** The job being tracked; a new object restarts polling even for the same id. */
  const [tracking, setTracking] = useState<{ id: string } | null>(null);

  const requestKeyRef = useRef<string>(newRequestKey());

  const rememberJob = useCallback((jobId: string | null) => {
    if (typeof window === "undefined") return;
    const url = jobId
      ? `/create/ai?job=${encodeURIComponent(jobId)}`
      : "/create/ai";
    window.history.replaceState(null, "", url);
  }, []);

  // The template catalogue only lists templates that passed AI preflight; an
  // incompatible one would fail the job after the concept was already paid for.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/templates/public?ai=1");
        const data = await res.json();
        if (!cancelled) setTemplates(data.templates || []);
      } catch {
        // Optional selector; ignore load failures.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resume after a refresh: the job id lives in the URL, so a reload mid-job
  // keeps tracking instead of looking like the request was lost. Deferred to a
  // task so the server-rendered form is not replaced during hydration.
  useEffect(() => {
    const resumeId = new URLSearchParams(window.location.search).get("job");
    if (!resumeId) return;
    const timer = setTimeout(() => {
      setPhase("running");
      setTracking({ id: resumeId });
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // One polling loop per tracked job. Transient failures back off; terminal
  // phases and authorization errors stop the loop instead of retrying forever.
  useEffect(() => {
    if (!tracking) return;
    let cancelled = false;
    let delay = POLL_START_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      try {
        const res = await fetch(`/api/ai/books/${tracking?.id}`, {
          cache: "no-store",
        });

        if (res.status === 401) {
          if (!cancelled) {
            setTracking(null);
            toast.error(
              "Your session expired. Sign in again to see this book.",
            );
          }
          return;
        }
        if (res.status === 403 || res.status === 404) {
          if (!cancelled) {
            setTracking(null);
            rememberJob(null);
            setPhase("failed");
            toast.error("This book is no longer available to your account.");
          }
          return;
        }

        if (!res.ok) throw new Error("status unavailable");

        const data = (await res.json()) as JobStatus;
        if (cancelled) return;

        delay = POLL_START_MS;
        setJob(data);

        if (data.phase.terminal) {
          setTracking(null);
          setPhase(
            data.phase.phase === "completed"
              ? "done"
              : data.phase.phase === "needs-review"
              ? "review"
              : "failed",
          );
          return;
        }
      } catch {
        // Transient (network, 5xx): back off instead of hammering the endpoint.
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }

      if (!cancelled) timer = setTimeout(tick, delay);
    }

    timer = setTimeout(tick, 750);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tracking, rememberJob]);

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
          requestKey: requestKeyRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start AI creation");

      const jobId = data.jobId as string;
      setJob(null);
      setPhase("running");
      rememberJob(jobId);
      setTracking({ id: jobId });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start AI creation",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setTracking(null);
    rememberJob(null);
    requestKeyRef.current = newRequestKey();
    setPhase("form");
    setJob(null);
    setConcept("");
  }

  function retry() {
    // A retry is a new generation: new key, same concept.
    requestKeyRef.current = newRequestKey();
    setTracking(null);
    void handleSubmit();
  }

  const currentStage = job
    ? (PHASE_STAGE[job.phase.phase] ?? "CONCEPT")
    : "CONCEPT";
  const currentStageIdx = STAGES.findIndex((entry) =>
    entry.key === currentStage
  );
  // Queue age comes from the server, so the hint does not depend on the
  // customer's clock or on a fixed "no progress for 45 s" guess.
  const waitingTooLong = phase === "running" &&
    job !== null &&
    !job.phase.terminal &&
    (job.queue.stalled ||
      (job.phase.phase === "queued" &&
        (job.queue.oldestDueAgeMs ?? 0) > SLOW_AFTER_MS));

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
            <Link href="/dashboard" className="btn btn-outline">
              Cancel
            </Link>
          </div>
        </div>
      )}

      {phase === "running" && (
        <div className="card p-6 max-w-2xl">
          <div className="flex items-center justify-between gap-3">
            <h2
              className="font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              {job?.title ?? "The AI is building your book"}
            </h2>
            <span className="badge badge-processing">
              {job?.phase.label ?? "Starting"}
            </span>
          </div>
          <p
            className="mt-1 text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            {job?.phase.message ?? "Starting up..."}
          </p>

          <ol className="mt-5 space-y-3">
            {STAGES.map((stage, index) => {
              const done = currentStageIdx > index;
              const active = currentStageIdx === index;
              return (
                <li key={stage.key} className="flex items-center gap-3 text-sm">
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-full border text-xs"
                    style={{
                      borderColor: done || active
                        ? "var(--color-primary)"
                        : "var(--color-border)",
                      background: done ? "var(--color-primary)" : "transparent",
                      color: done ? "#fff" : "var(--color-text-muted)",
                    }}
                  >
                    {done ? "\u2713" : index + 1}
                  </span>
                  <span
                    style={{
                      color: active
                        ? "var(--color-text)"
                        : "var(--color-text-muted)",
                    }}
                  >
                    {stage.label}
                    {active && (
                      <span className="ml-2 animate-pulse">
                        {job?.phase.label.toLowerCase() ?? "working"}...
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>

          {job && job.repairs.used > 0 && (
            <p
              className="mt-4 text-xs"
              style={{ color: "var(--color-text-muted)" }}
            >
              Revision {job.repairs.used} of{" "}
              {job.repairs.allowed}: quality checks asked for changes, so only
              the affected pages were rewritten.
            </p>
          )}

          {waitingTooLong && (
            <p
              className="mt-4 rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: "var(--color-border)",
                color: "var(--color-text-subtle)",
              }}
            >
              This is taking longer than usual. Your book is safe and will
              continue as soon as the queue picks it up — you can leave this
              page and come back from your dashboard.
            </p>
          )}

          <p
            className="mt-6 text-xs"
            style={{ color: "var(--color-text-subtle)" }}
          >
            This can take a few minutes. You can safely leave this page and
            check your dashboard later; the link to this book stays the same.
          </p>
        </div>
      )}

      {phase === "done" && (
        <div className="card p-6 max-w-2xl">
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
            {job?.title ?? "Your Titchybook"}{" "}
            passed quality checks. Both files come from the same approved
            version of your book.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {job?.artifacts.printSheet && (
              <a
                href={`/api/ai/books/${job.id}/downloads?kind=print`}
                className="btn btn-primary"
                download
              >
                Download print sheet (A4)
              </a>
            )}
            {job?.artifacts.readingPdf && (
              <a
                href={`/api/ai/books/${job.id}/downloads?kind=reading`}
                className="btn btn-outline"
                download
              >
                Download reading PDF (8 pages)
              </a>
            )}
          </div>

          <div
            className="mt-6 rounded-md border px-4 py-3 text-xs"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-text-muted)",
            }}
          >
            <p
              className="font-medium mb-1"
              style={{ color: "var(--color-text)" }}
            >
              Printing instructions
            </p>
            <p>
              Print the A4 sheet at <strong>100% scale</strong>{" "}
              (not &ldquo;fit to page&rdquo;), single-sided. Fold in half along
              the long edge, then in half again; cut the top edge to open the
              pages. The reading PDF is the same eight pages at 74 × 105 mm, in
              reading order, for screen reading or digital printing.
            </p>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {job?.submissionId && (
              <Link
                href={`/create?submissionId=${job.submissionId}`}
                className="btn btn-outline"
              >
                Open in editor
              </Link>
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

      {phase === "review" && (
        <div className="card p-6 max-w-2xl">
          <h2
            className="text-xl font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            This book needs a human review
          </h2>
          <p
            className="mt-2 text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            {job?.phase.message ??
              "Automated quality checks could not approve this book."}
          </p>
          <p
            className="mt-2 text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            Your draft is kept. We do not offer a download for books that have
            not passed the checks, so no file here would match what gets
            printed.
          </p>
          <div className="mt-6 flex items-center gap-2">
            <Link href="/dashboard" className="btn btn-primary">
              Go to dashboard
            </Link>
            <button onClick={reset} className="btn btn-outline">
              Start a new book
            </button>
          </div>
        </div>
      )}

      {phase === "failed" && (
        <div className="card p-6 max-w-2xl">
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
            {job?.phase.message ?? job?.errorMessage ??
              "Something went wrong. Please try again."}
          </p>
          {job && job.attempts.used > 0 && (
            <p
              className="mt-2 text-xs"
              style={{ color: "var(--color-text-subtle)" }}
            >
              {job.attempts.used} of {job.attempts.allowed} attempts were used.
            </p>
          )}
          <div className="mt-6 flex items-center gap-2">
            <button
              onClick={retry}
              disabled={submitting}
              className="btn btn-primary"
            >
              {submitting ? "Restarting..." : "Try again"}
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
