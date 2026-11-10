import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomBytes, createHash } from "crypto";
import { sendPasswordResetEmail } from "@/lib/email";
import { consumeRateLimit, clientIp, tooManyRequests } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email } = body;

    if (!email) {
      console.error('❌ [FORGOT-PASSWORD] Email is required');
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    // Durable limits: per-IP flood cap and a per-account cap on reset emails
    // (both survive restarts and coordinate across serverless instances).
    const ipRl = await consumeRateLimit(`forgot:ip:${clientIp(request)}`, {
      limit: 8,
      windowMs: 15 * 60_000,
    });
    if (!ipRl.allowed) {
      return tooManyRequests(ipRl, "Too many reset requests - please try again later.");
    }
    const acctRl = await consumeRateLimit(`forgot:email:${String(email).toLowerCase()}`, {
      limit: 3,
      windowMs: 60 * 60_000,
    });
    if (!acctRl.allowed) {
      // Same generic success as a normal "unknown email" response to avoid
      // leaking that the account exists while still refusing to send.
      return NextResponse.json({ success: true });
    }

    // Find user by email
    const user = await prisma.user.findUnique({ where: { email } });

    // Always return success to prevent email enumeration
    if (!user) {
      return NextResponse.json({ success: true });
    }

    // Generate reset token
    const resetToken = randomBytes(32).toString("hex");
    const resetExpiry = new Date(Date.now() + 3600000); // 1 hour from now

    // Hash token before storing in database
    const hashedToken = createHash('sha256').update(resetToken).digest('hex');

    // Save hashed token to database
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: hashedToken,
        passwordResetExpires: resetExpiry,
      },
    });
    console.log('✅ [FORGOT-PASSWORD] Reset token saved to database');

    // Generate and send password reset email
    const resetUrl = `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/reset-password?token=${resetToken}`;
    
    // Only log reset URL in development environment
    if (process.env.NODE_ENV === "development") {
      console.log("🔵 [FORGOT-PASSWORD] Password reset URL (for development):", resetUrl);
    }
    
    // Send password reset email
    const emailSent = await sendPasswordResetEmail({
      to: email,
      resetUrl,
    });
    
    if (emailSent) {
      console.log('✅ [FORGOT-PASSWORD] Password reset email sent successfully');
    } else {
      console.error("❌ [FORGOT-PASSWORD] Failed to send password reset email");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('❌ [FORGOT-PASSWORD] Unexpected error:', error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
