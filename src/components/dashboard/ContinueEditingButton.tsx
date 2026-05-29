"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const ACTIVE_DRAFT_STORAGE_KEY = "titchybook-active-editor-draft";

export default function ContinueEditingButton() {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [isValidDraft, setIsValidDraft] = useState<boolean>(false);
  const [checking, setChecking] = useState<boolean>(true);

  useEffect(() => {
    const storedId = localStorage.getItem(ACTIVE_DRAFT_STORAGE_KEY);
    if (!storedId) {
      setChecking(false);
      return;
    }

    setDraftId(storedId);

    fetch(`/api/submissions/${storedId}`)
      .then((res) => {
        if (!res.ok) return false;
        return res.json();
      })
      .then((data) => {
        if (data?.submission?.status === "DRAFT") {
          setIsValidDraft(true);
        } else {
          localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
          setIsValidDraft(false);
        }
      })
      .catch(() => {
        setIsValidDraft(false);
      })
      .finally(() => {
        setChecking(false);
      });
  }, []);

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
