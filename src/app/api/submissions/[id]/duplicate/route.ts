import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { duplicateAsDraft, errorResponse } from "@/lib/editor/submission-store";
import { consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// POST /api/submissions/[id]/duplicate
// Copies an editor book into a new DRAFT the caller owns. This is how a
// finished (APPROVED) book is opened in the editor: the approved artifacts stay
// bound to the original, so the editable version is always a separate row.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // A copy is a new submission, so it shares the creation cap instead of
  // giving callers a way around it.
  const rl = await consumeRateLimit(`submission:user:${session.user.id}`, {
    limit: 20,
    windowMs: 60 * 60_000,
  });
  if (!rl.allowed) {
    return tooManyRequests(rl, "Too many submissions - please try again later.");
  }

  try {
    const { id } = await params;
    const submissionId = await duplicateAsDraft(id, {
      id: session.user.id,
      role: session.user.role,
    });

    return NextResponse.json({ submission: { id: submissionId } }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
