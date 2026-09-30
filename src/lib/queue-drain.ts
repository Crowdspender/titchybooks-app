// Bounded, resume-based queue drain for serverless hosts (e.g. Vercel) that
// cannot run the long-lived worker processes. A drain claims due jobs and
// processes them only as far as a wall-clock budget allows; when the budget is
// hit the in-flight job is abandoned and its lease expires, so the next drain
// invocation resumes it from the persisted stage. This mirrors the documented
// recovery model used by the standalone workers ("unfinished work is reclaimed
// when its lease expires").
//
// Security: drain routes are unauthenticated work triggers that spend LLM
// credits and write to the database, so they require a shared secret. If
// CRON_SECRET is unset the drain refuses to run rather than running open.

export interface DrainSummary {
  claimed: number;
  finished: number;
  yielded: number;
}

/** Wall-clock budget per drain invocation. Must stay below the function's maxDuration. */
export function drainBudgetMs(): number {
  const configured = Number(process.env.DRAIN_BUDGET_MS ?? 45_000);
  if (Number.isFinite(configured) && configured >= 5_000 && configured <= 240_000) return configured;
  return 45_000;
}

/** True only when CRON_SECRET is configured and the request presents it as a Bearer token. */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Claim and process jobs until the budget is exhausted or no due work remains.
 * `process` is expected to handle its own errors (both queue processors mark a
 * job FAILED rather than throwing), so a rejection is treated as "settled".
 */
export async function runDrain<T>(
  claim: () => Promise<T | null>,
  process: (job: T) => Promise<unknown>,
  budgetMs: number,
): Promise<DrainSummary> {
  const summary: DrainSummary = { claimed: 0, finished: 0, yielded: 0 };
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    let job: T | null;
    try {
      job = await claim();
    } catch {
      break; // transient DB error; stop and let the next invocation retry
    }
    if (!job) break; // no due work
    summary.claimed += 1;

    const remaining = deadline - Date.now();
    if (remaining <= 2_000) {
      // Not enough time to do meaningful work; leave the claim to lease-expiry
      // reclaim rather than starting a job we will immediately abandon.
      summary.yielded += 1;
      break;
    }

    const outcome = await new Promise<"settled" | "budget">((resolve) => {
      const timer = setTimeout(() => resolve("budget"), remaining);
      Promise.resolve()
        .then(() => process(job as T))
        .then(
          () => {
            clearTimeout(timer);
            resolve("settled");
          },
          () => {
            clearTimeout(timer);
            resolve("settled");
          },
        );
    });

    if (outcome === "budget") {
      // Abandon the in-flight job; its lease expires and a later drain resumes
      // it from the last persisted stage.
      summary.yielded += 1;
      break;
    }
    summary.finished += 1;
  }

  return summary;
}
