// Next.js server-start hook (Node runtime). Used here to fail fast on
// invalid production configuration; keep side-effect free otherwise.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // next build imports the app graph to prerender pages; the deployment
  // configuration is only meaningful for the running server.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { assertProductionEnv } = await import("@/lib/env-validation");
  assertProductionEnv();
}
