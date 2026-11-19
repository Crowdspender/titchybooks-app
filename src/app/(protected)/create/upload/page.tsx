import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import UploadGrid from "@/components/create/UploadGrid";

export default async function UploadPage({ searchParams }: {
    searchParams: Promise<{ replaces?: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) redirect("/login");
    const { replaces } = await searchParams;
    const original = replaces
        ? await prisma.submission.findFirst({
            where: {
                id: replaces,
                userId: session.user.id,
                status: "REJECTED",
                mode: "LEGACY_UPLOAD",
                isTemplate: false,
            },
            select: { title: true, rejectionReason: true },
        })
        : null;
    if (replaces && !original) notFound();

    return (
        <div className="page-container py-10">
            <p className="section-label mb-2">Eight-page image upload</p>
            <h1 className="text-3xl font-semibold tracking-tight">
                {original ? "Re-upload corrected images" : "Upload a booklet"}
            </h1>
            <p
                className="mt-2 mb-4 text-sm"
                style={{ color: "var(--color-text-muted)" }}
            >
                Upload eight complete page images as a separate submission. Your
                original books, review evidence, and PDFs stay unchanged.
            </p>
            {original && (
                <div className="card p-4 mb-4">
                    <p className="font-medium">
                        Corrections for{" "}
                        {original.title || "Untitled Titchybooks"}
                    </p>
                    <p className="mt-1 text-sm">
                        {original.rejectionReason ||
                            "Review the feedback before submitting your corrected images."}
                    </p>
                </div>
            )}
            <Link href="/dashboard" className="btn btn-outline btn-sm mb-6">
                Back to dashboard
            </Link>
            <UploadGrid />
        </div>
    );
}
