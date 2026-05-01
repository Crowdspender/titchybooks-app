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

    // Validate that the draft still exists and is in DRAFT status
    fetch(`/api/submissions/${storedId}`)
      .then((res) => {
        if (!res.ok) {
          // Draft doesn't exist or user doesn't have access
          return false;
        }
        return res.json();
      })
      .then((data) => {
        if (data?.submission?.status === "DRAFT") {
          setIsValidDraft(true);
        } else {
          // Draft was submitted or deleted - clear localStorage
          localStorage.removeItem(ACTIVE_DRAFT_STORAGE_KEY);
          setIsValidDraft(false);
        }
      })
      .catch(() => {
        // Network error or other issue - hide the button
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
      className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 text-sm"
    >
      Continue Editing
    </Link>
  );
}
