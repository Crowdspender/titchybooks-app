/**
 * Contact / manual-quote requests.
 *
 * Not everything is priceable at checkout: heavier shipments, unlisted
 * countries and freight-sized runs are quoted by hand. This endpoint forwards
 * those requests to the support inbox; it deliberately stores nothing, so
 * there is no customer data to retain or clean up.
 */

import { NextResponse } from "next/server";

import {
  contactRequestSchema,
  SUPPORT_EMAIL,
} from "@/lib/contact";
import { sendContactEmail } from "@/lib/email";
import { clientIp, consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = contactRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  // Each accepted message triggers a provider send, so cap per IP.
  const rl = await consumeRateLimit(`contact:ip:${clientIp(request)}`, {
    limit: 5,
    windowMs: 15 * 60_000,
  });
  if (!rl.allowed) {
    return tooManyRequests(
      rl,
      "Too many messages - please try again in a few minutes.",
    );
  }

  const sent = await sendContactEmail(parsed.data);
  if (!sent) {
    return NextResponse.json(
      {
        error: `We could not deliver your message. Please email ${SUPPORT_EMAIL} directly.`,
        supportEmail: SUPPORT_EMAIL,
      },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true });
}
