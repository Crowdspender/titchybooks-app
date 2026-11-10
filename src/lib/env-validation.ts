// Fail-fast startup validation of production runtime configuration.
//
// Rationale: several misconfigurations degrade silently and surface much
// later as user-facing failures — a missing CRON_SECRET makes the drain
// routes 401 so queues quietly stop, a missing AWS var breaks uploads only
// on first use, and an inconsistent lease/budget/heartbeat relationship
// causes jobs to be double-claimed or to stall until lease expiry. Validate
// these at process start instead.
//
// Non-production environments (dev, vitest, tsx scripts) only receive
// console warnings so local work is never blocked.

export interface EnvValidationResult {
  errors: string[];
  warnings: string[];
}

function parseNum(env: Record<string, string | undefined>, name: string, fallback: number): number | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Check an environment record (defaults to process.env) and return every
 * problem found. Errors = must not boot in production; warnings = degraded
 * features worth flagging loudly.
 */
export function validateRuntimeEnv(
  env: Record<string, string | undefined> = process.env,
): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Required for the app to serve any request correctly ---------------
  if (!env.DATABASE_URL) {
    errors.push("DATABASE_URL is not set (Prisma cannot connect).");
  }
  if (!env.NEXTAUTH_SECRET && !env.AUTH_SECRET) {
    errors.push("One of NEXTAUTH_SECRET / AUTH_SECRET must be set (sessions are unsigned).");
  } else if (
    (env.NEXTAUTH_SECRET ?? env.AUTH_SECRET ?? "").length < 16 ||
    (env.NEXTAUTH_SECRET ?? env.AUTH_SECRET ?? "").startsWith("change-me")
  ) {
    errors.push("Session secret is shorter than 16 chars or looks like a placeholder.");
  }
  // The drain routes fail closed without CRON_SECRET, which silently stops
  // both queues on a serverless host. Better to refuse to boot.
  if (!env.CRON_SECRET) {
    errors.push("CRON_SECRET is not set (queue drain endpoints will 401 and the queues will stall).");
  } else if (env.CRON_SECRET.startsWith("change-me")) {
    errors.push("CRON_SECRET looks like a placeholder.");
  }
  // Uploads/vault break without these; s3.ts reads them with ! assertions.
  for (const name of ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "S3_BUCKET_NAME"] as const) {
    if (!env[name]) {
      errors.push(`${name} is not set (S3 uploads and the PDF/vault storage depend on it).`);
    }
  }

  // --- Queue timing invariants --------------------------------------------
  // AI job: lease must comfortably exceed the heartbeat interval (>= 2 beats
  // per lease) and be finite; the drain budget must fit inside the 60s
  // function limit and finish before the lease so a live drainer is never
  // evicted mid-budget.
  const lease = parseNum(env, "AI_BOOK_LEASE_MS", 120_000);
  const heartbeat = parseNum(env, "AI_HEARTBEAT_MS", 60_000);
  const budget = parseNum(env, "DRAIN_BUDGET_MS", 45_000);
  if (lease === null) {
    errors.push("AI_BOOK_LEASE_MS is set but not a number.");
  } else if (lease < 30_000 || lease > 300_000) {
    errors.push(`AI_BOOK_LEASE_MS=${lease} is outside the supported 30000..300000 range.`);
  }
  if (heartbeat === null) {
    errors.push("AI_HEARTBEAT_MS is set but not a number.");
  }
  if (budget === null) {
    errors.push("DRAIN_BUDGET_MS is set but not a number.");
  } else if (budget < 5_000 || budget > 55_000) {
    errors.push("DRAIN_BUDGET_MS must be between 5000 and 55000 (the drain routes' maxDuration is 60s).");
  }
  if (lease !== null && heartbeat !== null && lease < 2 * heartbeat) {
    errors.push(`AI_BOOK_LEASE_MS (${lease}) must be at least twice AI_HEARTBEAT_MS (${heartbeat}).`);
  }
  if (lease !== null && budget !== null && lease <= budget) {
    errors.push(`AI_BOOK_LEASE_MS (${lease}) must exceed DRAIN_BUDGET_MS (${budget}) or a draining job can be double-claimed.`);
  }

  // --- Optional features degrade gracefully --------------------------------
  if (!env.OPENAI_API_KEY) {
    warnings.push("OPENAI_API_KEY is not set: AI Titchybooks and the AI chat are disabled.");
  }
  if (!env.RESEND_API_KEY) {
    warnings.push("RESEND_API_KEY is not set: transactional emails are skipped (non-blocking by design).");
  }
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    warnings.push("Stripe is not fully configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET): online checkout is disabled; orders stay manual-review.");
  }

  return { errors, warnings };
}

/**
 * Boot-time assertion: in production, throw on any error so the deploy fails
 * loudly; elsewhere, log warnings for missing configuration and continue.
 */
export function assertProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  const { errors, warnings } = validateRuntimeEnv(env);
  for (const warning of warnings) {
    console.warn(`[env] ${warning}`);
  }
  if (errors.length === 0) return;
  const summary = errors.map((e) => `  - ${e}`).join("\n");
  if (env.NODE_ENV === "production") {
    throw new Error(`Invalid production configuration:\n${summary}`);
  }
  console.warn(`[env] Non-production boot with configuration issues:\n${summary}`);
}
