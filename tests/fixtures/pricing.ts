import type { ShippingPolicy } from "@/lib/pricing/destination";
import { calculateOrderInputSchema } from "@/lib/pricing/schema";

/** Synthetic only. Not carrier coverage, business approval, or production terms. */
export const SYNTHETIC_SHIPPING_POLICY: ShippingPolicy = {
  version: 1, enabled: true, approvalReference: "SYNTHETIC LOCAL TEST POLICY — NOT FOR PRODUCTION",
  approvedAt: "2020-01-01T00:00:00.000Z",
  weightRule: { packagingGrams: 20, vaultCopiesInCustomerParcel: 0 },
  terms: { version: "synthetic-test-v1", text: "Synthetic test terms only. The displayed charge is retained for payment retries." },
  services: [
    { countryCode: "HU", zone: "hungary", service: "Synthetic domestic service", maxWeightGrams: 40000, excludedPostcodePrefixes: ["999"] },
    { countryCode: "DE", zone: "eu", service: "Synthetic EU service", maxWeightGrams: 31500, excludedPostcodePrefixes: ["000"] },
    { countryCode: "GB", zone: "uk", service: "Synthetic UK service", maxWeightGrams: 30000, excludedPostcodePrefixes: ["BT", "GY", "JE", "IM"] },
    { countryCode: "US", zone: "usa", service: "Synthetic US service", maxWeightGrams: 10000, excludedPostcodePrefixes: ["967", "968", "995", "996", "997", "998", "999"] },
  ],
};
export function syntheticQuoteInputs(submissionId = "synthetic-approved-book") {
  return calculateOrderInputSchema.parse({
    submissionId, quantity: 40, currency: "EUR", vaultAddOn: false,
    shippingAddress: { recipientName: "Synthetic Recipient", line1: "Synthetic Street 1", city: "Budapest", postalCode: "1000", countryCode: "HU" },
  });
}
