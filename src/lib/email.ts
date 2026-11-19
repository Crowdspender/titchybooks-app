import { Resend } from "resend";

import { contactTopicLabel, SUPPORT_EMAIL, type ContactTopic } from "./contact";

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
    
    const { error } = await resend.emails.send({
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
            <a href="${escapeHtml(resetUrl)}"
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
            <a href="${escapeHtml(resetUrl)}" style="color: #4F46E5; word-break: break-all;">${escapeHtml(resetUrl)}</a>
          </p>
        </div>
      `,
    });

    if (error) return false;
    console.info("password-reset-email-sent");
    return true;
  } catch {
    console.warn("password-reset-email-unavailable");
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
    
    const { error } = await resend.emails.send({
      from: `Titchybooks <${EMAIL_FROM}>`,
      to,
      subject: "Welcome to Titchybooks!",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Welcome to Titchybooks, ${escapeHtml(name)}! 🎉</h2>
          <p style="color: #666; font-size: 16px;">
            Your account has been successfully created. You're now ready to start creating beautiful booklets!
          </p>
          <div style="margin: 30px 0;">
            <a href="${escapeHtml(process.env.NEXTAUTH_URL || "http://localhost:3000")}/login"
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
            Need help? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color: #4F46E5;">${SUPPORT_EMAIL}</a>
          </p>
        </div>
      `,
    });

    if (error) return false;
    console.info("welcome-email-sent");
    return true;
  } catch {
    console.warn("welcome-email-unavailable");
    return false;
  }
}

interface SendContactEmailParams {
  name: string;
  email: string;
  topic: ContactTopic | string;
  message: string;
  reference?: string;
  zone?: string;
  quantity?: number;
  weightGrams?: number;
}

/** Escapes interpolated values before they reach the HTML body. */
function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (char) => entities[char] ?? char);
}

/**
 * Sends a quote/contact request to the support inbox. The customer's address
 * goes into `replyTo` so support can answer straight from the mail client.
 * Returns false when email is not configured or the provider rejects it — the
 * caller then points the customer at SUPPORT_EMAIL directly.
 */
export async function sendContactEmail({
  name,
  email,
  topic,
  message,
  reference,
  zone,
  quantity,
  weightGrams,
}: SendContactEmailParams): Promise<boolean> {
  if (!resend) {
    console.warn(
      "⚠️ RESEND_API_KEY not configured. Contact request not emailed."
    );
    return false;
  }

  const inbox = process.env.CONTACT_INBOX_EMAIL || SUPPORT_EMAIL;
  const topicLabel = contactTopicLabel(topic as ContactTopic);
  const facts = [
    zone ? `Destination: ${zone}` : null,
    quantity ? `Copies: ${quantity}` : null,
    weightGrams ? `Weight: ${weightGrams} g` : null,
    reference ? `Reference: ${reference}` : null,
  ].filter((line): line is string => Boolean(line));

  const text = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Topic: ${topicLabel}`,
    ...facts,
    "",
    message,
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Contact request: ${escapeHtml(topicLabel)}</h2>
      <p style="color: #666; font-size: 14px; margin: 4px 0;">
        <strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(email)}&gt;
      </p>
      ${
        facts.length
          ? `<ul style="color: #666; font-size: 14px;">${facts
              .map((line) => `<li>${escapeHtml(line)}</li>`)
              .join("")}</ul>`
          : ""
      }
      <div style="white-space: pre-wrap; color: #333; font-size: 15px; border-left: 3px solid #4F46E5; padding-left: 12px;">
${escapeHtml(message)}
      </div>
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
      <p style="color: #999; font-size: 12px;">
        Reply to this email to answer the customer directly.
      </p>
    </div>
  `;

  try {
    const { error } = await resend.emails.send({
      from: `Titchybooks <${EMAIL_FROM}>`,
      to: inbox,
      replyTo: email,
      subject: `[Contact] ${topicLabel} — ${name}`,
      text,
      html,
    });

    if (error) {
      console.warn("contact-email-rejected");
      return false;
    }
    console.info("contact-email-sent");
    return true;
  } catch {
    console.warn("contact-email-unavailable");
    return false;
  }
}
