import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { randomBytes, createHash } from "crypto";
import { sendPasswordResetEmail } from "@/lib/email";

export async function POST(request: Request) {
  try {
    console.log('\n🔵 [FORGOT-PASSWORD] Password reset request received');
    const body = await request.json();
    console.log('🔵 [FORGOT-PASSWORD] Request body:', body);
    const { email } = body;

    if (!email) {
      console.error('❌ [FORGOT-PASSWORD] Email is required');
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      );
    }

    // Find user by email
    const user = await prisma.user.findUnique({ where: { email } });

    // Always return success to prevent email enumeration
    if (!user) {
      console.log('⚠️ [FORGOT-PASSWORD] User not found (returning success to prevent enumeration):', email);
      return NextResponse.json({ success: true });
    }

    console.log('🔵 [FORGOT-PASSWORD] User found, generating reset token...');
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
    console.log('🔵 [FORGOT-PASSWORD] Attempting to send password reset email...');
    const emailSent = await sendPasswordResetEmail({
      to: email,
      resetUrl,
    });
    
    if (emailSent) {
      console.log('✅ [FORGOT-PASSWORD] Password reset email sent successfully');
    } else {
      console.error("❌ [FORGOT-PASSWORD] Failed to send password reset email to:", email);
    }

    console.log('✅ [FORGOT-PASSWORD] Password reset request completed\n');
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('❌ [FORGOT-PASSWORD] Unexpected error:', error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
