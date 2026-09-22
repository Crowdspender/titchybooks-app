"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#ffffff",
          color: "#1a1f2e",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 56,
              height: 56,
              borderRadius: 16,
              background: "#FEE2E2",
              marginBottom: 20,
            }}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#DC2626"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
              aria-label="Error icon"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>

          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 600,
              marginBottom: 8,
              letterSpacing: "-0.01em",
            }}
          >
            Something went seriously wrong
          </h1>
          <p
            style={{
              fontSize: "0.875rem",
              color: "#64748b",
              maxWidth: 360,
              margin: "0 auto 24px",
              lineHeight: 1.6,
            }}
          >
            {/* Fixed user-safe copy; raw error details stay in server logs (digest) */}
            An unexpected error occurred. Please try again.
          </p>

          <button
            onClick={reset}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0.625rem 1.5rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              color: "#ffffff",
              background: "#0891b2",
              border: "none",
              borderRadius: 10,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
