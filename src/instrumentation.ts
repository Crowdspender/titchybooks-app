// Next.js server-start hook (Node runtime). Reports configuration problems
// instead of throwing: a serverless function that refuses to boot would turn
// one missing variable into an outage of every dynamic route.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // next build imports the app graph to prerender pages; the deployment
  // configuration is only meaningful for the running server.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { reportProductionEnv, isWeakSessionSecret, resolveSessionSecret } = await import("@/lib/env-validation");
  reportProductionEnv();
  // Narrow exception to the report-don't-throw rule: a placeholder or short
  // session secret makes every session cookie forgeable, which is worse than
  // a boot failure. Reject it before any request is served; all other
  // configuration gaps stay non-blocking. resolveSessionSecret uses NextAuth's
  // own precedence (AUTH_SECRET first, then NEXTAUTH_SECRET) so the guard
  // checks exactly the secret the bound auth configuration will sign with.
  const secret = resolveSessionSecret(process.env);
  if (process.env.NODE_ENV === "production" && isWeakSessionSecret(secret)) {
    throw new Error(
      "Refusing to boot: the effective AUTH_SECRET/NEXTAUTH_SECRET is a placeholder or shorter than 16 chars (sessions would be forgeable).",
    );
  }
}
