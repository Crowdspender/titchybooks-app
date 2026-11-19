# Database Migration Plan — Phase 0 Proposal

Date: November 17, 2026. This is a design/rehearsal plan only. No migration
file, schema change, SQL execution, data backfill or production configuration
change is authorized or performed.

## 1. Migration principles and approval boundaries

1. Preserve every existing User, Submission, Order, template, page, job and
   vault identity. Keep approved files and historical monetary snapshots.
2. Map publication identity to existing non-template Submission; add
   commercial/version relations, not a duplicate Books table.
3. Expand → deploy compatible readers/writers → backfill idempotently → validate
   → enable narrowly. Contract/destructive cleanup is outside the initial
   rollout.
4. New features default disabled; listings/author profiles remain private until
   explicit consent and approval. No bulk publication, consent fabrication or
   automatic commission assignment.
5. Retain all 15 migration files and existing migration history, including the
   failed/rolled-back repair record. Never edit historic migrations to make a
   fresh database look convenient.
6. Keep `neon_auth` outside the Prisma application migration scope. Backups must
   account for it; ownership must be resolved before any provider-schema change.
7. Architecture approval is not production migration approval. Each production
   release requires explicit approval of its backup, migration, verification and
   rollback plan.

Baseline: [schema inventory](DATABASE_SCHEMA_AUDIT.md), commit
`416d2c1fc09221d5254ab5a2afbd2ef5d782e982`. Observed 8 users, 48 submissions, 1
pending order. Counts are audit-time observations, not hardcoded backfill
expectations; recapture immediately before an approved rehearsal/release.

## 2. Preconditions before authoring/running migrations

After Phase 0 approval, but before production changes:

- Confirm deployed build/client, repository schema and migration checksums;
  formally compare declared public schema against an isolated clone/shadow
  database.
- Establish a production-like PostgreSQL 17 staging/restore target. Preserve
  local-only TEST_DATABASE_URL guards; never substitute DATABASE_URL when tests
  lack configuration.
- Verify least-privilege runtime/worker roles and separate migration
  credentials. Determine Neon pooler/direct-connection requirements and DDL lock
  behavior for the deployed setup.
- Take an approved database backup/restore point, with retention/access
  controls; verify full restore into an isolated environment and
  count/relationship reconciliation. GitHub's successful archive/listing job is
  not a restore proof.
- Preserve referenced S3 objects and record metadata before file backfills.
  Existing bucket versioning/lifecycle are not enabled as the runbook implies;
  any remedial storage changes require separate approval. Enabling versioning
  later cannot recover already-overwritten/deleted bytes.
- Agree legal terms, initial commercial settings, supported destinations and a
  feature-flag/release owner. Stage-specific unresolved decisions block that
  stage, not justify guessed production values.
- Capture preflight counts, enum values, orphan checks, duplicate candidates,
  artifact reference coverage, active jobs and existing payment sessions without
  exposing personal data in reports.

## 3. Proposed migration groups

These are logical groups, not generated filenames or a commitment to one large
migration per group.

| Group / stage                                  | Existing structures affected                                                                                                               | New structures                                                                                                                                            | Default and gate                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| M1a: identities and audit foundation / Stage 1 | User additive verification/session-revocation fields; Submission nullable publicationRootId                                                | AuthorProfile, TermsVersion, RightsAcceptance, AuditEvent                                                                                                 | Unverified/private; no existing session invalidation or public profile activation without rollout policy              |
| M1b: publication/files / Stage 1               | Submission remains book/content identity; Asset/RenderJob reference tracking hooks                                                         | PublicationVersion, PublicationReview, PublicationListing, Category/PublicationCategory, Tag/PublicationTag; FileRecord, VersionFile, SourceFileReference | No automatic listing; imported versions are provenance snapshots, not commercial approvals                            |
| M2a: immutable settings/quotes / Stage 2       | PricingConfig retained as active legacy-compatible projection                                                                              | CommercialConfigVersion, CheckoutQuote                                                                                                                    | Import exact observed config; no reset to source defaults                                                             |
| M2b: unified commerce / Stage 2                | Order additive origin/schema/payment/contact fields; later selective nullability of legacy fields                                          | OrderItem, PaymentAttempt, PaymentEvent, Refund, RefundAllocation, OutboxEvent                                                                            | Legacy orders keep old fields; marketplace sales disabled pending reconciliation/royalties                            |
| M2c: digital/physical delivery / Stage 2       | VaultEntry optional item linkage plus legacy uniqueness                                                                                    | DownloadEntitlement, EntitlementEvent, FulfilmentItem, Shipment, ShipmentItem, ProductionRun, ProductionRunItem                                           | No entitlement from merely APPROVED books or old unpaid orders; no fictitious shipments                               |
| M3: royalties/payouts / Stage 3                | OrderItem references agreed rates/source facts                                                                                             | RoyaltyAgreementVersion, RoyaltyEntry, RoyaltyEligibilityEvent, Payout, PayoutAllocation; restricted AuthorPaymentProfile                                 | No invented historical earnings/bank details; paid marketplace remains gated until tested                             |
| M4a: business/campaigns / Stage 4              | Reuse User membership and Order payment boundaries                                                                                         | Organization, OrganizationMembership, SponsorProfile, CharityProfile, minimal OutletProfile directory, CampaignEnquiry, Campaign, CampaignQuote           | Organizations/capabilities pending approval; quotes unpaid/unaccepted; outlet identity exists before outlet panel FKs |
| M4b: editions/panels / Stage 4                 | RenderJob target discriminator plus nullable edition FK; ProductionRun gains edition target; existing submission/version targets preserved | SponsoredEdition, EditionPanel, PanelEvent, EditionFile; source-file reference extension                                                                  | Eight vacant slots per edition; original content/artifact fields untouched; edition consumer compatibility first      |
| M5: distribution/tracking / Stage 5            | ProductionRun ties stock to immutable edition/version; expand Stage 4 OutletProfile directory into partner operations                      | CampaignDistribution, DistributionEvent, ReplenishmentRequest, TrackingLink, ScanEvent; optional ExternalReference mapping                                | No automatic placement rights, fabricated inventory or conversion counts                                              |
| M6: launch hardening / Stage 6                 | Query/retention/observability improvements proven by rehearsals                                                                            | Only necessary indexes/constraints or derived reporting structures                                                                                        | No broad schema redesign or destructive cleanup hidden in launch                                                      |

Dependency ordering is explicit: Stage 2 royalty terms are immutable snapshots
without a required FK to a future Stage 3 agreement table; add validated
agreement linkage in M3. Stage 2 production runs target ordinary versions; add
the edition FK/XOR constraint only in M4 after SponsoredEdition exists. Stage 4
panels can use approved direct URLs; their stable tracking-link FK/QR routing
arrives in M5 before tracked campaign rollout.

Required joins/event rows are listed to expose integrity boundaries, not to
prescribe an unnecessary generic enterprise framework. Add each with its owning
workflow, not all future tables before Stage 1. Approval may consolidate closely
related records while preserving the stated invariants.

## 4. Key design and constraints

Use existing text/cuid identity conventions for new application entities,
retaining all old IDs. New operational/event timestamps should be timezone-aware
UTC; leave legacy timestamp semantics unchanged and document adapter handling.
Monetary/provider amounts use explicit integer units with bigint capacity; new
FX uses exact decimals. Serialize large integers as strings in APIs. JSONB holds
versioned frozen documents, not replaceable substitutes for important
FKs/amounts.

### Publication and file integrity

- `Submission.publicationRootId` references a root Submission; root NULL is
  distinct from a self-loop. Application transaction plus enforced validation
  rejects template roots, mismatched owners and chains/cycles.
- PublicationListing root ID is unique; PublicationVersion has unique
  `(rootSubmissionId,versionNumber)` and `(sourceSubmissionId,sourceRevision)`.
- Version/file joins have unique association keys; source/active version must
  belong to the same root. Use composite keys/FKs where practical, with deferred
  validation for remaining cross-row rules.
- Financially/sold/campaign-referenced versions/files use RESTRICT, not
  cascading delete. Immutability applies to frozen content and file identities;
  review/eligibility changes are append-only event records with projections.
- FileRecord key/provider-version identity is deduplicated with explicit
  treatment of historical NULL VersionId. Missing digest/version/reading file
  remains NULL with an UNVERIFIED or LEGACY provenance state, never an invented
  value.
- Protect source asset references used by frozen versions, templates, editions
  and pending render jobs. New deletion policy must cover all routes, including
  generic draft deletion; registering only generated PDFs does not solve source
  retention.

### Orders and money

- Unique order request key scoped to customer/verified checkout identity, unique
  consumed quote, unique provider session/payment/event identifiers and
  immutable attempt amount/currency.
- OrderItem positive quantity and valid type/source combinations. PRINT/PDF
  references a version; sponsorship/panel fee references accepted campaign
  quote; vault service references the specific ordered book/version. One source
  of authoritative line economics.
- CHECK nonnegative price/cost quantities and valid currency/units;
  transactional total reconciliation handles cross-row sums. Do not try to
  implement cross-table sums as ordinary CHECK constraints.
- Refund allocations cannot exceed original charge/item refundable amounts or be
  applied twice. Accepted provider refund ID is unique; completed financial
  postings cannot be edited/deleted by runtime roles.
- Unique purchased entitlement per license item; content-version and buyer
  authorization are independent from author ownership.
- Vault legacy uniqueness is one archive entitlement per old order. Add
  uniqueness only after preflight duplicates are resolved through an approved
  reconciliation plan; never auto-delete duplicates. New item-level vault rows
  require unique orderItemId; retain legacy provenance so mixed orders can
  legitimately contain multiple archive services.
- Publication suspension cannot cascade-delete OrderItem, payments, entitlements
  or royalties.

### Royalties and campaigns

- Royalty economic source keys uniquely identify initial accrual, partial
  fulfillment eligibility, reversal and campaign milestone. Refund corrections
  append linked negative postings using original rates.
- Payout allocation is bounded by eligible net balance and protected by
  author/currency locking; paid allocations are immutable. Do not sum multiple
  currencies without an explicit conversion record.
- Campaign source version is pinned; final edition belongs to that
  campaign/source. Production target is exactly one ordinary version or
  sponsored edition.
- EditionPanel unique `(editionId,position)` plus CHECK position 1–8; deferred
  inventory constraint verifies eight positions at commit. Typed beneficiary
  references must match slot type. Atomic reservations and version checks
  prevent double allocation.
- Distribution quantities are nonnegative; delivered/allocated/dispatch totals
  reconcile to the production run and its events. QR code is unique; target URL
  is approved application data, not an arbitrary redirect input.

Index child FKs and actual query patterns, especially `(owner,createdAt,id)`,
`(listingStatus,publishedAt,id)`, `(author,currency,createdAt,id)`,
`(sponsor,status)`, `(outlet,status)`, and `(trackingLinkId,scannedAt)`. Avoid
speculative indexes on every JSON field. For larger tables, use approved
low-lock index creation/constraint validation and bounded lock/statement
timeouts; test migration-runner compatibility before nontransactional DDL.

## 5. Legacy mapping and backfill rules

| Existing data                              | Proposed mapping                                                                                                   | Must not happen                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Eight User rows                            | Same IDs/credentials; optional profile only on explicit setup                                                      | Automatic email verification, publishing license or bank/tax assumptions                            |
| Six template submissions                   | Remain templates/instances through existing relations                                                              | Publishing them as ordinary marketplace books                                                       |
| 42 non-template submissions                | Existing IDs remain independent book roots unless a user explicitly starts a linked new version                    | Title-based merging or creating duplicate book records                                              |
| 14 approved non-template submissions       | At most one initial provenance version per observed approved source revision, idempotently keyed                   | Treating technical approval as commercial approval or public opt-in                                 |
| 13 modern dual-artifact sets               | Reuse existing keys/manifests through FileRecord associations after actual validation                              | Regenerating/copying all PDFs or asserting unverified object integrity                              |
| One historical print-only book             | Retain print key and legacy qualification state; owner flow remains available                                      | Inventing reading PDF/digest or blocking historical owner access solely for missing modern manifest |
| 28 drafts                                  | Remain editable drafts, no approved version required                                                               | Premature immutable approval or commercial listing                                                  |
| One pending Order                          | Same ID, amounts/currency/address/status; create one legacy PRINT item with original quantity and source reference | Marking paid, assigning commission, fabricating a Stripe payment or repricing using new config      |
| PricingConfig version 1                    | Archive the exact observed normalized configuration with observed-at provenance; retain original active row        | Claiming this recreates every historical version or activating new defaults                         |
| VaultEntry                                 | Preserve all IDs/consent and purchaser provenance; zero existed at audit                                           | Generating archive rows from all approved books or transferring consent to a retail buyer           |
| AI/render jobs                             | Preserve states, counters, snapshots, leases and history                                                           | Requeueing jobs, resetting failure budgets or draining queues as migration side effects             |
| PaymentAlert / rate limits / drain records | Preserve behavior and retention contract                                                                           | Treating mutable alerts/telemetry as immutable financial history                                    |
| neon_auth / Prisma history                 | Excluded from application rewrite; included in backup scope as appropriate                                         | Dropping “unused” provider tables or rewriting migration metadata                                   |

A historical order can reference its original Submission until a verified
immutable version association is available. A legacy item must carry
`LEGACY_UNKNOWN` provenance for unavailable provider/FX/file facts rather than
enforce a fabricated modern record. Never infer actual paid currency amount from
a current exchange rate. Reconciliation with Stripe, if needed, is a separately
authorized read/import step.

Backfills must be restartable by stable unique keys and run in small bounded
transactions with recorded run ID, checkpoint, counts, exception list and
provenance. Dry-run/select reports come first. Conflict/unknown records go to
review, not destructive cleanup. Concurrent new writes use compatible
dual-writing until validation confirms coverage.

## 6. Deployment compatibility and cutover

### Expand and dual-write

1. Add nullable columns/new tables/indexes with safe defaults; existing
   application continues to read/write its original shapes.
2. Deploy adapters and shared policy/settlement services before enabling any new
   writer. Backfill historic rows while all current writes also create required
   new side records.
3. Compare legacy response/calculation behavior and newly derived records in
   staging; only change authoritative reads after reconciliation.
4. Keep existing Order totals as authoritative for old orders. New basket orders
   are item-authoritative; old scalar fields are not misleading alternate
   totals.

### Nullability and new work-type barriers

Old clients may assume Order.userId/submissionId/address/quantity are required.
Permit verified guests, mixed/digital-only headers and NULL legacy scalar fields
only after every route, admin page, email, vault helper and worker can handle
them. New order headers retain common total/currency fields; item-specific
legacy fields remain populated only for compatible legacy single-book paths.

RenderJob's current required submissionId cannot be repurposed to point at the
original while rendering a sponsored edition. Add target discrimination, teach
all claim/processing/health paths to handle or exclude edition jobs, then permit
NULL submissionId exclusively for valid edition jobs. Do not let an old worker
claim an unfamiliar target.

Keep existing enums/meanings stable. New commercial state machines use new
fields/tables rather than changing old APPROVED or PAID semantics. Deploy
application and workers from compatible versions; long-lived workers load code
at startup and require an approved restart plan.

### Enablement

Enable Stage 1 private author/admin pilot, then approved listings. Stage 2
checkout remains test/pilot-gated until Stage 3 accounting is accepted. Stage 4
sponsorship remains production-gated until physical proof and
contractual/financial approvals. Stage 5 rollout starts with a small approved
outlet set. Features are independently reversible at the routing/UI level.

## 7. Validation and rollback

### Required migration/reconciliation checks

- Fresh database full migration history and upgrade from restored current schema
  both succeed on PostgreSQL 17; CI's PostgreSQL 16 remains a separate
  compatibility check.
- All pre-existing IDs, owner relations, monetary components, statuses, private
  consent and approved keys are unchanged unless an explicitly approved mapping
  says otherwise.
- Version/file backfill counts match eligible source rows; no templates
  published, no fake reading files or approvals, no orphan roots/references.
- Legacy order sum and new legacy-item sum reconcile exactly; no paid
  events/royalties created for pending orders.
- Duplicate webhook/admin/backfill replays produce one economic outcome;
  race/partial-refund scenarios reconcile.
- All new FK/uniqueness/CHECK/deferred invariants validate; failed data
  exceptions are surfaced rather than discarded.
- Old and new API regression tests pass across owner access, templates, AI,
  rendering, pricing, ordering and vault.
- Restored database plus retained object references reproduces access to sampled
  originals; restore timing and recovery point are recorded.

### Rollback boundaries

Before new feature writes: disable flag and return to compatible old reads;
leave harmless expanded schema/data in place. Do not drop new tables just to
roll back code.

After mixed orders/edition jobs exist: the pre-feature binary may not understand
NULL legacy fields or new targets. Roll back only to the last **compatible**
release; stop new feature intake, allow/reconcile existing work and prefer
forward repair. Preserve webhooks/outbox/settlement consumers so real money is
not abandoned.

After payments/payouts/dispatch: database rollback alone is not economic
rollback. Stripe refunds, bank transfers, shipments, delivered files and printed
QR codes cannot be undone by restoring tables. Use explicit
compensation/reconciliation and maintain all event history. A production
point-in-time restore requires a plan to replay external events after the
restore point and reconcile provider/stock state; never restore blindly over
later sales.

Original approved PDFs and versions must remain accessible throughout. No
destructive contract migration or source asset purge is included in these six
stages without a separately approved retention and recovery plan.

## 8. Approval checklist

Approve architecture/entity mapping and staged migration scope; assign
migration/operations owner; confirm restore and staging evidence; approve
privacy/rights/commercial settings; resolve sponsored print specification before
edition rollout; define production verification/rollback thresholds; authorize
each production change separately.

**Phase 0 stops here. This document is not executable migration work and does
not authorize implementation.**
