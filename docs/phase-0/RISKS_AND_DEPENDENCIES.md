# Risks and Dependencies — Phase 0

Audit date: November 17, 2026. Findings and approval dependencies only. No
repairs or implementation were performed.

## 1. Overall recommendation

Approve a reuse-first modular extension, not a rewrite. The editor, AI/template
workflows, durable rendering, pricing functions, Stripe integration and
dashboards are valuable foundations. The principal risks are immutable content
retention, commercial consent, payment reconciliation, financial accounting,
production-format ambiguity and operational recovery.

The current source contains no full marketplace/royalty/sponsorship system.
These are new domain responsibilities, not features unlocked by exposing
existing owner endpoints. Existing low record counts do not eliminate
concurrency or financial correctness obligations.

Priority definitions:

- **P1 / blocker:** resolve before enabling the affected paid/public/production
  capability; not a claim of a demonstrated breach or financial loss.
- **P2 / important:** schedule in the relevant stage and verify before general
  launch.
- **P3 / maintainability:** planned cleanup/documentation or scale work; no
  reason for an unapproved rewrite.

Evidence: S=source inspection; D=read-only database observation; L=live
read-only observation; E=external GitHub status; G=requirement gap. Findings are
not penetration-test results. No exploit, paid transaction or destructive
reproduction was attempted.

## 2. Risk register

The register below is the November 17 baseline snapshot. Post-audit status
changes verified against current source are recorded in section 2a; entries
not listed there were not re-assessed in this revision.

| ID  | Priority / evidence | Finding and consequence                                                                                                                                                                      | Required response after approval / owner                                                                                                                                          |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | P1, S/D             | Shipping zone and address country are independent. Server recomputes a zone price without validating that it serves the country; unsupported/underpriced delivery can be sold                | Server country→carrier/zone mapping, approved destination matrix and boundary tests before expanded checkout; engineering + shipping owner                                        |
| R02 | P1, S/D             | Order stores HUF/currency but not FX or expected provider amount; payment retry uses current rates, and singleton config history is lost                                                     | Immutable quote/config/payment snapshots and explicit retry/expiry policy; finance + engineering                                                                                  |
| R03 | P1, S               | Webhook validates signature/payment status but not immutable amount/currency; only one session ID is retained; superseded paid sessions proceed with an alert                                | Durable attempts/events, actual-payment ledger, mismatch/overpayment reconciliation, provider idempotency and recovery; finance + engineering                                     |
| R04 | P1, S/G             | No full refunds/disputes/async payment outcome model. Cancellation is not a refund; late real payments can outlive order state                                                               | Refund allocations, negative adjustments, outbox/reconciliation and operational procedures before new sales; finance                                                              |
| R05 | P1, S/D             | Admin order update is read-then-update by ID with separate vault side effect; VaultEntry find-then-create lacks unique order constraint                                                      | Shared transactional settlement/state compare-and-set, uniqueness and concurrent all-path tests; engineering                                                                      |
| R06 | P1, S/D             | Assets can be deleted without checking frozen-scene/version/job references; snapshots preserve keys rather than guaranteed source bytes                                                      | Central retention/reference policy, immutable file identities, verified object retention and recovery before paid downloads/editions; engineering + operations                    |
| R07 | P1, S               | Generic owner DRAFT deletion lacks the dedicated template linked-instance guard; FK SET NULL and element cascade can detach template data                                                    | Centralize template/submission deletion protection and test pinned/live instances; engineering                                                                                    |
| R08 | P1, S               | Authorized private asset image responses declare public cacheability; shared intermediaries could cache private content                                                                      | Private/no-store or correctly scoped cache policy plus cross-user tests before broader asset exposure; engineering/security                                                       |
| R09 | P1, S/G             | AI technical QA can auto-approve a book; approval is not rights clearance or public consent                                                                                                  | Separate commercial review, versioned licenses and explicit owner listing opt-in; product/legal                                                                                   |
| R10 | P1, S/G             | Eight additional campaign panels are not the current eight editorial pages; current print master is one-sided A4/RGB with profile-specific assumptions                                       | Approved physical reverse-side/folding proof and separate edition/profile; do not mutate original editor labels/master; print owner                                               |
| R11 | P1, L/S             | S3 public-access blocks/encryption are enabled, but versioning has no enabled status and lifecycle/bucket policy were absent, unlike runbook intentions                                      | Approve retention/versioning/TLS/IAM settings, verify current objects and recovery; no silent policy changes; operations                                                          |
| R12 | P1 readiness, L/E   | Queue health returned 503 with both drains over 15 minutes old, despite empty queues; latest listed successful drain was a manual dispatch                                                   | Recheck scheduler cadence and target authorization/config; establish alert ownership. Do not infer cause or trigger repair during audit; operations                               |
| R13 | P1 launch, S/E      | Backup workflow/manual run succeeded, but full restore/PITR/object recovery and persistent isolated staging were not verified                                                                | Restore rehearsal, recovery objectives and production-like staging before approved migration/launch; operations                                                                   |
| R14 | P1 launch, G        | Merchant-of-record, VAT/tax/invoice, digital consumer rights and author payout obligations are unresolved                                                                                    | Legal/accounting sign-off and product rules; do not infer uniform author tax status or activate example royalty rates; business/legal                                             |
| R15 | P1 expansion, S/G   | No purchaser entitlement, immutable royalty or payout model; owner signed download is not a purchased license                                                                                | Version-pinned entitlements and append-only economic records before paid marketplace launch; engineering/finance                                                                  |
| R16 | P2, S               | JWT ID/role are captured at login; role/password changes do not establish immediate session invalidation in callbacks. Reset token is looked up then consumed by a separate update           | Session-version/revalidation policy and atomic token redemption; verify concurrency/revocation tests before privileged partner/finance rollout; security                          |
| R17 | P2, S/D             | App uses a DB owner with BYPASSRLS; all 24 tables have RLS disabled. Authorization is application-side                                                                                       | Separate least-privilege runtime/migration roles, complete resource-policy tests, optional scoped RLS defense-in-depth; do not change auth/database provider; operations/security |
| R18 | P2, S/D             | Vault authorName and consent authority derive from buyer, valid only under today's owner-only purchase rule; STORED is assigned at payment                                                   | Author-aware identity/rights and actual archive receipt events; retain old consent provenance; product/engineering                                                                |
| R19 | P2, S               | Asset registration trusts more client metadata than legacy upload finalization; malformed/mismatched or missing objects may enter scenes                                                     | Server object size/type/dimension verification, scoped presigns and safe parsing/storage limits; engineering                                                                      |
| R20 | P2, S               | Checkout availability checks secret key alone; production web boot logs many config errors without failing; local Stripe secrets absent                                                      | Provider readiness gate and production environment verification; local absence is not proof of live misconfiguration; operations                                                  |
| R21 | P2, S/D             | Active stored pricing has five zones/2 kg caps and old tiers; shipped defaults have seven zones/heavy parcels                                                                                | Obtain business-approved tariffs; explicit previewed versioned activation, not automatic reset. Current tariffs are documented, not validated commercially; shipping/finance      |
| R22 | P2, S               | Registration logs personal fields; email normalization/verification incomplete; welcome HTML interpolates name; some error/email reporting differs across paths                              | Minimize/redact logs, normalize identity safely with duplicate review, escape user content, reliable transactional notifications and sanitized errors; engineering/security       |
| R23 | P2, D/S             | One approved historical non-template book lacks reading PDF/manifest; no object checksum sweep was performed                                                                                 | Explicit legacy qualification exceptions; preserve owner print access; verify actual master before new sale, never fabricate artifacts; engineering/print owner                   |
| R24 | P2, S/G             | Existing query shapes/unpaginated lists, database throttles, large editor/AI modules and serverless consumers have unmeasured scale limits                                                   | Paginated public DTOs, workload-driven indexes, connection/load tests, bounded jobs; optimize measured hotspots without blanket rewrite; engineering                              |
| R25 | P2, G               | New partner roles, double panel booking, overallocated stock, repeated royalties/payouts, unsafe QR destinations and privacy retention are new attack/integrity surfaces                     | Unique constraints, guarded transactions, explicit memberships, approved redirects and data-minimization policy; relevant stage owners                                            |
| R26 | P2, D/E             | Provider-managed neon_auth is outside Prisma; migration metadata has historical failed/resolved rows. Vercel success exists but live exact binary/config is not independently attested       | Preserve provider schema/history; formal drift/restore rehearsal and deployment/schema attestation; no cleanup based on apparent disuse; operations                               |
| R27 | P3, S               | README/runbook/comments/copy differ from current behavior: render-before-review, owner downloads, superseded sessions, boot validation, price defaults, archive consent and “invoiced later” | Correct documentation/UI claims only in approved implementation; code/live evidence wins; product/engineering                                                                     |

## 2a. Post-audit risk status — November 19, 2026

Commit `718f1e9` ("Land payment reconciliation, immutable quotes, asset safety
and PDF downloads") landed hardening after the audit. Verified status changes:

- **R02 — resolved for new orders.** Orders pin the accepted quote
  (`quoteSnapshot`, `expectedMinorAmount`, `fxRate`, `quoteAcceptedAt`) under a
  database immutability trigger; payment retry validates the pinned snapshot
  and frozen configuration rather than re-pricing at current FX. Legacy orders
  keep null quote fields. PricingConfig version history is still not retained.
- **R03 — resolved for new payments.** Durable `PaymentAttempt`/`PaymentEvent`
  tables record issuance (unique idempotency key, unique `(orderId,sequence)`)
  and signed deliveries (unique `providerEventId`) with processing outcomes;
  reconciliation compares collected amount/currency against the pinned
  expectation and flags mismatches for review.
- **R05 — resolved.** Settlement uses a shared transactional boundary with
  `FOR UPDATE` row locking and `expectedUpdatedAt` compare-and-set;
  `VaultEntry.orderId` is now unique; admin settlement records operator
  evidence in `Order.manualSettlement`.
- **R06 — partially resolved.** Asset deletion is now reference-guarded soft
  removal (`deletedAt`; `src/lib/assets/references.ts` scans saved scenes,
  template elements, pins, manifests, render snapshots and legacy images under
  an advisory lock). S3 versioning/byte immutability and verified object
  retention remain absent (see R11).
- **R07 — resolved.** Both template deletion routes (owner and admin) enforce
  the same `requireNoTemplateDependents` guard under the shared fence.
- **R08 — resolved.** Private asset image responses send
  `Cache-Control: private, no-store`, `Vary: Cookie`, nosniff and
  `Cross-Origin-Resource-Policy: same-origin`.
- **R16 — largely resolved.** The session callback re-reads the current role
  from the database on every session check, so a revoked role denies
  subsequent actions; reset tokens are redeemed by a single atomic
  `updateMany` conditioned on the hashed token and expiry. Password-change
  session invalidation still has no session-version mechanism.
- **R19 — resolved for the upload path.** Asset registration verifies staged
  bytes server-side (size/type/dimension checks, animated-image rejection)
  before storing canonical content-addressed references; client metadata is
  not trusted for the stored facts.

All other entries retain their baseline status.

## 3. Evidence anchors for high-risk findings

Paths are relative to the repository root; the relevant current code was
inspected, not changed. Anchors describe the November 17 baseline; post-audit
changes are summarized in section 2a.

- R01: `src/lib/pricing/schema.ts`, `src/app/api/orders/route.ts`,
  `src/components/orders/OrderPanel.tsx` — two-character country input and
  separate zone; no server mapping between them.
- R02–R04: `src/lib/stripe.ts`, `src/app/api/orders/[id]/pay/route.ts`,
  `src/app/api/stripe/webhook/route.ts`, `prisma/schema.prisma` — mutable
  current rates/session reference, verified signature, completion/expiry cases
  and missing immutable expected charge/refund model.
- R05: `src/lib/orders/lifecycle.ts`, `src/app/api/admin/orders/[id]/route.ts`,
  VaultEntry schema — conditional webhook transition exists; admin does not use
  it, helper uses findFirst/create without uniqueness.
- R06/R19: `src/app/api/assets/[assetId]/route.ts`,
  `src/app/api/assets/route.ts`, `src/lib/pdf/snapshot.ts`, `src/lib/s3.ts` —
  deletion and object-reference/metadata limitations.
- R07: `src/app/api/submissions/[id]/route.ts`,
  `src/app/api/admin/templates/[id]/route.ts`,
  `src/lib/editor/submission-store.ts`, self-FK deletion rules — generic and
  dedicated template routes differ.
- R08: `src/app/api/assets/[assetId]/image/route.ts` — authorization precedes a
  public cache response header; exploitability was not tested.
- R09: `src/lib/ai/pipeline.ts`, `src/app/api/admin/submissions/[id]/route.ts`,
  existing SubmissionStatus — technical and manual approval routes.
- R10: `src/lib/pdf/{print-profile,generate,generate-vector,artifacts}.ts`,
  master brief sections 6.4–6.5 — one-page print validation versus eight extra
  commercial panel positions.
- R16: `src/auth.ts`, `src/app/api/auth/reset-password/route.ts` — JWT callback
  role capture; reset lookup and subsequent update do not atomically condition
  on the valid token.
- R18: `src/lib/orders/lifecycle.ts`, `src/app/api/vault/[id]/consent/route.ts`
  — purchaser-derived name/consent.
- R20: `src/lib/env-validation.ts`, `src/instrumentation.ts`,
  `src/lib/stripe.ts` — warning/assert/availability behavior differs by
  runtime/path.

Existing tests supply useful safety foundations (pricing/Stripe scaling, signed
webhook replay, payment alerts, editor queue ownership/revisions,
duplicate-as-draft and pinned templates). Their existence does not cover every
concurrency/financial/storage risk above. No new audit test pass is asserted.

## 4. Operational evidence, with limits

### Live and database observations

- November 17, 2026 at 14:18:18.960 UTC: `/` and `/vault` returned 200;
  anonymous `/dashboard` redirected to login; `/api/pricing/public` returned
  401; `/api/health` returned 200/database up.
- At 14:21:01.700 UTC: authenticated `/api/queue/health` returned 503, both
  queues `drain-stalled`, no due/processing work; last drain timestamps
  approximately 13:59:49/13:59:51 UTC. This observation is bounded in time and
  does not diagnose a permanent outage.
- S3: all four public-access-block flags true, AES256 default encryption; no
  enabled versioning status, no lifecycle configuration, no bucket policy
  returned. No secret/object content or settings were changed.
- Database: 14 application models, migration table and nine neon_auth tables; no
  RLS policies; 14 approved non-template books, one unpaid order and no vault
  entries. No paid-production transaction was available to demonstrate live
  settlement.

### GitHub read-only verification

Repository `Crowdspender/titchybooks-app`, audited SHA
`416d2c1fc09221d5254ab5a2afbd2ef5d782e982`:

| Record                                   | Observed status/time UTC                       | Interpretation                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit Vercel status                     | success, updated 13:58:58                      | Deployment integration reported success for this SHA; does not independently attest all live domain settings/runtime code                                  |
| Reliability checks, two push runs        | success; completed 13:45:33 and 13:50:06       | Existing CI runs passed at the SHA; tests were not rerun by this audit                                                                                     |
| Nightly database backup, manual dispatch | success; 13:52:14–13:52:41                     | Workflow succeeded; no full restore proof or future scheduled cadence guarantee                                                                            |
| Drain background queues, manual dispatch | failure at 13:52:17; success 13:59:44–13:59:54 | Recovery/manual execution evidence, consistent with latest DB heartbeat; no later successful scheduled run appeared in the eight most recent runs returned |

Historical memories of fixed deployment/secrets/schedulers are not stronger
evidence than these current observations. Successful manual runs and the later
stale heartbeat can both be true. No workflows were triggered, secrets changed,
branch switched or deployment performed.

## 5. Business/product decisions requiring approval

| Decision                              | Recommended starting position                                                                                                                             | Approval needed before                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| D01: book identity/versioning         | Keep existing Submission ID as root; new immutable versions/listings; derive drafts explicitly                                                            | Stage 1 implementation                        |
| D02: commercial rights/moderation     | Separate human commercial approval and versioned author license from AI technical approval; no automatic listing                                          | Stage 1 public catalog                        |
| D03: retail/quantity economics        | Shared HUF engine, per-publication print tiers, configurable retail/PDF/commission rules; no example rates activated                                      | Stage 2 selling                               |
| D04: shipping coverage                | Explicit country/carrier service matrix, approved tariffs/packaging, manual quote outside supported caps                                                  | Stage 2 checkout                              |
| D05: tax and merchant responsibility  | Obtain jurisdiction-specific merchant-of-record, VAT/invoice, digital consumer-rights and author payout advice                                            | Any new paid commercial launch                |
| D06: quote/FX validity                | Immutable accepted amounts; configurable 15-minute quote acceptance proposal; explicit repricing and late-payment reconciliation                          | Stage 2 payments                              |
| D07: digital identity/license         | Account-based verified PDF buyer initially; verified guest claim path if supported; personal print/fold license, no resale                                | Stage 2 digital sales                         |
| D08: royalties and abuse              | Fixed configured per-copy rates; print payable on documented delivered quantity, PDF on payment plus entitlement; self-purchases ineligible               | Stage 3 acceptance / before paid retail pilot |
| D09: refunds/chargebacks/payouts      | Append negative adjustments, hold disputed balances, manual payout thresholds and transfer evidence; define post-download and post-payout recovery policy | Stage 3 / commercial launch                   |
| D10: sponsorship terms                | Versioned accepted quotes, paid/approved arrangements before production, separately agreed campaign royalty; charity placement is not donation            | Stage 4                                       |
| D11: sponsored physical specification | Approve reverse-side/eight-slot imposition and fold proof, branding/color/QR dimensions, vacancy behavior                                                 | Stage 4 edition rendering/production          |
| D12: outlets and engagement           | Edition-specific placements, event-based stock and minimal QR data with retention; scans are not conversions                                              | Stage 5                                       |
| D13: operations and retention         | Name owner for staging, restores/PITR, file retention, scheduled consumers, least privilege, incident response and durable QR domain                      | First approved deployment / launch            |

These are explicit questions for the review, not choices silently made by
migration. Technical implementation can be staged around unresolved later-stage
choices, but may not invent production legal/rate/print decisions.

## 6. External dependencies and launch evidence

| Dependency                 | Needed evidence / responsible party                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neon                       | Restore/PITR retention, role grants, pool/direct connection limits, PostgreSQL-version rehearsal; operations                                               |
| S3                         | Referenced-object integrity, approved versioning/retention/TLS/IAM/CORS, recovery process and restricted master access; operations                         |
| Vercel/GitHub              | Exact release/schema compatibility, runtime budgets, scheduled execution/alerts, isolated environments; operations                                         |
| Stripe                     | Correct live/test account, webhook events/secrets, amount/currency/reconciliation, refunds/disputes and provider test-mode acceptance; finance/engineering |
| Resend                     | Verified sender/delivery monitoring and retryable transactional order/download notices; operations                                                         |
| Printer/carriers           | Commercial print proof, packaging, actual country/service tariffs, fulfillment evidence and damage/return policy; print/shipping owner                     |
| Legal/accounting           | Publishing/digital/sponsorship terms, copyright permissions, consumer rights, taxes, invoices, cross-border author payments, privacy/retention; business   |
| Sponsors/charities/outlets | Approved identity/assets/destinations, signed terms and distribution/placement permissions; partner operations                                             |
| Outernet/Memlocal          | No launch dependency; future identifiers/adapter contracts only                                                                                            |

## 7. Migration and irreversible-effect risks

Adding tables is not by itself safe: old Prisma clients/workers may fail on new
enum meanings or nullable legacy fields. Deploy compatible readers/claim filters
before activating mixed orders or edition jobs. Preserve the last compatible
rollback build; a pre-feature binary may not safely read post-feature data.

Do not rewrite old HUF amounts, infer paid state, invent historical
FX/manifests/consent, merge similar books or delete provider tables. Imported
provenance can be incomplete without making existing owner books unusable. New
sales must pass stricter qualification independently.

Database restoration cannot undo Stripe charges, bank payouts, shipped books,
downloaded PDFs or printed QR codes. Recovery needs provider/event/stock
reconciliation and compensating entries. Paid financial records, original
publications and retained editions must not cascade-delete. See the
[migration plan](DATABASE_MIGRATION_PLAN.md) for
expand/backfill/validation/cutover boundaries.

## 8. Approval package and stop condition

Review all eight documents, especially
[proposed architecture](PROPOSED_ARCHITECTURE.md),
[migration plan](DATABASE_MIGRATION_PLAN.md) and
[roadmap](IMPLEMENTATION_ROADMAP.md). Confirm the reuse-first identity/service
approach, approve the next stage's scope, and resolve its blocking decisions.
Indicative total complexity is high, estimated 30–46 engineering person-weeks
plus external approval/production lead time.

Only audit documents were authored. Source, migrations, schema, dependencies,
configuration and production business data were not modified. No implementation,
payment, deployment or repair has started.

**Stop after Phase 0. Await explicit user approval before Stage 1; obtain
separate approval for production changes.**
