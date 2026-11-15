/**
 * Shared definitions for the "talk to a human" path.
 *
 * Checkout can only price what the pricing config covers: a fixed list of
 * destination zones and, per zone, one carrier ceiling. Anything outside that
 * (heavier shipments, unlisted countries, freight-sized runs) has to be quoted
 * by hand, so the order panel, the /contact page and the API route all share
 * the topics and URL shapes defined here.
 *
 * Kept free of Prisma so client components can import it.
 */

import { z } from "zod";

import { formatKilograms } from "./pricing/engine";
import { type Zone, ZONE_LABELS } from "./pricing/constants";

/**
 * Fallback inbox for contact requests. CONTACT_INBOX_EMAIL overrides it; the
 * brand domain is titchybooks.com (EMAIL_FROM / the printed back cover).
 */
export const SUPPORT_EMAIL = "support@titchybooks.com";

export const CONTACT_TOPIC_VALUES = [
  "oversize_order",
  "unlisted_region",
  "freight_quote",
  "order_issue",
  "other",
] as const;

export type ContactTopic = (typeof CONTACT_TOPIC_VALUES)[number];

interface ContactTopicDefinition {
  value: ContactTopic;
  label: string;
  /** Short explanation shown under the select. */
  hint: string;
}

export const CONTACT_TOPICS: readonly ContactTopicDefinition[] = [
  {
    value: "oversize_order",
    label: "More copies than checkout allows",
    hint: "An order that is heavier than the carrier limit for the destination.",
  },
  {
    value: "unlisted_region",
    label: "Country or region not listed",
    hint: "We quote these individually because carrier service and limits vary by country.",
  },
  {
    value: "freight_quote",
    label: "Freight quote (40 kg and above)",
    hint: "Bulk runs are shipped by commercial courier rather than by post.",
  },
  {
    value: "order_issue",
    label: "Payment or an existing order",
    hint: "Questions about an order you already placed.",
  },
  {
    value: "other",
    label: "Something else",
    hint: "Anything that does not fit the options above.",
  },
];

export function isContactTopic(value: unknown): value is ContactTopic {
  return (
    typeof value === "string" &&
    (CONTACT_TOPIC_VALUES as readonly string[]).includes(value)
  );
}

export function contactTopicLabel(topic: ContactTopic): string {
  return (
    CONTACT_TOPICS.find((entry) => entry.value === topic)?.label ??
    "Something else"
  );
}

/** Everything the checkout can hand over to pre-fill a quote request. */
export interface ContactContext {
  topic?: ContactTopic;
  zone?: Zone;
  quantity?: number;
  weightGrams?: number;
  /** Submission or order id, so support can look the book up. */
  reference?: string;
}

/** Builds a /contact URL with only the context that is actually known. */
export function contactHref(context: ContactContext = {}): string {
  const params = new URLSearchParams();
  if (context.topic) params.set("topic", context.topic);
  if (context.zone) params.set("zone", context.zone);
  if (context.quantity && context.quantity > 0) {
    params.set("quantity", String(Math.round(context.quantity)));
  }
  if (context.weightGrams && context.weightGrams > 0) {
    params.set("weight", String(Math.round(context.weightGrams)));
  }
  if (context.reference) params.set("reference", context.reference);
  const query = params.toString();
  return query ? `/contact?${query}` : "/contact";
}

export interface ContactDetails extends ContactContext {
  zoneLabel?: string;
}

/**
 * First-draft body for the message box. Customers almost always restate the
 * same three facts, so we pre-fill them and let them edit.
 */
export function prefillContactMessage(details: ContactDetails = {}): string {
  const lines: string[] = [];

  switch (details.topic) {
    case "oversize_order":
      lines.push("I would like to order more copies than the checkout allows.");
      break;
    case "unlisted_region":
      lines.push(
        "My delivery address is in a country that is not offered at checkout.",
      );
      break;
    case "freight_quote":
      lines.push("I would like a freight quote for a larger shipment.");
      break;
    case "order_issue":
      lines.push("I have a question about an order I already placed.");
      break;
    default:
      break;
  }

  const facts: string[] = [];
  if (details.zoneLabel || details.zone) {
    facts.push(`Destination: ${details.zoneLabel ?? details.zone}`);
  }
  if (details.quantity && details.quantity > 0) {
    facts.push(`Copies: ${Math.round(details.quantity)}`);
  }
  if (details.weightGrams && details.weightGrams > 0) {
    facts.push(`Total weight: about ${formatKilograms(details.weightGrams)}`);
  }
  if (details.reference) facts.push(`Reference: ${details.reference}`);

  if (facts.length) {
    lines.push("", ...facts);
  }

  lines.push(
    "",
    "Here is what I need:",
    "",
  );

  return lines.join("\n");
}

/** Human label for a zone query param (falls back to the raw value). */
export function zoneLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return ZONE_LABELS[value as Zone] ?? value;
}

export const contactRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Please tell us your name")
    .max(120, "Name is too long"),
  email: z.string().trim().email("Enter a valid email address"),
  topic: z.enum(CONTACT_TOPIC_VALUES),
  message: z
    .string()
    .trim()
    .min(10, "Please add a little more detail (at least 10 characters)")
    .max(5000, "Message is too long (5,000 characters max)"),
  reference: z.string().trim().max(120).optional(),
  zone: z.string().trim().max(40).optional(),
  quantity: z.number().int().positive().max(1_000_000).optional(),
  weightGrams: z.number().int().nonnegative().max(1_000_000).optional(),
});

export type ContactRequestInput = z.infer<typeof contactRequestSchema>;

/**
 * mailto fallback for when the API cannot reach the inbox (no Resend key,
 * provider outage). Keeps the customer moving without a second channel.
 */
export function contactMailtoHref(input: {
  topic: ContactTopic;
  message: string;
  reference?: string;
}): string {
  const subject = `[Titchybooks] ${contactTopicLabel(input.topic)}${
    input.reference ? ` — ${input.reference}` : ""
  }`;
  const body = input.message;
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}
