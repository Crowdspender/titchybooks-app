import { NextResponse } from "next/server";
import { claimRenderJob, processRenderJob } from "@/lib/pdf/render-job";
import { drainBudgetMs, isCronAuthorized, runDrain } from "@/lib/queue-drain";
import { recordDrainRun } from "@/lib/queue-health";

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
  // Wrapper drops the drain deadline: the render processor has no budget-yield
  // path (renders are short), and its optional second parameter is a test hook.
  const summary = await runDrain(claimRenderJob, (job) => processRenderJob(job), drainBudgetMs());
  // Persist the run as the scheduler heartbeat; never blocks the response.
  await recordDrainRun("render", summary);
  return NextResponse.json({ queue: "render", ...summary });
}

export async function POST(req: Request) {
  return drain(req);
}

export async function GET(req: Request) {
  return drain(req);
}
