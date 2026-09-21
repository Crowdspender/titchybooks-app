"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { draftPointerStorage } from "@/lib/editor/persistence";
import Link from "next/link";

const ACTIVE_DRAFT_STORAGE_KEY = "titchybook-active-editor-draft";

const subscribe = (callback: () => void) => {
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
};
const getSnapshot = () => draftPointerStorage.getItem(ACTIVE_DRAFT_STORAGE_KEY);

export default function ContinueEditingButton() {
  const draftId = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const [isValidDraft, setIsValidDraft] = useState<boolean>(false);
  const [checking, setChecking] = useState<boolean>(true);

  useEffect(() => {
    if (!draftId) return;
    const controller = new AbortController();
    fetch(`/api/submissions/${draftId}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) return false;
        return res.json();
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data?.submission?.status === "DRAFT") {
          setIsValidDraft(true);
        } else {
          draftPointerStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
          setIsValidDraft(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setIsValidDraft(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [draftId]);

  if (checking || !draftId || !isValidDraft) {
    return null;
  }

  return (
    <Link
      href={`/create?submissionId=${draftId}`}
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
      Continue editing
    </Link>
  );
}
