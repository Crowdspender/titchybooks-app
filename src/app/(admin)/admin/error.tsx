"use client";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page-container py-16 flex flex-col items-center text-center">
      {/* Icon */}
      <div
        className="inline-flex items-center justify-center w-14 h-14 rounded-2xl mb-5"
        style={{ background: "var(--color-error-light)" }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-error)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      </div>

      <h1
        className="text-2xl font-semibold tracking-tight mb-2"
        style={{ color: "var(--color-text)" }}
      >
        Something went wrong
      </h1>
      <p
        className="text-sm max-w-sm mb-6"
        style={{ color: "var(--color-text-muted)" }}
      >
        {error.message || "We couldn't load this page. Please try again."}
      </p>

      <button
        onClick={reset}
        className="btn btn-primary"
      >
        Try again
      </button>
    </div>
  );
}
