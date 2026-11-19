# Existing Workflows — Phase 0

Audit date: November 17, 2026. Source/database inspection and bounded live reads
only. No accounts, books, payments or production records were created or
changed.

## Status terminology

- **Implemented:** end-to-end code paths exist; not a claim of a fresh live
  acceptance test.
- **Persisted evidence:** corresponding non-personal records exist in the
  configured database.
- **Partial/problematic:** a concrete missing behavior or correctness boundary
  was identified.
- **Absent:** no implementing schema/service/UI was found after cross-checking
  the complete subsystem inventory.

Existing tests were inspected, not rerun. GitHub subsequently reported
successful `Reliability checks` runs at the audited commit, completing at
13:45:33 and 13:50:06 UTC on November 17. This is external CI status evidence,
not an audit-run test result or proof of every live journey.

## The 16 required user journeys

| #  | Journey and main entry points                                      | Current behavior                                                                                                                                            | Assessment and reuse                                                                                                                                                                         |
| -- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Registration/login; auth pages, `src/auth.ts`, register/reset APIs | Name/email/password signup; bcrypt cost 12; credentials login, JWT sessions; durable limits; hashed expiring reset tokens; Resend welcome/reset mail        | Implemented; eight users persisted. No verified-email lifecycle/public author profile. Preserve auth; add explicit email verification, revocation and permissions when needed                |
| 2  | Dashboard; protected dashboard and `SubmissionList`, `AiBookJobs`  | Owner books, status badges, draft continuation, template/AI creation, order navigation, vault consent                                                       | Implemented. Live anonymous dashboard redirects to login. Preserve navigation and augment with listings/earnings/downloads, not separate disconnected applications                           |
| 3  | New book; `/create`, `submissions`, `from-template`, AI APIs       | New editor DRAFT with eight pages; start from template; legacy eight-image upload; autonomous AI option                                                     | Implemented; 42 non-template books. `/create` opens editor; legacy upload components/API remain. Keep all supported creation modes                                                           |
| 4  | Editing; EditorWorkspace/Canvas and page APIs                      | Scene-based text/images, design controls, fonts/crop/layers/history; page filmstrip and booklet preview; draft-only save with revision checking and locking | Implemented, substantial reuse target. Approved AI “open in editor” makes a separate draft; never relax the draft guard to implement versions                                                |
| 5  | PDF generation; RenderJob and `src/lib/pdf`                        | Freeze input, queue work, render print sheet plus reading PDF, validate geometry/checksums and atomically publish references                                | Implemented; 14 completed render jobs. No object-integrity sweep. Reuse artifacts/engine; formalize retention/version records                                                                |
| 6  | Submit for approval; submission submit/pdf APIs                    | Serialize save/submit, freeze revision, enqueue render; manual render transitions to PENDING for review                                                     | Implemented. Rendering precedes manual moderation. Reject/failure/retry states must remain visible                                                                                           |
| 7  | Administrator approval; AdminDashboard and admin submission API    | ADMIN approves/rejects rendered PENDING submissions with print key; AI QA has a distinct automatic approval path                                            | Implemented but approval means different things by origin. Commercial rights/listing approval must be a new gate                                                                             |
| 8  | Approved book management; SubmissionList/download APIs             | Owner can order or obtain signed print PDF; AI download endpoint supports dual artifacts; approved editing derives draft copy                               | Implemented; 14 approved non-template books, one historical print-only. No commercial version grouping, listing or customer entitlement                                                      |
| 9  | Order prints; OrderPanel and orders API                            | Authenticated buyer must own approved submission with print key; one book/order; server recomputes prices; pending order survives Stripe failure            | Implemented, one pending order persisted. Retain owner self-print route; marketplace orders need items, other authors and stronger settlement                                                |
| 10 | Quantity selection                                                 | Default 40; numeric selector, shortcut chips, suggestions, zone-specific caps and oversize quote path                                                       | Implemented. Source maximum 6,666 is not current configured maximum: stored 2 kg ladder permits 333 at 6 g/book                                                                              |
| 11 | Print costs                                                        | Shared pure HUF engine for tiers, handling, discount, shipping and optional vault; client preview plus debounced server quote                               | Implemented and reusable. Active database tiers differ from bootstrap defaults; do not silently reset prices                                                                                 |
| 12 | Destination/shipping                                               | Configured zone selector, per-zone normalized shipping bands, separate address country, manual quote contact                                                | Partial/problematic: server does not establish country-to-zone/carrier consistency. Reuse lookup and shipping primitives; authoritative country mapping is required                          |
| 13 | Currency                                                           | HUF/EUR/GBP display/conversion; local preference; server Stripe amount conversion                                                                           | Implemented but payment retry uses current rates; order stores HUF and currency without FX/foreign minor amount snapshot                                                                     |
| 14 | Stripe                                                             | Hosted Checkout, signed raw-body webhook, paid-status check, conditional paid transition, retries and alerts                                                | Implemented, not live-payment-verified. Missing full attempt/event/refund/dispute reconciliation and amount matching; local Stripe credentials absent, production configuration not verified |
| 15 | Order administration                                               | Admin list/detail, status transition allowlist, notes, paid timestamp, vault creation, reconciliation alerts                                                | Partial/problematic: admin update is not the webhook's atomic transition; separate vault side effect, no fulfillment item/shipment history or refunds                                        |
| 16 | Titchybook Vault                                                   | Optional 2-copy paid archive; entry snapshot; private by default; explicit consent allows public title/author/quantity/date listing                         | Implemented, no persisted entries at inspection. Not a paid digital library. Purchaser-author assumptions must change for marketplace; STORED is not a warehouse receipt                     |

## Detailed content lifecycle

### Manual/editor creation

1. Authenticated creation selects editor or template mode; a DRAFT and eight
   page records are created.
2. The editor loads the owner/admin-authorized book. Ordinary edits are allowed
   only while DRAFT.
3. Page persistence supplies revisions; shared submission locking coordinates
   save/submit. The UI maintains a local active-draft pointer and flushes
   pending changes before relevant navigation/preview operations.
4. Submit validates/finalizes scenes and freezes render inputs. Processing is
   queued, not necessarily completed in the request.
5. A render consumer claims a lease; stale claims cannot publish over a newer
   claim's result.
6. Successful manual rendering produces print/reading artifacts and places the
   submission in PENDING review. Failures surface through job/status endpoints.
7. ADMIN approves or rejects a rendered PENDING submission. Approval is bound to
   the existing rendered record, not permission to expose it publicly.
8. Approved owners can order prints/download; rejected users see rejection
   feedback. The generic “Re-upload” action currently links to the editor
   creation page.

The legacy upload path requires exactly eight unique allowed page labels,
user-owned upload key prefixes and HEAD checks for existence/size before
transactional creation/enqueue. Editor asset registration does not perform
equivalent complete object verification.

### Autonomous AI creation

1. Owner submits concept, optional template and an idempotency key; repeated
   identical key/payload returns the existing job, conflicting payload is
   rejected.
2. Stages are CONCEPT → CONTENT → COMPOSE → RENDER → QA. AI-ready published
   templates and content/layout contracts constrain generation.
3. Composition pins template scenes to the new book; render uses a frozen input
   snapshot.
4. Job claims, execution failures and content repairs have distinct counters and
   deadlines.
5. Technical QA can atomically mark the submission APPROVED and job COMPLETED,
   sometimes flagging a sample for admin review.
6. Download endpoints authorize owner/admin and approved state. These are not
   purchaser-download rights.
7. Editing an approved AI result calls duplicate-as-draft; scene/template
   metadata are copied but approved artifacts/QA/revision state are not reused
   as approval of the new draft.

Existing OpenAI generation and editor chat are part of the current product,
despite some AI-related SaaS features being future scope in the brief. Preserve
both. Do not turn existing AI approval into automatic marketplace publication.

### Templates and versioning today

Admin templates reuse Submission and TemplateElement, with published version,
managed seed identity, AI readiness/manifest and instance links. Ordinary
template instances and AI pinned scenes have different dependencies. A template
version counter is not an author's publication-version history.

Existing copy-as-draft is a useful mechanism for “create a new version,” but it
currently does not establish a shared commercial book identity. Repeated copy
actions may create multiple independent drafts. Historical similar titles must
not be auto-merged.

Retention hazards: generic DRAFT deletion can bypass the dedicated
linked-template check; deleting source assets can invalidate referenced scenes.
Deleting a parent template can NULL its FK and cascade its elements. These paths
need centralized policy before promising durable paid files and reproducible
editions.

## Existing print-purchase sequence

1. Owner opens OrderPanel for an APPROVED book with print key.
2. Client fetches authenticated pricing metadata; previous zone/currency
   preferences may come from localStorage.
3. Client computes a preview with shared pure primitives and requests an
   authoritative calculation after debounce.
4. Client submits quantity, zone, currency, address and vault choice, not
   trusted totals.
5. Server validates ownership/status and computes HUF totals from current
   configuration.
6. Server saves one PENDING_PAYMENT Order, including price components, address
   and configuration version.
7. If configured, Stripe creates a hosted session and the user is redirected;
   otherwise the pending order remains for payment retry.
8. Only a signed paid webhook or admin manual action changes payment state; the
   success redirect alone does not.
9. Admin advances production/shipping/delivery status. No separate production
   run or shipment event system is present.
10. A paid archive add-on creates VaultEntry; its public display remains opt-in.

Current order transitions:

```text
PENDING_PAYMENT -> PAID or CANCELLED
PAID -> IN_PRODUCTION or CANCELLED
IN_PRODUCTION -> SHIPPED or CANCELLED
SHIPPED -> DELIVERED
DELIVERED / CANCELLED -> terminal in the current allowlist
```

This mixes payment and fulfillment in one state. A cancellation is not evidence
that Stripe issued a refund. Mixed digital/physical items require separate
payment, entitlement and fulfillment state while preserving legacy status
behavior.

## Administration and supporting workflows

- **Pricing:** ADMIN edits validated PricingConfig; update increments a
  singleton version and clears the current process cache. Other processes can
  use cached configuration for up to 30 seconds. A read-time adapter supports
  the old shared-band schema. There is no historical configuration archive.
- **Payment alerts:** persisted dedupe/reopening, list/resolve APIs and admin
  display already provide an operator action channel. Reuse them beside, not
  instead of, financial records.
- **Queues:** ADMIN monitor and bearer-protected health expose jobs/drain
  history. Live 503 reported stale scheduler heartbeats despite no due work.
  GitHub reported a successful manual drain at 13:59:44–13:59:54 UTC; that does
  not prove subsequent scheduled delivery.
- **Contact:** public contact form and validation support shipping/manual
  quotation enquiries with rate limits and Resend. Reuse the intake UI patterns;
  a generic email contact is not a persisted sponsor campaign/quote.
- **Email:** welcome/reset/contact templates exist. Order confirmation, digital
  entitlement delivery, shipment updates and campaign notices require
  transactional notification records and templates.
- **Public homepage:** product positioning/examples are presentation, not proof
  of shop/sponsorship features.
- **Vault consent:** public queries filter STORED plus publicConsent; expose
  only limited snapshot fields. A buyer of another author's book must not gain
  authority to publish the author's identity/content.

## Existing capability → future capability map

| Preserve as foundation                                 | Extend at boundary                                                                                      | Genuinely new behavior                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Credentials, session provider, durable rate limits     | Verified customer identity, role/session revocation, organization memberships, explicit policy services | Public author and approved sponsor/outlet profiles               |
| Submission IDs, scenes, editor, template/AI generation | Root/version association, immutable approved-version/file references and retention                      | Public listing lifecycle, rights acceptance, categories/search   |
| Approved print artifacts and signed S3 helper          | File qualification and entitlement-gated signing                                                        | Paid digital library and license acceptance                      |
| Order header and history                               | Order items, payment attempts/events/refunds, fulfillment records                                       | Multi-book/mixed basket and other-author purchases               |
| HUF tier/weight/currency functions and pricing admin   | Versioned quotes/rates, supported-country mapping, retail/commission settings                           | Campaign quote breakdown and royalty policies                    |
| Stripe Checkout and signed webhook                     | One atomic idempotent settlement/reconciliation service across webhook/admin                            | Entitlement/royalty effects, partial refunds, disputes           |
| Admin dashboard, order moderation, payment alerts      | Item-level operational views, append-only audit events                                                  | Earnings, manual payouts, campaign/stock panels                  |
| Render queue, manifests, snapshot/fencing              | Distinct edition job target/profile without modifying original                                          | Eight extra campaign panels and separately approved campaign PDF |
| Private-by-default vault consent                       | Author-aware archive rights and actual receipt tracking                                                 | Distribution outlet allocations, stock events and QR engagement  |

## Not yet implemented

No source/schema implementation was found for public commercial listings,
publication license records, multi-item baskets/orders, paid-PDF entitlements,
royalties/payouts, sponsor/business membership workflows, campaign quotations,
independent sponsored editions, eight-position campaign inventory, charity
identity permissions, outlet stock allocations/replenishment or QR tracking.

Do not mistake published templates for shop listings, PaymentAlert for a ledger,
VaultEntry for a download entitlement, `parentBatchId` for implemented
distribution, or marketing text for an operational marketplace.

## Preservation and acceptance boundaries

After approval, regression evidence must cover all 16 journeys, including
existing accounts, private approved print-only books, draft autosave conflicts,
pinned-template behavior, AI copy-on-edit, legacy upload validation, old pricing
normalization, HUF Stripe scaling, order retry/history and vault privacy.

No current book should be recreated merely to list it. No existing private book
should become public on migration. No owner order should be silently repriced.
New sold versions must remain pinned when authors publish later editions. Scope
and sequencing are in the [roadmap](IMPLEMENTATION_ROADMAP.md); no
implementation has started.
