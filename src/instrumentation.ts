// Next.js server-start hook (Node runtime). Reports configuration problems
// instead of throwing: a serverless function that refuses to boot would turn
// one missing variable into an outage of every dynamic route.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // next build imports the app graph to prerender pages; the deployment
  // configuration is only meaningful for the running server.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { reportProductionEnv } = await import("@/lib/env-validation");
  reportProductionEnv();
}
