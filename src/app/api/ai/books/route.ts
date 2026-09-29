import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { z } from "zod";
import { enqueueAiBookJob, AiBookError } from "@/lib/ai/ai-book-job";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  concept: z.string().trim().min(1).max(2000),
  templateId: z.string().min(1).optional(),
});

// Simple per-user rate limiting (in-memory, resets on server restart),
// consistent with the AI chat route.
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 10_000;

// POST /api/ai/books - start an autonomous AI book creation job
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request format." }, { status: 400 });
  }

  const now = Date.now();
  if (now - (rateLimitMap.get(userId) ?? 0) < RATE_LIMIT_MS) {
    return NextResponse.json(
      { error: "Please wait a moment before creating another AI book." },
      { status: 429 },
    );
  }
  rateLimitMap.set(userId, now);

  try {
    const { jobId } = await enqueueAiBookJob(userId, body.concept, body.templateId);
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (err) {
    if (err instanceof AiBookError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("AI book enqueue failed", err);
    return NextResponse.json({ error: "Unable to start AI book creation." }, { status: 500 });
  }
}
