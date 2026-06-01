import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  env: {
    // Ensure NEXTAUTH_URL is available at build time
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  },
};

export default nextConfig;
