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
        <div className="max-w-4xl mx-auto px-4 py-8">
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">Order printed copies</h1>
                    <p className="text-sm text-stone-500">
                        {submission.title || "Titchybook"}
                    </p>
                </div>
                <Link
                    href="/dashboard"
                    className="text-sm text-stone-600 hover:underline"
                >
                    Back to dashboard
                </Link>
            </div>

            {submission.status !== SubmissionStatus.APPROVED && (
                <p className="mb-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
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
