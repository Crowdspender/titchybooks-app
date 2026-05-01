# Titchybook Print + Ship Ordering System

Currency: HUF. No payment gateway this iteration (orders created in `PENDING_PAYMENT`). Orders are allowed only for `Submission.status = APPROVED` with a `pdfS3Key`.

## Task 1: Data model (Prisma)

Edit [schema.prisma](file:///c:/Users/Dell/titchybook-app/prisma/schema.prisma) and add new migration `prisma/migrations/20260430000000_orders/`.

New models:

- `Order`
  - `id` (cuid), `userId` (FK User), `submissionId` (FK Submission)
  - `quantity` Int, `zone` String, `weightGrams` Int, `shippingBand` Int
  - `unitPriceHuf` Int, `printCostHuf` Int, `handlingCostHuf` Int, `shippingCostHuf` Int, `totalHuf` Int
  - `currency` String default `"HUF"`
  - `status` String default `"PENDING_PAYMENT"` (allowed: `PENDING_PAYMENT` | `PAID` | `IN_PRODUCTION` | `SHIPPED` | `DELIVERED` | `CANCELLED`)
  - Shipping address fields: `recipientName`, `line1`, `line2?`, `city`, `postalCode`, `countryCode`, `phone?`
  - `pricingConfigVersion` Int (snapshot of config version used)
  - `notes` String? (admin)
  - `createdAt`, `updatedAt`
  - Indexes on `userId`, `submissionId`, `status`

- `PricingConfig` (singleton, `id = "default"`)
  - `version` Int (auto-increment on edit)
  - `weightPerBookGrams` Int default `6`
  - `handlingFixedHuf` Int default `0`
  - `handlingPercent` Float default `0`
  - `enabledZones` String (JSON string: `["hungary","eu","uk","usa","rest_of_world"]`)
  - `weightBands` String (JSON string of `[50,100,250,500,1000,2000]`)
  - `shippingTable` String (JSON string: `{ zone: number[6] }`)
  - `priceTiers` String (JSON string: `[{min,max,pricePerCopy}]`)
  - `updatedAt`, `updatedByUserId?`

Add relation `User.orders Order[]` and `Submission.orders Order[]`.

## Task 2: Seed defaults

Extend [seed.ts](file:///c:/Users/Dell/titchybook-app/prisma/seed.ts) to upsert the `default` `PricingConfig` with the exact values from the spec (weight bands, per-zone price arrays, tier ladder).

## Task 3: Server pricing engine

New folder `src/lib/pricing/`:

- `constants.ts` — default configs, `ZONES`, `WEIGHT_BANDS`, status enums.
- `schema.ts` — zod schemas: `PricingConfigShape`, `CalculateOrderInput`, `CreateOrderInput` (incl. `shippingAddress`).
- `config.ts`:
  - `loadPricingConfig()` reads the `default` row, parses JSON, falls back to constants. In-memory cache invalidated on admin update.
  - `savePricingConfig(patch, adminId)` validates + bumps `version`.
- `engine.ts` — pure functions parameterised by the loaded config:
  - `calculateWeight(quantity, cfg)`
  - `getWeightBand(weight, cfg)` → index, or `-1` if over 2000g
  - `getShippingCost(zone, quantity, cfg)`
  - `getUnitPrice(quantity, cfg)`
  - `getHandlingCost(printCost, cfg)` (fixed + `ceil(printCost * percent / 100)`)
  - `calculateOrder(zone, quantity, cfg)` → returns `{ quantity, zone, weightGrams, shippingBand, unitPriceHuf, printCostHuf, handlingCostHuf, shippingCostHuf, totalHuf, costPerBookHuf, currency: "HUF" }`
  - `suggestOptimalQuantity(quantity, zone, cfg)` → nearest upward price-break that yields lower `costPerBook`, capped at band max; returns `{ suggestedQuantity, savingsPct } | null`
  - `buildUxMessages(quantity, zone, cfg)` → array of `{ level: "info"|"tip", text }` (near-break hints, best-value hint).
- `index.ts` — barrel.

All amounts are integer HUF (round with `Math.round`).

## Task 4: Public API endpoints

Protected by `auth()` in route handlers.

- `POST /api/orders/calculate` → `src/app/api/orders/calculate/route.ts`
  - body: `{ submissionId, zone, quantity }` (submissionId optional for editor preview)
  - If `submissionId` provided, verify ownership and that zone is enabled.
  - Returns `calculateOrder(...)` + `suggestOptimalQuantity` + `buildUxMessages`. Never trusts client pricing.

- `POST /api/orders` → `src/app/api/orders/route.ts`
  - body: `{ submissionId, zone, quantity, shippingAddress }`
  - Enforce: session user owns submission, submission.status === `APPROVED`, `pdfS3Key` present, quantity 1–333, zone enabled, weight ≤ 2000g.
  - Recompute pricing server-side, persist `Order` with snapshot fields + `pricingConfigVersion`, status `PENDING_PAYMENT`.
  - Returns the created order.

- `GET /api/orders` → list current user's orders (joined submission title).
- `GET /api/orders/[id]` → detail (ownership check, admin bypass).

## Task 5: Admin API endpoints

- `GET /api/admin/orders` (filter by `status`, paginated) → `src/app/api/admin/orders/route.ts`
- `PATCH /api/admin/orders/[id]` → update `status` (state machine validated) + optional `notes`.
- `GET /api/admin/pricing-config` → current config.
- `PUT /api/admin/pricing-config` → validates zod shape, writes, bumps version, invalidates cache.

All admin routes gate on `session.user.role === "ADMIN"` following the existing pattern in [admin/submissions/route.ts](file:///c:/Users/Dell/titchybook-app/src/app/api/admin/submissions/route.ts).

## Task 6: Editor Order Panel

New `src/components/orders/OrderPanel.tsx`:

- Props: `submission: { id, status, pdfReady }`.
- Fetches the user's last-used zone from `localStorage` (`titchybook-last-zone`).
- Debounced (250ms) call to `POST /api/orders/calculate` on `quantity` or `zone` change; mirrors logic client-side via a shared TS module `src/lib/pricing/engine.client.ts` (same pure functions, no DB) for instant UI, then reconciles with server response.
- UI blocks:
  - Quantity slider (1–333) + number input, synced.
  - Destination `<select>` filtered by `enabledZones` (fetched once from `/api/orders/calculate` response meta or a small `/api/pricing/public` endpoint returning zones + tiers for display).
  - Real-time breakdown: price/copy, print cost, handling, shipping, total, effective cost/book.
  - Tip strip rendering `buildUxMessages` entries; sweet-spot badges at 8/40/80.
- Shipping address form (collapsed until user opens).
- `Place order` button: disabled unless `submission.status === "APPROVED" && pdfReady` (tooltip explains why). On click → `POST /api/orders` → redirect to `/dashboard/orders/[id]`.

Mount it in [EditorWorkspace.tsx](file:///c:/Users/Dell/titchybook-app/src/components/editor/EditorWorkspace.tsx) as a new full-width section below the three-column grid (section header "Print & Ship"). Also mountable on the dashboard via a new page (Task 7).

## Task 7: Dashboard order pages

- `src/app/(protected)/dashboard/orders/page.tsx` — user order history list (status badge, total, ship-to, submission link).
- `src/app/(protected)/dashboard/orders/[id]/page.tsx` — order detail view.
- Add a "Order prints" link on each approved row in [SubmissionList.tsx](file:///c:/Users/Dell/titchybook-app/src/components/submissions/SubmissionList.tsx) pointing to `/dashboard/orders/new?submissionId=...` which renders the OrderPanel standalone.

## Task 8: Admin screens

- `src/app/(admin)/admin/orders/page.tsx` + `src/components/admin/OrderModeration.tsx`
  - Table: user, submission title, qty, zone, total, status, date; status transition dropdown; filter by status.
- `src/app/(admin)/admin/pricing/page.tsx` + `src/components/admin/PricingConfigForm.tsx`
  - Editable grids: price tiers (add/remove rows), shipping table (5 × 6 inputs), enabled zones checkboxes, `weightPerBookGrams`, `handlingFixedHuf`, `handlingPercent`.
  - Client-side zod validation mirrors server; save → `PUT /api/admin/pricing-config`.
- Add top-nav links inside existing admin header so admins can reach both screens.

## Task 9: Validation, errors, tests

- All API bodies validated with zod; on failure return `400` with field errors.
- Unit tests for `engine.ts` covering:
  - Band boundaries (50g, 51g, 2000g, 2001g → `-1`).
  - Tier boundaries (8/9, 40/41, 80/81, 160/161, 333 cap).
  - `calculateOrder` totals with + without handling.
  - `suggestOptimalQuantity` returning a better option only when true savings exist.
- Place tests in `src/lib/pricing/__tests__/engine.test.ts` (use existing test runner if configured; otherwise plain `tsx` script — confirm runner during implementation).

## Task 10: Future-proofing hooks (lightweight, no feature work)

Design only (leave TODO comments + schema headroom):

- `Order.fulfilmentHub` optional column (default null) for EU/US hubs.
- `Order.couponCode` optional; pricing engine accepts an optional `discount` input and returns `discountHuf`.
- `Order.parentBatchId` nullable FK to a future `OrderBatch` (not created now) for multi-shipment / crowd-funded batches.
- Pricing engine splits computation via an `OrderLine` internal shape so multi-shipment can be added without API changes.

## Out of scope

- Stripe/payment integration, webhook, refund flow.
- Multi-currency conversion (currency column only).
- Bulk/coupon UI (schema-ready, no UI).
- Actual shipment label generation / Magyar Posta API.

## Acceptance checklist

- [ ] Migration applies, seed populates default `PricingConfig`.
- [ ] `POST /api/orders/calculate` returns correct totals for sample `(eu, 40)` → `printCost 7200, shipping 2200, total 9400`.
- [ ] `POST /api/orders` rejects non-approved submissions and over-2kg weights.
- [ ] Editor panel updates totals within 100ms of quantity change (client mirror) and reconciles with server ≤ 300ms.
- [ ] Admin can edit pricing config; new orders reflect updated values and snapshot `pricingConfigVersion`.
- [ ] Admin can transition order status through the lifecycle.
