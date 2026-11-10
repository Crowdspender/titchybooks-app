"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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

  async function toggle() {
    setSaving(true);
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
          ? "Removed from the public vault directory."
          : "Added to the public vault directory.",
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not update visibility",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={saving}
      className={`btn btn-sm ${
        consent ? "btn-primary" : "btn-outline"
      } disabled:opacity-50`}
      aria-pressed={consent}
    >
      {saving ? "Saving..." : consent ? "Public ✓" : "Make public"}
    </button>
  );
}
