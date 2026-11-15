import { describe, expect, it } from "vitest";

import {
  CONTACT_TOPICS,
  CONTACT_TOPIC_VALUES,
  contactHref,
  contactMailtoHref,
  contactRequestSchema,
  contactTopicLabel,
  isContactTopic,
  prefillContactMessage,
  SUPPORT_EMAIL,
  zoneLabel,
} from "@/lib/contact";

describe("contact topics", () => {
  it("exposes a label and hint for every topic value", () => {
    expect(CONTACT_TOPICS.map((entry) => entry.value)).toEqual([
      ...CONTACT_TOPIC_VALUES,
    ]);
    for (const entry of CONTACT_TOPICS) {
      expect(contactTopicLabel(entry.value)).toBe(entry.label);
      expect(entry.hint.length).toBeGreaterThan(10);
    }
  });

  it("guards unknown topic values from the query string", () => {
    for (const value of CONTACT_TOPIC_VALUES) {
      expect(isContactTopic(value)).toBe(true);
    }
    expect(isContactTopic("resend")).toBe(false);
    expect(isContactTopic("")).toBe(false);
    expect(isContactTopic(undefined)).toBe(false);
  });
});

describe("contactHref", () => {
  it("returns the bare page when nothing is known", () => {
    expect(contactHref()).toBe("/contact");
    expect(contactHref({ quantity: 0, weightGrams: 0 })).toBe("/contact");
  });

  it("carries the checkout context through the query string", () => {
    const href = contactHref({
      topic: "oversize_order",
      zone: "usa",
      quantity: 1666.6,
      weightGrams: 10000,
      reference: "sub_123",
    });
    expect(href.startsWith("/contact?")).toBe(true);
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("topic")).toBe("oversize_order");
    expect(params.get("zone")).toBe("usa");
    expect(params.get("quantity")).toBe("1667");
    expect(params.get("weight")).toBe("10000");
    expect(params.get("reference")).toBe("sub_123");
  });

  it("encodes references that contain reserved characters", () => {
    const href = contactHref({ reference: "a&b=c d" });
    expect(href).not.toContain("a&b=c d");
    expect(new URLSearchParams(href.split("?")[1]).get("reference")).toBe(
      "a&b=c d",
    );
  });
});

describe("prefillContactMessage", () => {
  it("opens with a topic-specific line", () => {
    expect(
      prefillContactMessage({ topic: "oversize_order" }),
    ).toContain("more copies than the checkout allows");
    expect(prefillContactMessage({ topic: "unlisted_region" })).toContain(
      "not offered at checkout",
    );
    expect(prefillContactMessage({ topic: "freight_quote" })).toContain(
      "freight quote",
    );
    expect(prefillContactMessage({ topic: "order_issue" })).toContain(
      "order I already placed",
    );
    expect(prefillContactMessage({ topic: "other" })).not.toContain(
      "more copies",
    );
  });

  it("attaches the facts the customer already told checkout", () => {
    const message = prefillContactMessage({
      topic: "oversize_order",
      zone: "usa",
      zoneLabel: "United States",
      quantity: 1667,
      weightGrams: 10002,
      reference: "sub_123",
    });
    expect(message).toContain("Destination: United States");
    expect(message).toContain("Copies: 1667");
    expect(message).toContain("Total weight: about 10 kg");
    expect(message).toContain("Reference: sub_123");
    expect(zoneLabel("usa")).toBe("United States");
  });
});

describe("contactRequestSchema", () => {
  const valid = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    topic: "oversize_order",
    message: "I need 5,000 copies shipped to New York in March.",
  };

  it("accepts a complete request and trims whitespace", () => {
    const parsed = contactRequestSchema.parse({
      ...valid,
      name: "  Ada Lovelace  ",
      reference: " sub_123 ",
      zone: "usa",
      quantity: 5000,
      weightGrams: 30000,
    });
    expect(parsed.name).toBe("Ada Lovelace");
    expect(parsed.reference).toBe("sub_123");
    expect(parsed.quantity).toBe(5000);
  });

  it("rejects unknown topics, short messages and bad emails", () => {
    expect(
      contactRequestSchema.safeParse({ ...valid, topic: "freight" }).success,
    ).toBe(false);
    expect(
      contactRequestSchema.safeParse({ ...valid, message: "too short" })
        .success,
    ).toBe(false);
    expect(
      contactRequestSchema.safeParse({ ...valid, email: "not-an-email" })
        .success,
    ).toBe(false);
    expect(
      contactRequestSchema.safeParse({ ...valid, name: "A" }).success,
    ).toBe(false);
  });

  it("rejects non-positive or absurd quantities", () => {
    expect(
      contactRequestSchema.safeParse({ ...valid, quantity: 0 }).success,
    ).toBe(false);
    expect(
      contactRequestSchema.safeParse({ ...valid, quantity: 1_000_001 })
        .success,
    ).toBe(false);
  });
});

describe("contactMailtoHref", () => {
  it("builds an encoded fallback addressed to support", () => {
    const href = contactMailtoHref({
      topic: "unlisted_region",
      message: "Do you ship to Japan?",
      reference: "sub_123",
    });
    expect(href.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("subject")).toContain("Country or region not listed");
    expect(params.get("subject")).toContain("sub_123");
    expect(params.get("body")).toBe("Do you ship to Japan?");
  });
});
