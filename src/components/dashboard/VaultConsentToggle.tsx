"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Owner opt-in for the public /vault directory listing. Off by default;
 * flipping it on publishes the entry's title and author name.
 */
export default function VaultConsentToggle({
  entryId,
  consent,
}: {
  entryId: string;
  consent: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const inFlight = useRef(false);

  async function toggle() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/vault/${entryId}/consent`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: !consent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not update visibility");
      }
      router.refresh();
      toast.success(
        consent
          ? "Public listing consent removed."
          : "Public listing consent granted.",
      );
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Could not update visibility";
      setError(message);
      toast.error(message);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <div>
      <button
        onClick={toggle}
        disabled={saving}
        className={`btn btn-sm ${
          consent ? "btn-primary" : "btn-outline"
        } disabled:opacity-50`}
        aria-pressed={consent}
        aria-describedby={error ? errorId : undefined}
      >
        {saving ? "Saving..." : consent ? "Consent granted ✓" : "Make public"}
      </button>
      {error && (
        <p id={errorId} role="alert" className="text-sm mt-2">
          {error} Please retry.
        </p>
      )}
    </div>
  );
}
