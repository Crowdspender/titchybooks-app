import { NextResponse } from "next/server";
import { claimRenderJob, processRenderJob } from "@/lib/pdf/render-job";
import { drainBudgetMs, isCronAuthorized, runDrain } from "@/lib/queue-drain";

// Serverless drain for the render queue. Invoked on a schedule (see
// .github/workflows/drain.yml) because Vercel cannot host the long-lived
// `npm run worker:render` process. The AI book RENDER stage depends on this.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function drain(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await runDrain(claimRenderJob, processRenderJob, drainBudgetMs());
  return NextResponse.json({ queue: "render", ...summary });
}

export async function POST(req: Request) {
  return drain(req);
}

export async function GET(req: Request) {
  return drain(req);
}
