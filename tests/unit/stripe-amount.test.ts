import { describe, expect, it } from 'vitest';
import { toStripeAmount } from '@/lib/stripe';

describe('toStripeAmount (HUF-authoritative totals -> Stripe unit_amount)', () => {
  it('converts HUF into hundredths (filler), like every supported currency', () => {
    expect(toStripeAmount(5990, 'HUF')).toBe(599000);
    // HUF display precision is whole forint, so fractional input rounds first.
    expect(toStripeAmount(5994.4, 'HUF')).toBe(599400);
    expect(toStripeAmount(1000, 'HUF')).toBe(100000);
  });

  it('converts EUR with the default rate into cents', () => {
    // 1 HUF ≈ 0.0026 EUR by default rates: 4000 HUF ≈ 10.40 EUR = 1040 cents.
    expect(toStripeAmount(4000, 'EUR')).toBe(1040);
  });

  it('honours explicit pricing-config rates', () => {
    expect(toStripeAmount(10_000, 'EUR', { HUF: 1, EUR: 0.0025, GBP: 0.002 })).toBe(2500);
  });

  it('converts GBP into pence', () => {
    expect(toStripeAmount(10_000, 'GBP', { HUF: 1, EUR: 0.0026, GBP: 0.0022 })).toBe(2200);
  });

  it('rejects amounts below the Stripe minimum for the currency', () => {
    expect(() => toStripeAmount(50, 'HUF')).toThrow(/minimum/i); // 5000 filler < 17500
    expect(() => toStripeAmount(1000, 'EUR', { HUF: 1, EUR: 0.0001, GBP: 1 })).toThrow(/minimum/i); // 10 cents < 50
  });

  it('accepts exactly the minimum', () => {
    expect(toStripeAmount(175, 'HUF')).toBe(17500);
  });
});
