import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomBytes, createHash } from "crypto";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email } = body;

    if (!email) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
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

    // In production, you would send an email here with the reset link
    // For now, we'll log it (you should integrate with a service like Resend, SendGrid, etc.)
    const resetUrl = `${process.env.NEXTAUTH_URL || "http://localhost:3000"}/reset-password?token=${resetToken}`;
    
    // Only log reset URL in development environment - never in production
    if (process.env.NODE_ENV === "development") {
      console.log("Password reset URL (for development):", resetUrl);
    }
    
    // TODO: Send email with resetUrl
    // Example with Resend:
    // await resend.emails.send({
    //   from: 'noreply@titchybook.com',
    //   to: email,
    //   subject: 'Reset your password',
    //   html: `<p>Click <a href="${resetUrl}">here</a> to reset your password. This link expires in 1 hour.</p>`
    // });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
