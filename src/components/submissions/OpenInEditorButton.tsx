"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { draftPointerStorage } from "@/lib/editor/persistence";
import { toast } from "sonner";

/**
 * Open a finished book in the editor.
 *
 * The editor refuses anything that is not a draft, and an approved book's PDFs
 * are bound to its revision — so this copies the book into a fresh draft and
 * opens that. The finished book, its artifacts and any order against it are
 * left exactly as they were.
 */
export default function OpenInEditorButton({
    submissionId,
    label = "Open in editor",
    className = "btn btn-outline",
}: {
    submissionId: string;
    label?: string;
    className?: string;
}) {
    const router = useRouter();
    const [opening, setOpening] = useState(false);
    const openingRef = useRef(false);
    const [openError, setOpenError] = useState<string | null>(null);

    async function handleClick() {
        if (openingRef.current) return;
        openingRef.current = true;
        setOpening(true);
        setOpenError(null);
        try {
            const response = await fetch(
                `/api/submissions/${submissionId}/duplicate`,
                {
                    method: "POST",
                },
            );
            const data = (await response.json().catch(() => null)) as {
                submission?: { id?: string };
                error?: string;
            } | null;
            const copyId = data?.submission?.id;

            if (!response.ok || !copyId) {
                throw new Error(
                    data?.error ?? "Could not open this book in the editor",
                );
            }

            draftPointerStorage.setItem(
                "titchybook-active-editor-draft",
                copyId,
            );
            router.push(`/create?submissionId=${encodeURIComponent(copyId)}`);
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : "Could not open this book in the editor";
            setOpenError(
                `${message}. The original book is unchanged; retry creating a copy.`,
            );
            toast.error(message);
            openingRef.current = false;
            // Stay put so the user can retry; on success the navigation unmounts this.
            setOpening(false);
        }
    }

    return (
        <div>
            <button
                type="button"
                onClick={handleClick}
                disabled={opening}
                aria-busy={opening}
                className={className}
            >
                {opening ? "Opening..." : label}
            </button>
            {openError && (
                <p role="alert" className="mt-1 text-xs">{openError}</p>
            )}
        </div>
    );
}
