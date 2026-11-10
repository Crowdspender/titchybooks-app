import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Public readiness probe for uptime monitors. It does not expose configuration
 * or queue state: only whether the instance can reach the primary database.
 * Queue-specific health stays behind CRON_SECRET at /api/queue/health.
 */
export async function GET() {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(
      {
        status: "ok",
        checks: { database: "up" },
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    // Log the event without the error: connection strings and driver details
    // must not reach logs or the response body.
    console.error(JSON.stringify({ event: "health-check-failed", check: "database" }));
    return NextResponse.json(
      {
        status: "error",
        checks: { database: "down" },
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
