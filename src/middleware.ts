export { auth as middleware } from "@/auth";

export const config = {
  // Include bare paths as well as nested paths so /create itself is guarded,
  // not only /create/something.
  matcher: [
    "/dashboard",
    "/dashboard/:path*",
    "/create",
    "/create/:path*",
    "/admin",
    "/admin/:path*",
  ],
};
