import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hash } from "bcryptjs";
import { z } from "zod";
import { createHash } from "crypto";
import { consumeRateLimit, clientIp, tooManyRequests } from "@/lib/rate-limit";

const resetSchema = z.object({
  token: z.string().min(1, "Token is required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(request: Request) {
  try {
    // Durable per-IP cap: reset tokens are 32 random bytes, but throttle
    // guessing attempts and abuse of valid tokens alike.
    const rl = await consumeRateLimit(`reset:ip:${clientIp(request)}`, {
      limit: 10,
      windowMs: 15 * 60_000,
    });
    if (!rl.allowed) {
      return tooManyRequests(rl, "Too many reset attempts - please try again later.");
    }

    const body = await request.json();
    const parsed = resetSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { token, password } = parsed.data;

    // Hash the incoming token to compare with stored hashed token
    const hashedToken = createHash('sha256').update(token).digest('hex');

    // Locate the account only; redemption below rechecks token and expiry atomically.
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpires: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!user) {
      return NextResponse.json(
        { error: "Invalid or expired reset token" },
        { status: 400 }
      );
    }

    // Hash outside the database operation, then admit only one valid redemption.
    // Concurrent reuse, expiry during hashing, and a newly issued token all fail closed.
    const passwordHash = await hash(password, 12);
    const redeemed = await prisma.user.updateMany({
      where: { id: user.id, passwordResetToken: hashedToken, passwordResetExpires: { gt: new Date() } },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    if (redeemed.count !== 1) {
      return NextResponse.json({ error: "Invalid or expired reset token" }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
