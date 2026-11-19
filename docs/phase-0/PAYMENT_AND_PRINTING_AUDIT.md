# Payment and Printing Audit — Phase 0

Audit date: November 17, 2026. No payment, order, pricing, storage or print
operation was performed.

Post-audit revision (November 19, 2026): commit `718f1e9` landed immutable
accepted quotes, durable payment attempts/events, amount reconciliation and
atomic settlement after this inspection. Sections 4–6 mark the superseded
baseline observations and record the verified current behavior; pricing
values and live observations remain the November 17 baseline.

## 1. Reusable foundations

Keep `src/lib/pricing/{engine,shipping,currency,config,schema}.ts`, OrderPanel,
Order, Stripe Checkout/signature verification, payment alerts, render snapshots,
print/reading artifacts and S3 signing. They provide substantial existing
behavior. Extend their boundaries rather than create independent shop and
print-order calculators or a replacement payment stack.

Current commerce is authenticated, owner-only, one-book physical ordering. It is
not a general marketplace or digital-sales implementation. Order totals are
computed server-side and stored before Checkout; browser redirects do not settle
payment.

## 2. Authoritative current pricing calculations

Let `q` be requested copies and `c` the loaded pricing configuration:

```text
weightGrams = q * c.weightPerBookGrams
unitPriceHuf = inclusive quantity-tier price for q
printCostHuf = q * unitPriceHuf
handlingCostHuf = c.handlingFixedHuf + ceil(printCostHuf * c.handlingPercent / 100)
shippingCostHuf = first selected-zone band with weightGrams <= maxWeightGrams
optional discountHuf = max(0, fixed discount + floor(printCostHuf * discountPercent / 100))
vaultFeeHuf = selected ? c.vaultFeeHuf : 0
totalHuf = max(0, printCostHuf + handlingCostHuf + shippingCostHuf + vaultFeeHuf - discountHuf)
costPerBookHuf = round(totalHuf / q)
```

The engine returns integer HUF values. Quantity bounds are integers; unsupported
zones/bands or excessive shipment weights are rejected, not silently assigned
the last rate. Discounts have calculation foundations, but an implemented public
coupon/promotion lifecycle was not established. Current weight is copies × book
weight; there is no explicit packaging model or multi-parcel optimizer.

Client previews use shared primitives; a 250 ms debounced server calculation and
final server order creation establish authoritative totals. Server saves do not
trust the submitted display total. The server currently trusts the selected zone
independently of the entered delivery country: that is a material integrity gap,
not a reason to discard the engine.

## 3. Active database configuration versus source defaults

### Observed PricingConfig: the values actually stored

Version 1; last updated June 1, 2026. Weight 6 g/book; fixed/percentage handling
both zero; vault add-on 2,000 HUF. Enabled zones: Hungary, EU, UK, USA, rest of
world.

| Quantity | Active unit price HUF |
| -------- | --------------------: |
| 1–8      |                   300 |
| 9–40     |                   180 |
| 41–80    |                   120 |
| 81–160   |                    90 |
| 161–333  |                    70 |

Legacy shared shipping caps and stored HUF prices:

| Zone          | ≤50 g | ≤100 g | ≤250 g | ≤500 g | ≤1,000 g | ≤2,000 g |
| ------------- | ----: | -----: | -----: | -----: | -------: | -------: |
| Hungary       |   270 |    305 |    365 |    540 |      845 |    1,630 |
| EU            | 1,250 |  1,600 |  2,200 |  3,600 |    6,000 |   10,000 |
| UK            | 1,300 |  1,650 |  2,300 |  3,700 |    6,200 |   10,200 |
| USA           | 1,550 |  2,000 |  3,000 |  5,000 |    8,500 |   14,000 |
| Rest of world | 1,550 |  2,000 |  3,000 |  5,000 |    8,500 |   14,000 |

Rates: HUF=1; EUR=0.0026; GBP=0.0022, interpreted as HUF-to-display-currency
factors. These are configured fixed rates, not a verified live FX feed.

At 6 g/book, the stored 2 kg ceiling permits 333 copies. Canada and
Australia/New Zealand are not separate enabled zones in this stored row. A
generic EU/rest-of-world label is not proof every destination/carrier
combination is supported.

Example using active stored values: 40 copies to Hungary weigh 240 g, cost
`40 × 180 = 7,200 HUF` plus 365 HUF shipping, total **7,565 HUF** without vault.
At the stored EUR rate that displays €19.67. The only database order has
matching quantity/HUF total and EUR currency, but remains PENDING_PAYMENT; it is
not evidence of a charge or collected revenue.

### Shipped defaults: not automatically active

`src/lib/pricing/constants.ts` declares seven zones and larger per-zone ladders:

| Zone                  | Source-default maximum | Important qualification                                 |
| --------------------- | ---------------------: | ------------------------------------------------------- |
| Hungary               |                  40 kg | Domestic parcel basis only                              |
| EU                    |                31.5 kg | MPL Europe Standard coverage is not all EU destinations |
| UK                    |                  30 kg | Separate zone; provisional Európa+ Zone 3 basis         |
| USA                   |                  10 kg | Separate international tariff basis                     |
| Canada                |                   2 kg | Larger country-specific parcel rates not established    |
| Australia/New Zealand |                   2 kg | Larger country-specific parcel rates not established    |
| Rest of world         |                   2 kg | Requires destination-specific qualification             |

Source default quantity tiers are 1–7: 300 HUF; 8–40: 250; 41–80: 220; 81–160:
190; 161–333: 170; 334+: 150. Global request cap is 6,666 copies, derived from
40 kg/6 g; selected-zone configuration can impose a much smaller limit. Shortcut
chips are 8, 40, 80, 160, 333, 833, 1,666, 3,333, 5,000 and 6,666,
filtered/constrained for the selected zone.

The configuration loader normalizes the legacy shared-band table at read time
and uses a 30-second process-local cache. Source defaults do not replace an
existing row automatically. Missing/malformed configuration can fall back to
defaults, which is availability-oriented but needs fail-closed commercial
handling before launch. Admin “reset defaults/save” would materially change
current prices and is **not** an audit step.

Required business approval: actual supported countries, contracted carrier
products/tariffs, packaging weight, taxes, handling policy and oversized-order
quotation rules. Never apply Hungarian domestic 40 kg tariffs to international
shipments.

## 4. Currency and Stripe amount handling

`src/lib/pricing/currency.ts` handles display conversion and `src/lib/stripe.ts`
converts to Stripe charge units. For supported HUF/EUR/GBP charges, the current
Stripe helper uses the converted value ×100, rounded. HUF whole-forint display
does not make Stripe charges zero-decimal. Preserve the corrected HUF scaling;
payout-specific precision rules are different.

Configured minimum charge amounts in Stripe units are HUF 17,500, EUR 50,
GBP 30. These are existing code values; launch should reconfirm provider rules
rather than generalize them to new currencies.

Financial reproducibility gaps (November 17 baseline; largely superseded by
`718f1e9` — see the post-audit status below):

- Order stores HUF components, currency and a configuration version, but not the
  actual FX factor or expected charge minor units.
- Retrying payment loads current currency rates, so a pending EUR/GBP order can
  be offered at a different foreign amount.
- PricingConfig is overwritten; a version integer alone cannot reconstruct
  historical prices/rates.
- Stripe completion does not reconcile collected `amount_total`/currency against
  an immutable expected charge.

Proposed correction after approval: immutable server quote/payment snapshots,
integer amounts, explicit rounding policy, decimal FX metadata, retained
configuration versions, and reconciliation of the provider charge. Existing
historical values must remain unchanged; unavailable FX must be labeled unknown,
not reconstructed with today's rate.

Post-audit status (`718f1e9`, verified against current source): orders now pin
the accepted quote (`quoteSnapshot`, `expectedMinorAmount`, `fxRate` as
numeric(24,18), `quoteAcceptedAt`), protected by a database immutability
trigger and completeness/range checks. Payment retry validates the pinned
snapshot and reuses the original frozen configuration — current FX is
irrelevant to a frozen offer; a weight increase requires a new manual quote.
Durable `PaymentAttempt` rows carry unique idempotency keys and
`(orderId,sequence)`; `PaymentEvent` rows store unique provider event IDs and
processing outcomes. Reconciliation compares the provider's collected
`amount_total`/currency against the pinned expectation under a `FOR UPDATE`
row lock and flags mismatches for review. PricingConfig version history and
per-item refund allocations remain open.

## 5. Current payment sequence and failure boundaries

The table below is the November 17 baseline; post-audit status follows it.

| Boundary               | Present behavior                                                                           | Expansion requirement                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Order creation         | Owner/status checks, server price calculation, persistent pending order before Stripe      | Request idempotency, version-pinned order items, verified customer and immutable quote                |
| Session creation       | One Checkout line item for entire print order; order reference in metadata; hosted payment | Durable attempt record, provider idempotency key, immutable amount/currency and active-session policy |
| Availability           | `isStripeConfigured()` checks secret key only                                              | Require complete Checkout/webhook configuration and readiness verification                            |
| Retry                  | Pending order can create another session, replacing one stored session ID                  | Keep attempts/history; no silent repricing; superseded-session reconciliation                         |
| Webhook authentication | Raw body and Stripe signature required                                                     | Preserve; store unique provider event IDs and durable processing outcomes                             |
| Paid completion        | Checks `payment_status=paid`; conditional PENDING_PAYMENT→PAID                             | Reconcile amount/currency/provider references and atomic side effects                                 |
| Superseded session     | Signed paid old session is accepted and alerts operator                                    | Account for every actual payment; detect overpayments and avoid duplicate goods/royalties             |
| Replay                 | Conditional transition plus sequential recovery logic                                      | DB uniqueness for all effects, concurrency tests across admin/webhook/replay                          |
| Expiry/failure         | Expiry logged; unpaid completion alerts; other event types acknowledged                    | Explicit abandoned/failed/async payment state and recoverable reconciliation                          |
| Refund/dispute         | No complete implemented financial/refund workflow                                          | Provider refund records, per-item allocation, entitlement policy and negative royalties               |
| Admin settlement       | Reads allowed prior status then updates by ID, vault creation afterward                    | Shared compare-and-set/transactional settlement boundary with evidence and actor audit                |
| Notifications          | Welcome/reset/contact email exists                                                         | Transactional order/delivery emails through an outbox; retries independent of settlement              |

Post-audit status (`718f1e9`): the Session creation, Retry, Webhook
authentication, Paid completion, Replay and Admin settlement rows above
describe the baseline. Retry now reuses the pinned quote and issues durable
idempotent attempts committed before the provider request; signed webhook
deliveries are recorded as unique `PaymentEvent` rows before provider lookups,
with durable outcomes; settlement (webhook and admin) runs through a shared
transactional boundary with `SELECT … FOR UPDATE` row locking and an
`expectedUpdatedAt` compare-and-set, and admin settlement records operator
evidence in `Order.manualSettlement`. `VaultEntry.orderId` is now unique.
Refund/dispute workflow and transactional notifications remain open.

At the audit baseline, the webhook's paid transition and vault creation ran
inside a transaction. That did not establish global exactly-once side effects:
VaultEntry had no unique order key and the admin path was separate. The helper
named “idempotent” performed `findFirst` then `create`; naming/comments are not
a concurrency guarantee. Its caller, not the helper itself, supplied
payment-state validation. Post-audit, `VaultEntry.orderId` is unique and both
settlement paths share the locked compare-and-set boundary described above.

An order's CANCELLED status does not refund Stripe. A signed unexpected payment
may be real money even when its order transition is refused; it needs financial
reconciliation, not silent loss. No production double charge or monetary loss
was demonstrated by this audit.

Local Stripe credentials were absent in presence-only inspection; production
credentials, webhook subscription types, test/live mode, refund configuration
and account reconciliation were not verified. No live payment was attempted.

## 6. Book/PDF ownership, generation and qualification

| Question from the brief   | Current answer                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Book record               | Submission, with SubmissionPage scenes or legacy SubmissionImage inputs                                                          |
| Ownership                 | Submission.userId plus owner/admin service checks                                                                                |
| Approval                  | Submission.status; manual rendered-PENDING moderation or AI QA auto-approval                                                     |
| Original inputs           | Editor scenes, template scenes and uploaded images; no general original-PDF ingestion workflow was found                         |
| Generated files           | Private S3 objects; keys on Submission and RenderJob; manifests for modern outputs                                               |
| Version retention         | Attempt-specific render keys/history and frozen inputs exist; no commercial version registry or guaranteed storage-level history |
| Regeneration              | Possible from retained snapshots/assets and compatible renderer/fonts/profile; not guaranteed if sources are deleted or changed  |
| Secure download           | Baseline: authorized API issued expiring signed GETs. Post-audit (`718f1e9`): `submissions/[id]/downloads` streams same-origin with fresh per-request authorization and `private, no-store` headers; still not a purchased entitlement |
| Print-ready determination | Technical rendering/manifest checks and approval; legacy ordering checks approved plus print key only                            |
| Future reuse              | Reuse the existing qualified master object by immutable reference; no automatic regeneration or copied book required             |

Modern artifacts include one imposed print-sheet PDF and an eight-page
reading-order PDF, with descriptor fields: S3 key, bytes, SHA-256, MIME type,
page count and page dimensions. Manifest records submission/revision, render
job, template/version, profile, title and creation time. The renderer publishes
references only after both artifacts exist.

The qualified raster profile is `titchybook-single-sheet-rgb-v2`, version 2: A4
landscape 297×210 mm print sheet, eight 74×105 mm reading pages, RGB, 300 DPI
raster, minimum body text 8 pt and effective image DPI 200. Manual/legacy vector
rendering has a separate path and should not be described as the qualified AI
raster output.

Reading order: FRONT_COVER, PAGE_2, PAGE_3, PAGE_4, PAGE_5, PAGE_6, PAGE_7,
BACK_COVER. Print imposition applies panel transforms and existing Titchybooks
branding. Current print artifact validation expects **one PDF page**; reading
validation expects **eight**.

The profile explicitly calls for a separately proofed commercial print profile.
No printer API, automated label procurement, PDF/X certification, CMYK
conversion/ICC proof, bleed/crop-mark agreement or external printer acceptance
was established. Current production is administrator-managed status progression.

## 7. Critical sponsorship print distinction

The brief's eight **additional back-page sections** are not the eight editorial
reading pages or just the BACK_COVER scene. The existing renderer cannot be
assumed to meet the sponsorship specification.

Before Stage 4 rendering is implemented, obtain a physical folding/imposition
proof specifying reverse-side geometry, duplex orientation, panel dimensions,
safe areas/bleed, color/profile, branding, QR minimum size/contrast and
blank-panel behavior. A two-sided A4 candidate is reasonable to prototype only
after approval; the precise production format remains an external specification
dependency.

Use a separately versioned sponsored print profile and edition target, leaving
the current one-page profile, editor PAGE_LABELS and original approved PDF
unchanged. Exactly eight available positions does not require eight occupied
placements. Once edition artwork is approved, panel/artifact revisions are
immutable; revisions generate a new edition revision/file set.

## 8. Storage integrity and download limitations

Current key families: `uploads/{userId}/...`, `assets/{userId}/...`,
`renders/{userId}/{submissionId}/{jobId}/{attempt}-{token}`, historical
`pdfs/...`, and `previews/...`. Default GET expiry is one hour; PUT expiry is
ten minutes. Downloads do not currently specify S3 VersionId.

Live bucket configuration has all public-access-block flags enabled and AES256
encryption. Versioning returned no enabled status; no lifecycle configuration or
bucket policy was returned. This contradicts intended runbook
version-retention/TLS-policy setup, but it does not show public readability.
CORS is not an authorization control.

Source deletion lacks complete reference tracking; snapshots retain keys but not
all source bytes/version IDs. Modern approved database records: 13 dual-artifact
sets plus one historical print-only book. No HEAD/checksum sweep was performed.
Paid product qualification must check actual object availability/integrity
before enabling a format, retain referenced bytes, and alert on loss. Historical
print-only records should keep owner access; do not invent missing reading files
or silently rerender an approved master.

For digital sales, authorize each signed URL against customer identity,
immutable sold version, active entitlement and accepted license. Deliver the
approved **print-ready master**; a reading PDF is optional supplementary
material, not a substitute. Shorter configured TTLs can reduce exposure, but
downloaded bytes cannot be technically recalled or made uncopyable.
Refund/license policy must acknowledge that limitation.

## 9. Financial model to approve before launch

Preserve HUF as the base price/cost convention. Use the existing
quantity/weight/currency primitives inside one server quotation service.
Separate sale revenue, print cost, shipping, handling, vault, tax, platform
margin and author liability; do not treat “printCostHuf” as a proven vendor cost
ledger.

Recommended initial rules, subject to business/legal approval:

- Marketplace print tiers apply per publication/version/format, not across
  unrelated authors; all physical lines contribute to one supported parcel
  quote, digital lines contribute zero weight.
- Digital licenses have quantity one per customer purchase; repeat download is
  the same entitlement, not another royalty.
- Author self-print remains available but does not earn marketplace commission.
- Fixed per-copy commission rates are configured and snapshotted; 50/150 HUF in
  the brief are examples, not defaults.
- Physical royalty becomes payable on documented delivered quantity; digital on
  settled payment plus entitlement grant; refunds append negative adjustments.
- Campaign royalty follows its signed immutable quote/agreement, separate from
  ordinary retail commission.
- No public paid marketplace launch before the royalty/refund backbone is
  complete, even if Stage 2 checkout screens are ready.

Business decisions remain: merchant-of-record/tax/VAT/invoicing, retail
floor/margins, supported destinations/currencies, FX update and quote validity,
delivery-based eligibility/refund window, related-party abuse, license terms and
payout thresholds. See
[risks and approval questions](RISKS_AND_DEPENDENCIES.md).

## 10. Verification required after approval

Preserve existing pricing, order retry and signed-webhook tests. Add exact
boundary arithmetic for every active tier/weight cap; country/zone rejection;
mixed/digital-only shipping; quote expiration/config changes; HUF minor units;
duplicate/out-of-order/late session completion; amount/currency mismatch;
concurrent admin/webhook settlement; partial fulfillment/refunds/disputes;
entitlement/file-version pinning; zero self-royalties; and campaign-specific
finances.

Test physical print/fold/QR output and historical artifact reuse separately from
PDF parsing. Run provider test-mode end-to-end reconciliation, isolated
migration/restore rehearsals and complete regression journeys before any
approved production rollout. None of these tests or changes was performed in
Phase 0.
