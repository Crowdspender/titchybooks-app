"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
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

    async function handleClick() {
        setOpening(true);
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

            router.push(`/create?submissionId=${copyId}`);
        } catch (error) {
            toast.error(
                error instanceof Error
                    ? error.message
                    : "Could not open this book in the editor",
            );
            // Stay put so the user can retry; on success the navigation unmounts this.
            setOpening(false);
        }
    }

    return (
        <button
            type="button"
            onClick={handleClick}
            disabled={opening}
            aria-busy={opening}
            className={className}
        >
            {opening ? "Opening..." : label}
        </button>
    );
}
