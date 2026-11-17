import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { clientIp, consumeRateLimit, releaseRateLimit } from "@/lib/rate-limit";
import { compare } from "bcryptjs";

declare module "next-auth" {
  interface User {
    role: string;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      role: string;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    role: string;
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;

        // Durable brute-force guard: cap failed verifications per email and
        // per client IP per window, so one client cannot exhaust the per-email
        // allowance across many accounts. This also bounds the bcrypt CPU cost
        // an attacker can force. Exceeding either limit looks exactly like a
        // wrong password to the caller (no account-enumeration signal).
        const emailWindow = { limit: 15, windowMs: 15 * 60_000 };
        const ipWindow = { limit: 30, windowMs: 15 * 60_000 };
        const emailKey = `login:${email.toLowerCase()}`;
        const ipKey = `login-ip:${clientIp(request)}`;
        // Atomically reserve a slot in BOTH buckets before the expensive
        // password comparison. A read-only peek would let concurrent requests
        // all pass the gate and run bcrypt before any of them counted, so the
        // admission itself must consume; denied admissions never reach bcrypt.
        const [emailRl, ipRl] = await Promise.all([
          consumeRateLimit(emailKey, emailWindow),
          consumeRateLimit(ipKey, ipWindow),
        ]);
        if (!emailRl.allowed || !ipRl.allowed) return null;

        const user = await prisma.user.findUnique({
          where: { email },
        });

        const isValid = user ? await compare(password, user.passwordHash) : false;
        if (!user || !isValid) {
          // The reservation already counted this failure against both the
          // account and the client; nothing more to consume.
          return null;
        }

        // Success refunds both reservations so legitimate sign-ins never spend
        // the brute-force budget, while every wrong guess stays counted.
        await Promise.all([
          releaseRateLimit(emailKey),
          releaseRateLimit(ipKey),
        ]);

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  // Trust the Host header only when explicitly configured (AUTH_TRUST_HOST=true
  // on Vercel, where the host varies per deployment). Blanket trust lets a
  // spoofed Host header influence callback URLs and redirects.
  trustHost: process.env.AUTH_TRUST_HOST === "true",
  callbacks: {
    // Page protection lives in src/proxy.ts: passing a custom handler to auth()
    // bypasses the `authorized` callback, so it must not be relied on here.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id!;
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      return session;
    },
  },
});
