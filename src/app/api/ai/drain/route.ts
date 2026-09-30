import { NextResponse } from "next/server";
import { claimAiBookJob } from "@/lib/ai/ai-book-job";
import { processAiBookJob } from "@/lib/ai/pipeline";
import { drainBudgetMs, isCronAuthorized, runDrain } from "@/lib/queue-drain";

// Serverless drain for the AI book queue. Invoked on a schedule (see
// .github/workflows/drain.yml) because Vercel cannot host the long-lived
// `npm run worker:ai` process.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function drain(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await runDrain(claimAiBookJob, processAiBookJob, drainBudgetMs());
  return NextResponse.json({ queue: "ai", ...summary });
}

export async function POST(req: Request) {
  return drain(req);
}

export async function GET(req: Request) {
  return drain(req);
}
