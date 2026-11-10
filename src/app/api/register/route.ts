import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hash } from "bcryptjs";
import { z } from "zod";
import { consumeRateLimit, clientIp, tooManyRequests } from "@/lib/rate-limit";
import { sendWelcomeEmail } from "@/lib/email";

const registerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function POST(request: Request) {
  try {
    console.log('\n🔵 [REGISTER] Registration request received');
    const body = await request.json();
    console.log('🔵 [REGISTER] Request body:', { ...body, password: '***' });
    
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      console.error('❌ [REGISTER] Validation failed:', parsed.error.issues);
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { name, email, password } = parsed.data;

    // Durable per-IP signup cap (bcrypt hashing + welcome email make
    // unbounded registration both a CPU and a sending-quota risk).
    const rl = await consumeRateLimit(`register:ip:${clientIp(request)}`, {
      limit: 5,
      windowMs: 10 * 60_000,
    });
    if (!rl.allowed) {
      return tooManyRequests(rl, "Too many sign-up attempts - please try again later.");
    }
    console.log('🔵 [REGISTER] Creating user:', { name, email });

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log('⚠️ [REGISTER] Email already registered:', email);
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 400 }
      );
    }

    const passwordHash = await hash(password, 12);
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
      },
    });
    console.log('✅ [REGISTER] User created successfully:', user.id);

    // Send welcome email (non-blocking, don't fail registration if email fails)
    console.log('🔵 [REGISTER] Attempting to send welcome email...');
    try {
      await sendWelcomeEmail({
        to: email,
        name: name || "User",
      });
      console.log('✅ [REGISTER] Welcome email sent successfully');
    } catch (error) {
      console.error("❌ [REGISTER] Failed to send welcome email:", error);
      // Don't fail registration if email sending fails
    }

    console.log('✅ [REGISTER] Registration completed successfully\n');
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error('❌ [REGISTER] Unexpected error:', error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
