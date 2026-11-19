"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { draftPointerStorage } from "@/lib/editor/persistence";
import Link from "next/link";

const ACTIVE_DRAFT_STORAGE_KEY = "titchybook-active-editor-draft";

const subscribe = (callback: () => void) => {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
};
const getSnapshot = () => draftPointerStorage.getItem(ACTIVE_DRAFT_STORAGE_KEY);

export default function ContinueEditingButton() {
  const draftId = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const [check, setCheck] = useState<
    | { id: string; state: "valid" | "unavailable" | "error"; message: string }
    | null
  >(null);

  useEffect(() => {
    if (!draftId) return;
    const controller = new AbortController();
    fetch(`/api/submissions/${encodeURIComponent(draftId)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            res.status === 401 || res.status === 403
              ? "Sign in with the draft owner’s account to resume. Your saved draft pointer is retained."
              : "Could not check the saved draft. Retry to review it; your pointer and local recovery are retained.",
          );
        }
        const data = await res.json();
        if (typeof data?.submission?.status !== "string") {
          throw new Error(
            "Could not verify the saved draft. Retry to review it.",
          );
        }
        if (controller.signal.aborted) return;
        setCheck({
          id: draftId,
          state: data.submission.status === "DRAFT" ? "valid" : "unavailable",
          message: data.submission.status === "DRAFT"
            ? ""
            : "This book is no longer a draft. Review the saved draft without changing the original.",
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setCheck({
            id: draftId,
            state: "error",
            message: error instanceof Error
              ? error.message
              : "Could not check the saved draft. Retry to review it.",
          });
        }
      });
    return () => controller.abort();
  }, [draftId]);

  if (!draftId) return null;
  const current = check?.id === draftId ? check : null;

  return (
    <div>
      <Link
        href={`/create?submissionId=${encodeURIComponent(draftId)}`}
        className="btn btn-success btn-sm"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M7 1v12M1 7h12" />
        </svg>
        {!current
          ? "Checking saved draft…"
          : current.state === "valid"
          ? "Continue editing"
          : current.state === "unavailable"
          ? "Review saved draft"
          : "Retry saved draft"}
      </Link>
      {current?.message && (
        <p
          role="status"
          className="mt-1 text-xs"
          style={{ color: "var(--color-text-muted)" }}
        >
          {current.message}
        </p>
      )}
    </div>
  );
}
