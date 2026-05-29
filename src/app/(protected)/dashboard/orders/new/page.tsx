import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";
import OrderPanel from "@/components/orders/OrderPanel";

export default async function NewOrderPage({
    searchParams,
}: {
    searchParams: Promise<{ submissionId?: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) {
        redirect("/login");
    }

    const { submissionId } = await searchParams;
    if (!submissionId) {
        redirect("/dashboard");
    }

    const submission = await prisma.submission.findUnique({
        where: { id: submissionId },
        select: {
            id: true,
            title: true,
            userId: true,
            status: true,
            pdfS3Key: true,
        },
    });

    if (!submission) notFound();
    if (
        submission.userId !== session.user.id && session.user.role !== "ADMIN"
    ) {
        redirect("/dashboard");
    }

    return (
        <div className="page-container py-10">
            <div className="mb-6 flex items-start justify-between">
                <div>
                    <p className="section-label mb-2">Print &amp; Ship</p>
                    <h1
                        className="text-3xl font-semibold tracking-tight"
                        style={{ color: "var(--color-text)" }}
                    >
                        Order printed copies
                    </h1>
                    <p
                        className="mt-1 text-sm"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        {submission.title || "Titchybook"}
                    </p>
                </div>
                <Link
                    href="/dashboard"
                    className="btn btn-outline btn-sm"
                >
                    Back to dashboard
                </Link>
            </div>

            {submission.status !== SubmissionStatus.APPROVED && (
                <p
                    className="mb-4 rounded-xl px-4 py-3 text-sm"
                    style={{
                        background: "var(--color-accent-light)",
                        color: "#92400E",
                    }}
                >
                    This Titchybook isn&apos;t approved yet — you can preview
                    pricing, but ordering will unlock once an admin approves it.
                </p>
            )}

            <OrderPanel
                submission={{
                    id: submission.id,
                    status: submission.status,
                    pdfReady: Boolean(submission.pdfS3Key),
                }}
                submissionTitle={submission.title}
                standalone
            />
        </div>
    );
}
