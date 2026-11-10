import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/auth";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Defense-in-depth CSRF check for cookie-authenticated API mutations.
 * The session cookie is already SameSite=Lax (browsers will not send it on
 * cross-site POSTs); on top of that we require any browser request bearing
 * an Origin/Referer to come from the same origin. Non-browser callers (the
 * cron drain workflow, server-to-server) send no Origin and rely on bearer
 * tokens instead. /api/auth/* keeps NextAuth's own CSRF-token protection.
 */
function isAllowedOrigin(req: NextRequest): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const path = req.nextUrl.pathname;
  if (!path.startsWith("/api/") || path.startsWith("/api/auth")) return true;

  const referer = req.headers.get("referer");
  let source = req.headers.get("origin");
  if (!source && referer) {
    try {
      source = new URL(referer).origin;
    } catch {
      source = null; // malformed referer: treated like no Origin below
    }
  }
  if (!source) return true;
  return source === req.nextUrl.origin;
}

export const proxy = auth(async (req) => {
  // Same-origin pre-check runs before the request reaches any API route.
  if (!isAllowedOrigin(req)) {
    return NextResponse.json(
      { error: "Cross-origin request blocked" },
      { status: 403 },
    );
  }

  // API routes perform their own authorization. Page routes are guarded here:
  // passing a custom handler to auth() bypasses NextAuth's `authorized`
  // callback, so a missing session must redirect explicitly.
  if (req.nextUrl.pathname.startsWith("/api")) return;
  if (!req.auth?.user) {
    const signInUrl = new URL("/login", req.nextUrl.origin);
    signInUrl.searchParams.set(
      "callbackUrl",
      new URL(
        `${req.nextUrl.pathname}${req.nextUrl.search}`,
        req.nextUrl.origin,
      ).href,
    );
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  // Include bare paths as well as nested paths so /create itself is guarded,
  // not only /create/something. /api/* is matched only for the same-origin
  // pre-check; API routes keep authorizing themselves.
  matcher: [
    "/dashboard",
    "/dashboard/:path*",
    "/create",
    "/create/:path*",
    "/admin",
    "/admin/:path*",
    "/api/:path*",
  ],
};
