import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/queue-drain";
import { collectQueueHealth } from "@/lib/queue-health";

// Machine-readable queue health for external monitors and the drain workflow.
// Fail closed: without CRON_SECRET the endpoint reports itself unconfigured
// instead of exposing operational data or pretending the queues are healthy.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "Queue health checks are not configured" },
      { status: 503 },
    );
  }
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const report = await collectQueueHealth();
  return NextResponse.json(report, { status: report.healthy ? 200 : 503 });
}
