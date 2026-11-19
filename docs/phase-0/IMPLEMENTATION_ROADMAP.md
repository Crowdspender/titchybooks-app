# Implementation Roadmap — Phase 0 Approval Proposal

Date: November 17, 2026. Phase 0 only has been performed. The following sequence
is recommended, not authorized or started.

## 1. Delivery strategy and estimated complexity

Preserve the existing application and implement the brief's six stages behind
independent release flags. Reuse Submission/editor/rendering,
Order/pricing/Stripe and existing dashboards. Build the financial and
file-retention foundations before exposing paid marketplace sales. Do not treat
a completed screen as a completed stage.

Indicative effort is **30–46 engineering person-weeks**, including the explicit
foundation work below and stage testing. This is a planning range, not a
quotation or elapsed-time promise. It assumes experienced full-stack delivery,
timely product/legal/print decisions, reuse of the current stack, and no major
provider migration. External legal review, printer proof/turnaround, carrier
negotiations, stakeholder acceptance and production approvals may add calendar
time. Parallel staffing does not remove dependencies or divide the estimate
linearly.

| Work package                                  | Relative complexity | Indicative effort | Why                                                                                        |
| --------------------------------------------- | ------------------- | ----------------: | ------------------------------------------------------------------------------------------ |
| Approved foundation hardening, within Stage 1 | High                |  2–3 person-weeks | Retention/deletion/access risks, operations evidence, staging/restore and migration safety |
| Stage 1: publication/catalog                  | High                |               4–6 | Immutable versions, rights/moderation, catalog and public DTOs without breaking authoring  |
| Stage 2: unified commerce                     | Very high           |               6–9 | Items, immutable prices/FX, concurrent settlement, refunds, digital/physical separation    |
| Stage 3: earnings/payouts                     | High                |               4–6 | Exactly-once accounting, partial eligibility/reversals and reconciliation                  |
| Stage 4: sponsorship                          | Very high           |              7–11 | Campaign contracts, independent editions, eight-slot concurrency and print qualification   |
| Stage 5: distribution/tracking                | High                |               4–6 | Stock/event integrity, partner permissions and durable privacy-aware QR routing            |
| Stage 6: integration/launch                   | High                |               3–5 | Full journeys, restore/rollback, provider reconciliation and operational documentation     |

The existing small database reduces backfill volume, not financial concurrency,
security or production recovery complexity. Refine estimates after approved
Stage 1 foundation work and physical print specification.

## 2. Dependency and approval sequence

```text
Phase 0 documents -> explicit architecture/scope approval
  -> Stage 1 foundation + publication/version/rights/catalog pilot
  -> Stage 2 commerce in isolated/test-mode pilot
  -> Stage 3 accounting and payout acceptance
  -> limited paid retail pilot only with separate commercial/release approval
  -> Stage 4 sponsorship, gated by signed terms and physical print proof
  -> Stage 5 outlet distribution and engagement pilot
  -> Stage 6 complete integration/security/commercial launch approval
```

Testing begins in every stage; Stage 6 is not the first security/payment test.
Stage 2 must retain agreed royalty source facts, and public paid sales stay
disabled until Stage 3 can account for them. Future sponsorship/outlet
references are added in dependency order; Stage 4 may create the minimal
approved outlet directory needed to allocate outlet panels, while Stage 5
delivers its portal/stock/tracking workflows.

Every stage ends with an evidence-backed review. No move to the next stage with
unresolved critical defects. Production migrations/settings/deployments always
require a specific approved release plan beyond development approval.

## 3. Stage 1 — foundation and open publishing marketplace

### First approved work: reduce known risks

- Reconcile the stale scheduler observation against current GitHub/drain status;
  establish reliable cadence/alert ownership. Do not assume a successful manual
  run proves the schedule.
- Verify retained S3 objects, approved backup/restore procedure,
  versioning/lifecycle/TLS policy and least-privilege access. Fix only through
  approved configuration changes.
- Centralize asset/template retention and deletion checks; close private-image
  shared-cache exposure; harden reset redemption/session revocation and identity
  validation where required.
- Establish PostgreSQL 17 staging and safe test/provider isolation; capture
  baseline CI/regression evidence and exact deployment/schema compatibility.
- Agree publishing rights, content moderation and independent public author
  identity. Preserve AI technical approval and owner-only legacy access.

### Feature scope

- Existing Submission root identity and explicit copy-as-new-version linkage.
- Immutable PublicationVersion/file provenance with legacy print-only support.
- Private-by-default listings with separate rights/commercial review and author
  opt-in.
- Public author profile, categories/tags/language, search/filter, featured/new
  releases and safe samples.
- Listing management and administrator reject/suspend/unpublish/tombstone
  controls.
- Availability and retail/commission configuration interfaces, with sales
  disabled until pricing/payment/royalty readiness. No invented initial rates.

### Exit evidence

- Existing approved book can become a listing without content/PDF recreation.
- All existing private books remain private; commercial listing never follows
  automatically from AI approval.
- Public API exposes no account email/ID, scenes or master keys.
- New version does not mutate an old approved/sold version; all
  authoring/AI/template workflows still pass.
- Permission tests cover wrong owner/admin, metadata revisions, suspension and
  source deletion.
- Migration rehearsal preserves all old IDs/keys and documents unresolved
  artifact exceptions.

Migration groups: M1. No new production rollout without approved
backup/deployment/rollback.

## 4. Stage 2 — commerce, checkout and digital products

### Scope

- Versioned central configuration and immutable server quote, rate/rounding/tax
  snapshots.
- Country-to-zone/carrier mapping and approved destinations; retain current pure
  pricing primitives and quantity/quote UI.
- Multi-publication PRINT/PDF basket; physical-only aggregate weight,
  digital-only no shipping/address requirement.
- Extend Order with items and compatibility adapters; preserve existing owner
  print flow/history.
- Payment attempts/events, provider idempotency, atomic shared webhook/admin
  settlement, late/duplicate/mismatched payment reconciliation.
- Full/partial refunds and dispute state, item allocations and recoverable
  notification outbox.
- Verified customer identity; account-based PDF entitlement and repeat access to
  the purchased print master.
- Physical fulfillment/shipments/production targets, item statuses and corrected
  author-aware vault logic.
- Snapshot royalty terms/source facts for Stage 3; no public paid launch yet.

### Exit evidence

- Another author's eligible book can be bought in test mode; private books
  cannot.
- Multi-book mixed and digital-only totals reconcile; digital items add zero
  weight; invalid country/zone combinations fail closed.
- Price/config/FX changes do not alter accepted orders or retry amounts; HUF
  charge precision remains correct.
- Concurrent admin/webhook/retry, duplicate/out-of-order events and delayed
  payment outcomes produce one entitlement/economic result.
- Refund/dispute state reconciles to provider and item totals; email failure
  does not lose settlement.
- Expired/unauthorized download links fail; repeated authorized access returns
  the correct sold version after listing updates.
- All old order/vault UI/API behavior passes compatibility tests, including the
  historical unpaid order.

Migration groups: M2. Stage 2 sign-off is technical/test-mode acceptance, not
permission to accept unaccounted real marketplace money.

## 5. Stage 3 — author commissions and earnings

### Scope

- Configurable fixed per-copy agreement versions for print/PDF; future
  percentage representation without activating unapproved models.
- Immutable accrual/reversal ledger with source keys, currency/rate/FX
  snapshots, eligibility evidence and self-purchase exclusion.
- Physical delivered-quantity eligibility, digital paid-plus-entitlement
  eligibility, partial refunds/chargeback holds.
- Author earnings by publication/format/date; lifetime, pending, available,
  paid, reversed; CSV export.
- Admin payout requests/thresholds/approval/manual transfer evidence and
  per-entry allocation.
- Private author payment/tax data, reconciliation reports and duplicate payout
  protection.

### Exit evidence

- Duplicate events cannot create duplicate commissions; distinct qualifying
  portions accrue only their correct quantities.
- Refund/cancellation reversals use original economics; changes in rates do not
  rewrite history.
- Self-print produces no marketplace commission; negative balance after
  already-paid refund is visible.
- Authors cannot access other authors' financial records; exports resist
  spreadsheet formula injection.
- Payout allocations reconcile to eligible balance and bank evidence; no
  automatic marketplace payouts.
- End-to-end author → customer purchase → fulfillment → commission → manual
  payout works in isolated acceptance testing.

Migration group: M3. Limited paid retail pilot requires
product/legal/tax/provider readiness and explicit release approval; final broad
launch remains Stage 6.

## 6. Stage 4 — sponsorship marketplace

### Scope

- Organization membership, approved sponsors, charity identity/permission
  records and minimal outlet directory needed for panels.
- Sponsor-facing eligible catalog/audience filters, enquiries, author
  suggestions and admin proposal handling.
- Immutable campaign quotes with configurable fees, costs, royalties,
  distribution/tax/margin breakdown and acceptance.
- Funding through existing Order/payment services; no second payment system and
  no false donation accounting.
- Independent SponsoredEdition linked to source approved version,
  sponsor/campaign and its own files/production run.
- Exactly eight available panel positions;
  vacancy/reservation/allocation/approval/history; race-safe reservation.
- Separate edition render target and print profile; original source/artifacts
  stay unchanged.
- Controlled campaign review/payment/artwork/production workflow,
  revision/rejection/cancellation paths.

### External gate before print implementation/release

Printer/owner approve a physical reverse-side/folding/imposition proof, panel
geometry, safety margins, color/profile, branding and QR rules. The current
eight editorial pages are not this feature. Reusing the common rendering
pipeline does not remove this dependency.

### Exit evidence

- Two sponsors produce independent editions of the same book without altering
  original content/files or each other's finances.
- Exactly eight slots exist even with approved vacancies; simultaneous
  allocation cannot double-book a slot.
- Charity/outlet assets and destinations have permission/approval; placement
  fees are distinguished from donations.
- Production cannot start without accepted commercial terms, approved funding
  arrangement and final artwork.
- Failed/stale edition render cannot publish to the original or a newer edition;
  original print/reading generation still passes.
- Campaign royalty and fee/refund records reconcile through shared finance
  services.

Migration groups: M4; production runs and file reference tables gain edition
relations only when edition tables exist and compatible consumers are deployed.

## 7. Stage 5 — distribution network and QR tracking

### Scope

- Expand reusable outlet directory with location/capacity/subjects and approval;
  simple membership-scoped portal.
- Edition/run-specific allocations, dispatch/delivery, replenishment, reported
  remaining stock and completion events.
- Explicit edition-specific promotional agreements; outlet enrollment never
  grants universal placements.
- Unique durable QR links associated with
  campaign/version/edition/panel/beneficiary and optional outlet variants.
- Approved outbound redirect destinations, minimal engagement data, bot
  labeling/retention and aggregate reporting.
- Optional promotional conversion codes with real evidence, separated from
  anonymous scans.
- External-reference adapter seam for Outernet, without making it required.

### Exit evidence

- Multiple outlets receive allocations whose totals reconcile to produced stock;
  concurrency cannot over-dispatch.
- Only the appropriate outlet member can view/change its records; sponsor sees
  allowed aggregate participation.
- Low-stock/replenishment requests are idempotent and do not silently create
  shipments.
- Printed QR resolves correctly, unsafe/unapproved destinations are blocked and
  changes are audited.
- Reports clearly distinguish allocated/dispatched/delivered/reported stock,
  engagement and verified conversions/donations.
- Distribution works with no Outernet connection.

Migration group: M5. Start with a bounded partner pilot and define ownership of
the long-lived QR domain.

## 8. Stage 6 — integration, security and commercial launch

Run all five brief journeys: A author/physical/royalty/payout; B digital
purchase and correct file; C mixed basket; D funded sponsored
production/distribution/royalty; E multiple independent sponsored editions.

Also require:

- Cross-role permission matrix, session revocation, private-file/cache isolation
  and public DTO tests.
- Duplicate/late/failed payment, refund/dispute, interrupted checkout, missing
  file, expired download, invalid destination, concurrent panel/stock/payout
  scenarios.
- Complete regression across all 16 existing journeys, including templates,
  autonomous AI, owner print orders and vault consent.
- Catalog/query and queue load testing with realistic data; pagination, indexes
  and connection limits verified.
- Backup restore and compatible rollback rehearsals with external-payment
  replay/reconciliation; record recovery times/points.
- Verified S3 retention/IAM, live provider readiness, observable scheduled
  consumers, alert ownership and incident runbooks.
- Test results, final schema/migration/API/environment docs,
  admin/creator/sponsor/outlet instructions, known issues, deployment and
  rollback procedures.
- Explicit legal/VAT/invoicing/payout/privacy sign-off and final commercial
  release approval.

Critical financial, access, original-content preservation and recoverability
defects block launch. An HTTP 200 home page or successful build is insufficient.

## 9. Test infrastructure and evidence plan

Reuse existing 19 unit files, 13 integration files, 3 browser specs, one
design-browser spec and standalone pricing tests. Existing fixtures cover
database/orders/scenes/Stripe events; extend them for versions, items, refunds,
royalties, campaigns and stock. Keep isolated test URL checks. Provider sandbox
tests and physical proof complement, not replace, unit/integration tests.

Every stage records: migrations and files changed, implemented behavior,
affected existing functionality,
DB/backend/frontend/permission/financial/regression test results, outstanding
issues, security impact, deployment requirements and next-step approval. Begin
the brief's running `IMPLEMENTATION_STATUS.md` only after implementation is
approved; no ninth audit document is being created now.

No tests/builds were run during this audit. External GitHub CI success at the
baseline is noted separately and does not replace the stage acceptance evidence
above.

## 10. Deferred scope and current stop

No initial implementation of subscriptions, template marketplace, automated
Connect payouts, YouTube/website-to-book, external design downloads, sponsor
noticeboard/AI proposals, or Outernet/Memlocal integration. Preserve existing AI
generation/editor support.

**Current state: eight Phase 0 audit documents only. Await explicit review and
approval of architecture, migration strategy and implementation sequence. No
Stage 1 work or production changes may begin automatically.**
