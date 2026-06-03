import { Resend } from "resend";

// Initialize Resend with API key from environment
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || "onboarding@resend.dev";

// Log initialization status
if (resend) {
  console.log("✅ Resend client initialized successfully");
} else {
  console.warn("⚠️ Resend client NOT initialized - missing RESEND_API_KEY");
}

interface SendPasswordResetEmailParams {
  to: string;
  resetUrl: string;
}

interface SendWelcomeEmailParams {
  to: string;
  name: string;
}

/**
 * Send password reset email
 * Returns true if email was sent successfully, false otherwise
 */
export async function sendPasswordResetEmail({
  to,
  resetUrl,
}: SendPasswordResetEmailParams): Promise<boolean> {
  if (!resend) {
    console.warn(
      "⚠️ RESEND_API_KEY not configured. Password reset email not sent."
    );
    return false;
  }

  try {
    console.log(`📧 Attempting to send password reset email to ${to} from ${EMAIL_FROM}`);
    
    const { data, error } = await resend.emails.send({
      from: `Titchybooks <${EMAIL_FROM}>`,
      to,
      subject: "Reset your password",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Reset Your Password</h2>
          <p style="color: #666; font-size: 16px;">
            You requested a password reset for your Titchybooks account.
          </p>
          <p style="color: #666; font-size: 16px;">
            Click the button below to reset your password. This link will expire in 1 hour.
          </p>
          <div style="margin: 30px 0;">
            <a href="${resetUrl}" 
               style="background-color: #4F46E5; 
                      color: white; 
                      padding: 12px 24px; 
                      text-decoration: none; 
                      border-radius: 6px; 
                      display: inline-block;
                      font-size: 16px;">
              Reset Password
            </a>
          </div>
          <p style="color: #999; font-size: 14px;">
            If you didn't request this, you can safely ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
          <p style="color: #999; font-size: 12px;">
            If the button doesn't work, copy and paste this link into your browser:<br />
            <a href="${resetUrl}" style="color: #4F46E5; word-break: break-all;">${resetUrl}</a>
          </p>
        </div>
      `,
    });

    console.log(`✅ Password reset email sent to ${to}`, data?.id);
    return true;
  } catch (error) {
    console.error("❌ Failed to send password reset email:", error);
    if (error instanceof Error) {
      console.error("Error details:", error.message);
    }
    return false;
  }
}

/**
 * Send welcome/confirmation email after sign-up
 * Returns true if email was sent successfully, false otherwise
 */
export async function sendWelcomeEmail({
  to,
  name,
}: SendWelcomeEmailParams): Promise<boolean> {
  if (!resend) {
    console.warn(
      "⚠️ RESEND_API_KEY not configured. Welcome email not sent."
    );
    return false;
  }

  try {
    console.log(`📧 Attempting to send welcome email to ${to} from ${EMAIL_FROM}`);
    
    const { data, error } = await resend.emails.send({
      from: `Titchybooks <${EMAIL_FROM}>`,
      to,
      subject: "Welcome to Titchybooks!",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Welcome to Titchybooks, ${name}! 🎉</h2>
          <p style="color: #666; font-size: 16px;">
            Your account has been successfully created. You're now ready to start creating beautiful booklets!
          </p>
          <div style="margin: 30px 0;">
            <a href="${process.env.NEXTAUTH_URL || "http://localhost:3000"}/login" 
               style="background-color: #4F46E5; 
                      color: white; 
                      padding: 12px 24px; 
                      text-decoration: none; 
                      border-radius: 6px; 
                      display: inline-block;
                      font-size: 16px;">
              Get Started
            </a>
          </div>
          <p style="color: #666; font-size: 16px;">
            Here's what you can do:
          </p>
          <ul style="color: #666; font-size: 16px;">
            <li>Create stunning booklets from templates</li>
            <li>Upload and organize your images</li>
            <li>Customize layouts and designs</li>
            <li>Order professional prints</li>
          </ul>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
          <p style="color: #999; font-size: 12px;">
            Need help? Contact us at <a href="mailto:support@titchybook.com" style="color: #4F46E5;">support@titchybook.com</a>
          </p>
        </div>
      `,
    });

    console.log(`✅ Welcome email sent to ${to}`, data?.id);
    return true;
  } catch (error) {
    console.error("❌ Failed to send welcome email:", error);
    if (error instanceof Error) {
      console.error("Error details:", error.message);
    }
    return false;
  }
}
