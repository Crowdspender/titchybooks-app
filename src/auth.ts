import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit } from "@/lib/rate-limit";
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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email as string;
        const password = credentials.password as string;

        // Durable brute-force guard: cap verification attempts per email per
        // window. This also bounds the bcrypt CPU cost an attacker can force.
        // Exceeding the limit looks exactly like a wrong password to the
        // caller (no account-enumeration signal).
        const rl = await consumeRateLimit(`login:${email.toLowerCase()}`, {
          limit: 15,
          windowMs: 15 * 60_000,
        });
        if (!rl.allowed) return null;

        const user = await prisma.user.findUnique({
          where: { email },
        });

        if (!user) return null;

        const isValid = await compare(password, user.passwordHash);
        if (!isValid) return null;

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
