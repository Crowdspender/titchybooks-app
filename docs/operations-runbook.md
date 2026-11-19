# Operations runbook

Production topology: the Next.js app on Vercel, PostgreSQL on Neon, object
storage on S3, and GitHub Actions driving the queue drain. This runbook covers
the current operational surfaces. It is not a production-readiness certificate.
Local Batch 7 work is approved; staging/provider acceptance, production writes,
shipping-tariff activation, refunds, and a physical pilot need separate approval.

## Health and alerting

| Surface                 | Auth                                 | Healthy                                 | Unhealthy                             |
| ----------------------- | ------------------------------------ | --------------------------------------- | ------------------------------------- |
| `GET /api/health`       | none                                 | `200` with `checks.database = "up"`     | `503` with `checks.database = "down"` |
| `GET /api/queue/health` | `Authorization: Bearer $CRON_SECRET` | `200`                                   | `503` with `reasons[]`                |
| `/admin/queue`          | ADMIN session                        | queue cards, failed jobs, drain history | red banner with reasons               |
| `/admin/orders`         | ADMIN session                        | order table                             | amber "Payment reconciliation" banner |

- Point an external uptime monitor at `/api/health` (1-minute interval). Alert
  on any non-200 response or timeout.
- `.github/workflows/drain.yml` checks `/api/queue/health` after every drain. A
  failing step triggers GitHub Actions notifications. The endpoint returns `503`
  for `drain-never-ran`, `drain-stalled`, `last-run-error`, or `due-backlog`.
- Thresholds default to 15 minutes without a drain and 30 minutes of runnable
  backlog. Override with `QUEUE_STALE_DRAIN_MS` and `QUEUE_BACKLOG_ALERT_MS`
  (minimum 60 seconds).
- `/admin/queue` shows the 20 most recent failed AI and render jobs with their
  error messages and attempt counts. Failed jobs have already exhausted their
  automatic retries; fix the root cause before asking the user to resubmit.
  Render jobs owned by a `FAILED` submission can be retried from the editor.

## Payments and reconciliation

Checkout runs through Stripe. Signed webhook deliveries and the explicit admin
reconciliation action read canonical provider state before atomic settlement.
A signature or `checkout=success` return URL is not proof of the accepted charge.
`STRIPE_WEBHOOK_SECRET` must match the endpoint in the correct Stripe account/mode.

| Surface | Auth | Purpose |
| --- | --- | --- |
| `POST /api/orders/:id/pay` | owner or ADMIN | Recover/reuse a durable attempt for a pending order; never reprice the accepted quote. |
| `POST /api/stripe/webhook` | signature | Persist minimized unique deliveries, then reconcile Checkout/payment/refund/dispute state. |
| `GET /api/admin/orders/:id/payment` | current ADMIN | Read retained attempts, events and payment projection without provider calls. |
| `POST /api/admin/orders/:id/payment` | current ADMIN | `RECONCILE` reads canonical Stripe state; `RELEASE_HOLD` requires current fingerprint, 10–1000-character explanation and confirmation. |
| `GET /api/admin/payment-alerts` | current ADMIN | Open historical/settlement alerts and retained event review issues. |
| `PATCH /api/admin/payment-alerts/:id` | current ADMIN | Dismiss an alert only; does not settle, refund or release an order hold. |

- A `PaymentAttempt` is committed before provider issuance, with frozen amount,
  currency, request and deterministic idempotency. On an ambiguous provider
  response, retry/reconcile that attempt; never create an untracked replacement.
  If the attempt cannot be safely recovered, use the manual-review path.
- The signature-verified event is durably recorded before provider reads.
  Unsupported events are `IGNORED`; unknown references remain `UNMATCHED`.
  Mismatches/overpayment stay visible as `REVIEW`. Transient reconciliation
  failures return non-2xx for Stripe retry and retain failure evidence.
- All known attempts participate, including valid earlier sessions. A superseded
  or metadata-only reference is not unconditional permission to settle.
  Amount/currency/account/mode and provider identities must agree. Duplicate or
  late events never reset fulfillment or create a second Vault entry.
- Settlement and Vault creation share a transaction. A Vault-write failure rolls
  back database settlement; provider success remains recoverable. After any
  uncertain commit, read fresh order/history/Vault state before retrying. Repair
  the cause, then reconcile or retry an evidenced manual settlement; do not
  invent a payment or silently mark the order paid.
- `stale-session` and `unpaid-completion` alerts may reflect historical handler
  outcomes, not current canonical truth. Reconcile and check Stripe history before
  deciding on fulfillment or a refund. `vault-entry-failed` also requires a fresh
  read because settlement may have rolled back. Alerts deduplicate recurrences;
  dismissal is not suppression of future issues.
- Refund initiation remains in Stripe Dashboard with separate authorization.
  Reconcile partial/full/pending/failed refunds and dispute outcomes afterward.
  Cancellation is not a refund. Review a held unstarted order before production;
  preserve already shipped orders and physical Vault copies.
- A payment-created `STORED` Vault row is an entitlement/record, not physical
  receipt evidence. Catalog visibility requires separate owner `publicConsent`.
  Record actual receipt, storage and withdrawal through the agreed operator
  procedure; never infer these from payment or a checkout return URL.

## AI book lifecycle

An AI book is one `AiBookJob` row: `CONCEPT → CONTENT → COMPOSE → RENDER → QA`.
Customers never see those stages; they see a phase derived once in
`src/lib/ai/job-status.ts` (`queued`, `generating`, `repairing`,
`waiting-for-render`, `reviewing`, `needs-review`, `completed`, `failed`).

| Endpoint                                              | Purpose                                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/ai/books`                                  | Start a job. `requestKey` makes a retry idempotent (`200` duplicate, `202` new, `409` key reused for different text, `429` inside the 10 s spacing window). |
| `GET /api/ai/books`                                   | The caller's 20 most recent jobs, including ones with no draft yet.                                                                                         |
| `GET /api/ai/books/:id`                               | Typed phase, attempts, repair budget, queue signal and artifact flags. `qaReport` is returned to admins only.                                               |
| `GET /api/ai/books/:id/downloads?kind=print\|reading` | Streams the same authorized print/reading attachment service as submission downloads. Requires owner/admin and an `APPROVED` submission. |

- A book counts as finished only when the submission is `APPROVED` **and** both
  `pdfS3Key` and `readingPdfS3Key` exist. Print-only submissions from before the
  dual-artifact profile stay readable; the reading PDF is reported unavailable
  rather than substituted. Missing/unavailable artifact responses are explicit;
  verify the requested kind and status, not merely the existence of a PDF key.
- `FAILED` at stage `QA` is a `needs-review` outcome, not a transient failure:
  the repair budget is spent, the draft is left `PENDING` for moderation, and
  resubmitting the same prompt would be rejected again.
- Ownership and approval are enforced inside every read: the list endpoint
  filters by `userId`, and job detail, render status and downloads all reject
  foreign or anonymous callers instead of filtering after the fact.
- Bounds are per job, not per queue: `AI_BOOK_MAX_REPAIRS` content-repair
  cycles, `AI_BOOK_LIFETIME_MS` total lifetime from first claim, and
  `AI_MAX_ACTIVE_JOBS` concurrent jobs per user. Generation switches are
  `AI_TEXT_BOOKS_ENABLED` (on) and `AI_ILLUSTRATED_BOOKS_ENABLED` (off until the
  illustrated release gate passes).
- An AI template is offered for autonomous use only when it passes the shared
  preflight (`src/lib/ai/template-readiness.ts`). Publishing stays manual-only:
  the admin publish action returns the issues, sets `aiReady = false`, and the
  template remains usable for hand-edited books. Publish with
  `{ "requireAiReady": true }` to make an incomplete template a `422` instead.

## S3 bucket configuration

The app uploads directly from the browser with presigned PUTs, so the bucket
must have CORS. The following configurator commands are operator instructions,
not authorization to change a bucket. Inspect the proposal first; apply only
with separate approval and a bucket-administration identity (not the app's
runtime key, which should stay object-scoped):

```bash
# Prints the full configuration without calling AWS.
npm run s3:configure

# Applies it (idempotent).
npm run s3:configure -- --apply
```

The script sets:

- all four public-access blocks on, ACLs disabled (`BucketOwnerEnforced`);
- SSE-S3 (`AES256`) default encryption and versioning;
- CORS for `CORS_ALLOWED_ORIGINS` (comma-separated origins, no paths) with
  `GET`, `PUT`, `HEAD` and exposed `ETag`;
- lifecycle: abort incomplete multipart uploads after 7 days, expire `backups/`
  after 35 days, expire noncurrent versions after 30 days;
- a bucket policy that denies every request made over plain HTTP.

User assets (`uploads/`, `assets/`, `renders/`, `previews/`) are deliberately
never expired: `renders/` contains the published PDF and page previews that
submissions and orders reference.

## Database backups and restore

Two independent layers:

1. **Neon point-in-time restore (primary).** Confirm the retention window in the
   Neon console (project settings). Before any destructive migration, note the
   current timestamp so a branch can be restored to it.
2. **Nightly logical dump (secondary).** `.github/workflows/backup.yml` runs at
   02:30 UTC, writes a custom-format `pg_dump`, verifies it with
   `pg_restore
   --list`, and keeps it as a 30-day workflow artifact. It
   requires the `DATABASE_URL` repository secret. To copy dumps off GitHub as
   well, set the `BACKUP_S3_BUCKET` and `AWS_REGION` repository variables
   (matching the destination bucket) plus the `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` secrets. The lifecycle rule on the app bucket expires
   copies under `backups/` after 35 days; add an equivalent rule if the backup
   bucket is a different one.

A successful `pg_restore --list` proves archive readability, not restorability.
Logical dumps do not contain S3 objects or cluster roles. The workflow's
`--no-owner --no-privileges` deliberately omits ownership/ACL restoration; real
provider-managed identity permissions need an approved, provider-specific drill.
Preserve all schemas, including `neon_auth`; do not treat its objects as app
NextAuth tables or remove them because Prisma does not declare them.

Local disposable rehearsal (no remote credentials/providers):

```powershell
# Set TEST_DATABASE_URL to the approved local test DB first; never DATABASE_URL.
node node_modules/tsx/dist/cli.mjs scripts/test-db.ts restore
```

This command accepts only the designated loopback PG16 port 55432 or PG17 port
55433/container. It creates uniquely named SOURCE and RESTORED scratch databases,
uses dump/restore clients matching the selected server major (16 or 17),
migrates/seeds only SOURCE, restores into empty RESTORED with
`--exit-on-error --single-transaction`, compares complete
row hashes and schema/catalog definitions, exercises restored financial guards,
and removes only databases it created. The selected base DB is hashed before
and after; it is never migrated, seeded or restored over. Do not run other
DB suites concurrently. Evidence is under `test-results/batch7-restore-pg16`
or `batch7-restore-pg17`. Synthetic in-memory retained-image/PDF recovery and
corruption checks are labeled local models, not real S3 or printing evidence.
The initial `INCOMPLETE` evidence and console output record planned scratch
names. Normal error cleanup attempts every acknowledged owned name, retains
failures for investigation, and still closes the base connection. Forced process
termination, Ctrl+C, machine shutdown or an uncertain CREATE response can leave
scratch resources; no signal-safe cleanup guarantee is made. Compare the exact
run's planned names with a read-only audit before requesting local cleanup.
If cleanup fails, investigate the exact reported owned scratch name; do not
force-drop arbitrary databases, terminate other connections or widen the target.
The PG17 drill tests the nightly workflow's current client format; PG16 tests
the CI server major separately. A PG17 archive is not a supported PG16 downgrade:
its restore setup can require `transaction_timeout`, which PG16 does not have.
Do not filter restore SQL or ignore errors to claim downgrade compatibility.

For an approved real recovery, retain a fresh pre-incident backup and create a
new isolated Neon PITR branch or empty restore target. Do not use `--clean`
against an existing database. Quiesce separately approved consumers/writes,
verify every schema and retained history (IDs, scenes/pins, approved artifacts,
quotes/FX/attempts/events, orders, Vault consent), then reconcile provider changes
since the restore point before any cutover. Recover referenced private S3 keys
from the approved retained version/copy; verify byte lengths, SHA-256 manifests,
image decoding and both PDF geometries. Never overwrite approved masters merely
to repair a download or infer a historical reading PDF that did not exist.

Inspect restored template inventory without reseeding automatically: seeding can
create an admin/default tariff and update managed templates. Any migration,
reseeding, provider-schema action, deployment or cutover requires separate
approval and a preservation comparison. A dump is not a financial rollback:
Stripe charges/refunds and physical shipments remain external facts.

## Release verification

Run the CI gate locally before tagging a release:

0. Start an isolated test database and point `TEST_DATABASE_URL` at it in
   `.env`. Steps 3, 5 and 7 refuse to run without it, and they never fall back
   to the application `DATABASE_URL`. The URL must be local
   (`127.0.0.1`/`localhost`) and the database name must contain `test`:

   ```bash
   docker run -d --name titchybook-test -p 127.0.0.1:55432:5432 \
     -e POSTGRES_USER=titchybook_test \
     -e POSTGRES_PASSWORD=local_test_only \
     -e POSTGRES_DB=titchybook_test \
     postgres:16
   ```

   ```bash
   # .env (never .env.example, which is committed)
   TEST_DATABASE_URL="postgresql://titchybook_test:local_test_only@127.0.0.1:55432/titchybook_test"
   ```

1. `npm ci` to install exactly the audited lockfile.
2. `npm run audit:dependencies`. The first half (`--omit=dev
   --audit-level=low`) must report zero findings: anything reachable from
   production code fails the build. The second half fails on *critical*
   development findings. Fresh audit output determines advisory counts/chains;
   old snapshots are not current evidence. Do not use a blanket `npm audit fix`,
   which can pull major versions; review dependency changes separately. Running
   an advisory check contacts the registry and needs the applicable access approval.

   Production advisories can be published at any time and will turn CI red on
   this step before a single test runs, so re-run it locally rather than
   assuming the last green run still holds.
3. `npm run test:db:migrate` (local test target only; deploy plus schema diff).
4. `node node_modules/eslint/bin/eslint.js . --max-warnings=0`;
   `npm run typecheck`. Direct ESLint avoids npm argument-forwarding differences.
5. Run serially per database: `npm run test:pricing`; `npm test`;
   `npm run test:integration`. Repeat DB suites on PostgreSQL 16 and 17.
6. `node node_modules/tsx/dist/cli.mjs scripts/test-db.ts build`; the isolated
   production build must include `ƒ Proxy (Middleware)`. Do not substitute an
   ordinary build that inherits developer application/provider credentials.
7. `npm run test:browser` (isolated production-mode server, port 3100);
   `npm run test:design` separately. Capture saved PDF bytes/checksums/parser and
   actual desktop/mobile browser screenshots, not only successful requests.
8. Run the disposable restore command above on both approved local DB targets.
   Preserve executed output and evidence; recheck cleanup and schema drift with
   `node node_modules/tsx/dist/cli.mjs scripts/test-db.ts schema-audit`. This
   validates the schema, migration status and Prisma-managed public-schema diff
   without deploying migrations. It is not an all-schema/role/PITR audit.

The matching-client restore drill is deliberately local-only: it requires the
explicitly designated Windows development containers/loopback ports. CI's
independent ephemeral PG16 service runs integration migration-preservation and
service-journey tests plus schema audit, but does not execute that drill or certify
PG17 restore. Retain both local PG16/17 restore reports for release review.

For fixture recovery, first explicitly re-establish the approved local
`TEST_DATABASE_URL`, then run:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/test-db.ts payment-evidence audit
```

This is a read-only snapshot of synthetic users, product counts, limiter counts
and matching scratch names. Match remaining users to the exact seed output;
use `payment-evidence cleanup <adminId> <customerId>` only for the two evidenced
identities, or `cleanup-interrupted <exactId...>` for an evidenced partial seed.
Identity/target guard failures are failures, not proof of cleanup. If users are
already absent, verify product records and stop; do not widen deletion. Registry
cleanup removes exact process-owned user/email/IP limiter keys. Older/shared
limiter buckets survive; inspect provenance before any cleanup and never clear
all buckets merely to produce an empty audit.

All harness entry points sanitize inherited credentials and block Node remote
egress, including server children. Browser route interception alone cannot
isolate server-side SDK calls. Never run ordinary application worker commands
with developer `DATABASE_URL` for a local test. Add explicit test-only values to
`scripts/test-environment.mts` for new required variables; do not copy provider
secrets into fixtures. Request runtimes report configuration problems; workers
refuse invalid production configuration, and weak session secrets fail startup.

### Local Batch 7 evidence — not release approval

The local uncommitted worktree was verified on November 18, 2026. No production
migration, deployment, provider operation, tariff activation, payment/refund,
dependency installation, commit or push was performed. No new product schema
was added in Batch 7. Earlier batch migrations remain subject to production
preflights and separate approval. The immutable stabilization plan was not edited.

| Executed command (through the sanitized harness) | Result and boundary |
| --- | --- |
| `scripts/test-db.ts unit` | 645 tests / 35 files passed, including 16 restore-safety cases. |
| `scripts/test-db.ts pricing` | 40 passed; synthetic/local pricing, not tariff approval. |
| `scripts/test-db.ts integration` on PG16 and PG17 | 342 tests / 24 files passed on each target, including the composite journey and migration preservation. |
| `scripts/test-db.ts restore` on PG16 and PG17 | Matching-client full logical restore, 397 catalog entries, row/sequence hashes, restored guards, local retained bytes, scratch cleanup and base preservation passed. |
| Direct strict ESLint; `npm run typecheck`; `git diff --check` | Passed; the line-ending warning for the existing asset presign file is not a test failure. |
| `scripts/test-db.ts build` | Isolated production build passed with `Proxy (Middleware)`. |
| `scripts/test-db.ts browser` | Final post-build full run: 66 passed in 6.5 minutes, including current fixture cleanup. The separate eight-test auth rerun also passed. |
| `scripts/test-db.ts design` | Unchanged full retry: 17 passed. Earlier initial navigation timed out with a blank page; no timeout/test suppression was applied. |
| `scripts/test-db.ts schema-audit` on PG16 and PG17 | Valid schema, 19 migrations up to date, no Prisma-managed diff. Not provider-schema/ACL certification. |

All `scripts/test-db.ts` entries above are invoked as
`node node_modules/tsx/dist/cli.mjs scripts/test-db.ts <action>` with an explicitly
re-established local `TEST_DATABASE_URL` for DB actions. The revised fulfillment
matrix exposes all 36 status pairs as individual cases instead of placing them
under one 30-second test deadline; no transition assertion was removed. The
previous PG17 full run timed out in that combined case. The current complete
PG16/17 reruns passed all cases. First signed-event insert concurrency uncovered
a Prisma empty-update upsert race; recovery reads the committed winner only for
P2002 and still rejects a changed immutable digest. Six simultaneous first
deliveries and the composite's three deliveries passed without duplicate goods.

| Spec requirement | Authoritative local executed coverage; outstanding boundary |
| --- | --- |
| C1 retained sources | `asset-safety`, `editor-queue`, composite journey: scenes/pins/jobs and concurrent reference/removal protections; real S3 recovery open. |
| C2 canceled rejection | `submission-moderation` unit/browser and editor integration: zero request on cancel, bounded reasons, duplicate/race/error handling. |
| C3 safe resume | `dashboard-recovery`, persistence and editor browser: transient/not-found distinction, recovery pointers, reload/conflict/inline navigation. |
| F1 destinations | `pricing-offer`, `orders-quote`, order-quote browser: country/postcode/service/exclusion rules; business/carrier approval open. |
| F2 frozen retry | `orders-quote`, payment attempts and composite: original FX/amount/terms despite current pricing changes; real Stripe acceptance open. |
| F3 canonical payment | `payment-provider`, `payment-reconciliation`, composite: exact references/amount/currency/mode, first-delivery races, refund/dispute holds and recovery; real provider events open. |
| F4 atomic settlement | `order-settlement`, payment reconciliation and migration suites: locks, rollback/retry, legal transitions and one private Vault entry. |
| F5 private image caching | `asset-safety`: owner/admin authorization and private/no-store response assertions; real bucket/CDN permissions open. |
| F6 validated finalization | `asset-upload`, `asset-safety`, composite: actual decoded format/bytes/dimensions, corrupt/animated/oversize bounds, canonical retained key; real S3 acceptance open. |
| F7 template dependency guards | `asset-safety`, `template-pin-detach`: identical deletion protections and retained pinned/materialized content. |
| F8 matching accepted quote | `order-quote-ui`, `orders-quote`, order-quote browser: stale/failed/out-of-order offers, durable idempotency/storage ambiguity, explicit acceptance and exact charge. |
| F9 authentication | Auth/reset/role/email unit, integration and real-Next browser: registration/login/logout, reset reuse/concurrency, current-role downgrade, minimized logs and escaped accented names; actual email delivery open. |
| I1 truthful downloads | PDF unit/integration/design/browser: native saved bytes, checksums/parser, missing/interrupted/error paths; no disk-save success claim. Original remote symptom and common-reader/physical acceptance remain unverified. |
| I2 compatible PDF actions | Shared print/reading download service, AI delegation and historical print-only cases passed; no replacement historical reading PDF. |
| I3 generation operations | Worker-process/editor-queue/AI/queue-health and restore tests: persisted claim/fences/retry/publication/local recovery passed; fresh deployment/scheduler/backlog/real storage acceptance open. |
| I4 correction | Submission duplicate and moderation/editor browser plus composite: exact scenes, separate new correction, retained original review/artifacts; template pins covered separately. |
| I5 admin states | Moderation, payment UI and queue-monitor unit/browser: loading/error/retry, actual render state, no false approval/settlement/receipt success. |
| Coherent existing-product UX | Editor/navigation/undo/recovery/mobile browser, quote/payment/Vault UI, design geometry: saved/dirty/offline/conflict states, accepted foreign charge plus HUF, persisted payment, separate consent/receipt wording, first-user guidance. |
| Preservation | Migration and restore fixtures retain original IDs/scenes/pins/PDFs, legacy unknown facts, frozen quotes/FX, payments/orders/Vault consent and synthetic `neon_auth`; no preservation claim for an untouched production dataset or provider roles. |

Latest composite reports and saved PDFs:
[PG16 journey](../test-results/batch7-journey-pg16/evidence.json),
[PG17 journey](../test-results/batch7-journey-pg17/evidence.json),
[PG16 restore](../test-results/batch7-restore-pg16/evidence.json),
[PG17 restore](../test-results/batch7-restore-pg17/evidence.json).
The journeys verify native Chromium disk-saved print/reading bytes against the
manifest and parser: one 297×210 mm print page and eight 74×105 mm reading pages.
The accepted EUR 32.60 is recovered with the same durable attempt after ambiguity,
then canonically confirmed, disputed/won, shipped and partially/fully refunded
without erasing fulfillment or duplicating Vault. Auth sessions, email and
S3/Stripe transports are mocked in that composite; it is not a same-book full
NextAuth/real-provider browser journey.

Independent local browser-use inspected the EUR 27.40 / EUR 10.00 partial-refund
order, private Vault receipt caveat, editor title save/reload and admin payment
history. [Editor screenshot](../test-results/batch7-editor-desktop.png) and
[admin history screenshot](../test-results/batch7-admin-orders-payment-history.png)
were inspected. That browser could not resize to the requested mobile viewport
or operate the native rejection prompt; do not claim independent cancellation
or mobile proof from it. Automated browser tests provide those scoped assertions.

Final local read-only audits after the full browser and integration/restore runs
found zero users/product/history/assets/jobs/pricing/drain records and no matching
scratch databases on both targets. PG16 retained two limiter buckets and PG17
one; their ownership was not established and they were not blanket-deleted. The
historical exact-ID cleanup attempt failed its identity guard; both-target audits
established the old identities were already absent. A new PG17 seed/exact-two-ID
cleanup succeeded and its audit found no remaining product fixtures. The isolated
browser server stopped after its suite; no ongoing preview availability is claimed.

CI now runs direct strict ESLint and post-integration schema audit and retains
`test-results/`, including journey evidence. This workflow change was not executed
on GitHub. No fresh registry dependency-advisory or external deployment/provider
check was run; historical advisory counts and queue/tariff observations are not
current acceptance evidence. Local passes leave every gate below open.

### External acceptance and pilot gate

Green local/CI tests are necessary, not release or pilot approval. Retain a
requirement-by-requirement record with actual executed evidence and clearly
unverified items. Still required before a limited manual pilot:

- Exact deployed SHA/schema compatibility and fresh scheduled drain/backlog/
  alert evidence, with controlled queued AI/render consumption and failure recovery.
- Separately approved isolated staging with dedicated private S3 bucket/prefix,
  Stripe test account, controlled email recipients and any approved AI smoke.
  Complete same-book registration/create/edit/upload/save/resume/generate/
  reject-correct-resubmit/approve/download/quote/test-checkout-retry/confirmed
  payment/admin fulfillment/refund-dispute/Vault-consent journey, with separate
  author and administrator identities. Mocks do not prove provider acceptance.
- Real private S3 upload/finalization/read/retained-object restore; Neon PITR and
  provider-owned `neon_auth`/permission preservation; approved recovery/cutover
  and reconciliation procedures demonstrated on isolated targets.
- Chrome plus Edge/Adobe Reader opening/print-dialog checks; actual-size A4
  landscape printing/folding; clipping, font/accents, image quality and page
  order evidence. Printer/carrier approval for the existing booklet and packaging.
- Business-approved country/service/postcode exclusions, packaging/Vault-copy
  weight assumptions, unchanged or separately approved tariffs, refund/
  fulfillment handling and tax/invoice obligations. No automatic tariff reset.
- Named accountable operational owner, finance/refund approver and physical
  Vault operator, with backup/alert/reconciliation coverage. Names must be
  supplied by the business; they are not inferred from repository accounts.

Local Batch 7 approval authorizes none of those external actions. Record each
approval, owner and evidence reference before enabling commercial checkout or
announcing a pilot; missing or indirect evidence leaves the gate open.

## Deploy checklist

This section is a checklist for a separately approved deployment, not permission
to perform one. Inspect the exact migration set and compatibility before choosing
a cutover sequence. The drain scheduler needs fresh heartbeat/consumption evidence;
a row left by an old deployment is insufficient.

### Before deploying

1. Confirm CI is green on the exact commit being deployed.
   `.github/workflows/ci.yml` runs the whole gate (dependency audit, migrate,
   lint, typecheck, unit, integration, build, browser) against an ephemeral
   Postgres service. Green CI proves only its executed isolated coverage and
   does not certify providers, real restore, printing or business acceptance.
   It needs no repository secrets.
2. Ask production what it is actually missing, rather than trusting a count from
   a plan or a PR description — migrations are added between releases:

   ```bash
   npx prisma migrate status   # against the production DATABASE_URL
   ```

   Whatever it lists as not yet applied is exactly what `migrate deploy` will
   run in step 6.

   `migrate status` only reports the migrations table, not all catalog drift or
   provider-owned objects. Historical audit counts are not current-state proof.
   Inspect pending SQL and all schemas read-only, including provider-managed
   `neon_auth`. **Never run `prisma db push` against production**: undeclared
   objects are not disposable. Do not remove or rewrite provider tables, schemas
   or permissions as part of this stabilization.
3. Capture a restore point.
   `20261110100000_drop_deprecated_user_business_columns` is destructive and has
   no down migration, so before this release set:

   - note the current Neon timestamp so a point-in-time branch can be created at
     it, and
   - run `.github/workflows/backup.yml` manually (`workflow_dispatch`) and wait
     for the verified dump artifact.

   Even additive migrations need uniqueness/data preflights and rehearsed
   preservation. Duplicate Vault/order/provider identifiers require an approved
   remediation decision, not deletion. Confirm backup freshness/restorability
   and the acceptable recovery window; do not assume a nightly dump is sufficient.
4. Confirm every Vercel environment variable is present and non-placeholder.
   [`src/lib/env-validation.ts`](../src/lib/env-validation.ts) reports runtime
   problems through request instrumentation. `assertProductionEnv()` throws
   for invalid production workers; the request server serves with reported
   feature failures except for the independently fatal weak-session-secret guard:

   - Required: `DATABASE_URL`, an effective strong `AUTH_SECRET`/`NEXTAUTH_SECRET`
     (or configured rotation list), `CRON_SECRET`, `AWS_REGION`,
     `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`.
   - Optional features need approved valid credentials: `OPENAI_API_KEY` (AI),
     `RESEND_API_KEY` (email), `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` (payments).
     Missing values are reported; do not assume both payment paths share one gate.
   - Online shipping additionally requires approved `ORDER_SHIPPING_POLICY_JSON`.
     An absent/unsupported policy uses manual quotes. Never use the synthetic test
     policy in production or activate coverage without business approval.
   - Queue timings are validated against each other, not merely for presence:
     `AI_BOOK_LEASE_MS` must exceed `DRAIN_BUDGET_MS` and be at least twice
     `AI_HEARTBEAT_MS`, and `DRAIN_BUDGET_MS` must stay under the drain routes'
     60s `maxDuration`. Boot is refused otherwise, because the failure mode is a
     live drainer being evicted mid-budget and its job double-claimed.

   `CORS_ALLOWED_ORIGINS` must list every production origin; re-run
   `npm run s3:configure -- --apply` if any of them changed.
5. Confirm the GitHub repository secrets and variables the workflows need:

   | Workflow     | Required                                      | Optional                                                                                           |
   | ------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
   | `drain.yml`  | `PROD_URL` (no trailing slash), `CRON_SECRET` | —                                                                                                  |
   | `backup.yml` | `DATABASE_URL`                                | `BACKUP_S3_BUCKET` + `AWS_REGION` variables, `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` secrets |

   `CRON_SECRET` must be byte-identical to the Vercel value: the drain routes
   fail closed with `401` on a mismatch, which stops both queues silently. Note
   that `PROD_URL` is a GitHub secret only and must **not** be added to Vercel.

### Deploying and verifying

6. Apply migrations explicitly: `npx prisma migrate deploy` against the
   production `DATABASE_URL`. (`npm run build` only regenerates the client.)
7. Verify approved AI-ready template inventory before enabling autonomous AI.
   If absent, choose an explicitly approved publication or reseed action.
   `npx prisma db seed` is a write: it may create an admin/default pricing and
   update managed templates. Snapshot pricing/pins/history first; preserve
   current tariffs and admin-authored templates. Do not seed automatically
   during deployment or restore merely to make an inventory check green.
8. Confirm the AI template inventory is non-empty before announcing the feature:

   ```bash
   psql "$DATABASE_URL" -c 'SELECT count(*) AS ai_ready_templates FROM "Submission" \
     WHERE "isTemplate" = true AND "aiReady" = true AND status = '\''APPROVED'\'';'
   ```

   A count of `0` blocks autonomous AI acceptance. Obtain approval to publish
   an AI-ready template or reseed, rather than modifying restored history silently.
9. For approved payment activation, verify the endpoint/account/test-or-live mode
   and matching signing secret. Subscribe to required Checkout completion,
   expiration, async success/failure; payment-intent success/processing/failure/
   cancellation; charge/refund updates; and charge-dispute lifecycle events.
   Current code reconciles `checkout.session.*`, `payment_intent.*`, `charge.*`
   (including `charge.dispute.*`) and `refund.*`; a two-event subscription does
   not cover refunds, disputes or delayed payments. Demonstrate actual test-mode
   delivery/replay/reconciliation before activation. Canonical reconciliation
   repairs missing deliveries without issuing new payments or refunds.
10. Verify `GET /api/health` returns `200` after deploy, then trigger
    `drain.yml` manually once so `/api/queue/health` has a drain heartbeat. Also
    confirm a logged-out `GET /dashboard` returns `307` to
    `/login?callbackUrl=...`; page protection depends on the `Proxy` entry in
    the build.
11. Check `/admin/queue` after the first scheduled drain, and `/admin/orders` to
    confirm the payment reconciliation banner is empty.
12. Point an external uptime monitor at `/api/health` on a 1-minute interval and
    alert on any non-200. Nothing else in this stack notifies you that the app
    itself is down: `drain.yml` only reports queue health, and only every five
    minutes.

## Incident checklist

- **App 5xx / health 503:** check Neon status and connection limits, then Vercel
  function logs. `/api/health` distinguishes database reachability from
  application errors.
- **Queue unhealthy:** read `reasons[]` from `/api/queue/health`; if
  `drain-stalled`, check the latest `drain.yml` runs and the Vercel
  `CRON_SECRET`; if `due-backlog`, inspect `/admin/queue` for failed or
  long-running jobs.
- **Failed job:** reproduce with the stored `errorMessage` and stage. AI jobs
  persist stage output, so a retry resumes from the last completed stage.
- **Payment review/banner:** inspect retained event outcomes and canonical
  history. Reconcile before fulfillment; dismissal alone changes no payment or
  hold. Authorize refunds separately in Stripe Dashboard and reconcile afterward.
- **Reported payment but pending order:** investigate exact account/mode,
  delivery logs, amount/reference mismatches and transient DB/provider failures.
  Use admin reconciliation or approved replay; never mark paid solely on a
  return URL or issue a new Checkout to repair an unknown paid attempt.
- **Accidental deletion/bad migration:** retain incident evidence and a fresh
  backup; obtain approval for isolated PITR/restore verification and cutover.
  Reconcile external Stripe and physical fulfillment after the restore point.
  Reverting code cannot undo destructive SQL or external payments; preserve
  the old compatible application artifact and never invent a down migration.
