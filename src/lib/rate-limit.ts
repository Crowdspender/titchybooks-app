import { NextResponse } from "next/server";
import { prisma } from "./prisma";

/**
 * Durable fixed-window rate limiting backed by the primary database.
 *
 * In-memory maps do not survive cold starts and cannot coordinate across
 * serverless instances (Vercel) or between the web app and the standalone
 * workers, so every bucket lives in `RateLimitBucket` and is consumed with a
 * single atomic UPSERT. Worst case under concurrency is an off-by-one that
 * lets one extra request through — acceptable for abuse throttling, where
 * limits are safety rails rather than billing quotas.
 */
export interface RateLimitWindow {
  /** Maximum number of requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until the window resets (0 when allowed). */
  retryAfterMs: number;
}

export async function consumeRateLimit(
  bucketKey: string,
  { limit, windowMs }: RateLimitWindow,
): Promise<RateLimitResult> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowMs);

  // Atomic "reset when expired, otherwise increment" upsert.
  const rows = await prisma.$queryRaw<{ count: number; expiresAt: Date }[]>`
    INSERT INTO "RateLimitBucket" AS b ("bucketKey", "windowStart", "count", "expiresAt")
    VALUES (${bucketKey}, ${now}, 1, ${windowEnd})
    ON CONFLICT ("bucketKey") DO UPDATE SET
      "windowStart" = CASE WHEN b."expiresAt" <= ${now} THEN ${now}         ELSE b."windowStart" END,
      "count"       = CASE WHEN b."expiresAt" <= ${now} THEN 1              ELSE b."count" + 1   END,
      "expiresAt"   = CASE WHEN b."expiresAt" <= ${now} THEN ${windowEnd}   ELSE b."expiresAt"   END
    RETURNING "count", "expiresAt"`;

  // Opportunistic cleanup so the table does not grow without bound; the
  // expiresAt index keeps the delete cheap.
  if (Math.random() < 0.01) {
    prisma.$executeRaw`DELETE FROM "RateLimitBucket" WHERE "expiresAt" < ${now}`.catch(
      () => undefined,
    );
  }

  const row = rows[0];
  if (!row) {
    // Should not happen (UPSERT always returns), but fail closed.
    return { allowed: false, remaining: 0, retryAfterMs: windowMs };
  }
  const allowed = row.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - row.count),
    retryAfterMs: allowed
      ? 0
      : Math.max(0, new Date(row.expiresAt).getTime() - now.getTime()),
  };
}

/** Best-effort client identity for anonymous endpoints (register, password reset). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim();
  return ip || "unknown";
}

/** Standard 429 response with a Retry-After header, for route handlers. */
export function tooManyRequests(
  result: RateLimitResult,
  message = "Too many requests - please try again later.",
): NextResponse {
  const res = NextResponse.json({ error: message }, { status: 429 });
  res.headers.set("retry-after", String(Math.ceil(result.retryAfterMs / 1000)));
  return res;
}
