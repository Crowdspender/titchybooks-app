import type { NextConfig } from "next";

// Exact S3 origin for browser-side uploads (presigned PUT) and asset reads
// (presigned GET). Both env vars exist at build time on Vercel and locally
// (.env). Without them we fall back to a wildcard that only matches the
// global endpoint, so regional deployments require the vars at build.
const s3Host =
  process.env.S3_BUCKET_NAME && process.env.AWS_REGION
    ? `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com`
    : "https://*.s3.amazonaws.com";

// Applied only in production: Next dev (HMR websockets, eval) and preview
// tooling would break under a strict policy. 'unsafe-inline' for scripts is
// required by Next's inline bootstrap; revisit with nonces if we tighten.
const productionCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // https: for presigned S3 GETs shown as images (renders, previews).
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${s3Host}`,
  `frame-ancestors 'none'`,
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  env: {
    // Ensure NEXTAUTH_URL is available at build time
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  },
  async headers() {
    const headers: { key: string; value: string }[] = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      },
    ];
    if (process.env.NODE_ENV === "production") {
      headers.push(
        { key: "Content-Security-Policy", value: productionCsp },
        {
          key: "Strict-Transport-Security",
          value: "max-age=15552000; includeSubDomains",
        },
      );
    }
    return [{ source: "/(.*)", headers }];
  },
};

export default nextConfig;
