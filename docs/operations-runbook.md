# Operations runbook

Production topology: the Next.js app on Vercel, PostgreSQL on Neon, object
storage on S3, and GitHub Actions driving the queue drain. This runbook covers
the operational surfaces added for production readiness.

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

Checkout runs through Stripe. `/api/stripe/webhook` is the only path that marks
an order `PAID` automatically, and its authenticity comes solely from the
signature, so `STRIPE_WEBHOOK_SECRET` must match the dashboard endpoint.

| Surface                               | Auth           | Purpose                                                                                                                                                                                                |
| ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/orders/:id/pay`            | owner or ADMIN | (Re)issue a Checkout session for a `PENDING_PAYMENT` order; the returned session id replaces the stored one. Capped at 30 attempts per user per hour. Returns `503` when `STRIPE_SECRET_KEY` is unset. |
| `POST /api/stripe/webhook`            | signature      | Applies `checkout.session.completed`. Idempotent across retried deliveries.                                                                                                                            |
| `GET /api/admin/payment-alerts`       | ADMIN          | Open reconciliation alerts.                                                                                                                                                                            |
| `PATCH /api/admin/payment-alerts/:id` | ADMIN          | Dismiss one alert. Dismissing does not change the order.                                                                                                                                               |

The webhook deliberately does not fail on ambiguous events, because a non-2xx
makes Stripe retry a delivery that can never succeed. Each of those decisions is
recorded as a `PaymentAlert` row and listed in the banner on `/admin/orders`:

| Kind                 | Meaning                                                                                                                                          | Action                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stale-session`      | The buyer paid on a Checkout session that a later retry had superseded. The payment is signature-verified, so the order was still marked `PAID`. | Check the Stripe dashboard for more than one charge on the order. Refund the duplicate if there is one, then dismiss.                                       |
| `unpaid-completion`  | Checkout completed without payment (an expired or declined card), so the order was left `PENDING_PAYMENT`.                                       | Contact the buyer, or cancel the order, then dismiss.                                                                                                       |
| `vault-entry-failed` | An admin marked the order `PAID` but the vault copy could not be created. The buyer has paid for storage that does not exist.                    | Fix the cause, then save `PAID` again from `/admin/orders`: the vault side-effect is idempotent and re-runs on an order that is already paid. Then dismiss. |

Alerts are counted rather than duplicated: a retried delivery increments
`occurrences` on the existing row. A dismissed alert reopens if the same
condition happens again, so dismissing is never permanent suppression. The
`console.warn` lines are still emitted for log-based alerting, but on Vercel the
banner is the surface an operator will actually see.

A paid order missing its vault entry can also be repaired by re-delivering the
original event from the Stripe dashboard: the webhook re-runs vault creation on
an `already-paid` transition.

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
| `GET /api/ai/books/:id/downloads?kind=print\|reading` | Re-signs a download per click. Requires the owner (or an admin) and an `APPROVED` submission.                                                               |

- A book counts as finished only when the submission is `APPROVED` **and** both
  `pdfS3Key` and `readingPdfS3Key` exist. Print-only submissions from before the
  dual-artifact profile stay readable; the reading PDF is reported unavailable
  (`409`, `readingPdfAvailable: false`) rather than substituted.
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
must have CORS. Run the configurator from an operator machine with a
bucket-administration identity (not the app's runtime key, which should stay
object-scoped):

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

Restore drill (run quarterly against a scratch database, never production):

```bash
# Fetch the artifact from the workflow run, then:
createdb titchybook_restore
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname=titchybook_restore titchybook.dump
psql titchybook_restore -c 'SELECT count(*) FROM "User";'
```

For a Neon PITR recovery, create a branch at the target timestamp, point a
staging deployment at it, verify the data, then promote it during a maintenance
window. Do not restore directly over the production branch without first
capturing a fresh backup.

After any restore, re-check the managed templates. Restoring to a timestamp
before `20261024120000_add_template_managed_key` (or before the seed first ran)
leaves the database with no `aiReady` template, so re-run `npx prisma db seed`
against the restored branch and repeat the inventory query from the deploy
checklist before promoting it.

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
   production code fails the build. The second half only fails on *critical*
   dev findings, so a residue of dev-only moderates is accepted - currently 9,
   in the `vitest` / `@vitest/mocker` and `@typescript-eslint` → `minimatch`
   chains. Do not clear that residue with a blanket `npm audit fix`, which can
   pull a major version of a test tool; bump the offending dev dependency
   deliberately instead.

   Production advisories can be published at any time and will turn CI red on
   this step before a single test runs, so re-run it locally rather than
   assuming the last green run still holds.
3. `npx prisma validate && npm run test:db:migrate`.
4. `npx eslint --max-warnings 0 && npm run typecheck`.
5. `npm run test:pricing && npm test && npm run test:integration`.
6. `npm run build`; the route table must include `ƒ Proxy (Middleware)`.
7. `npm run test:browser` (starts the production build on port 3100).

If a new required environment variable is added, add a test-only value to
`scripts/test-environment.mts`; otherwise the production-mode browser server
refuses to boot by design.

## Deploy checklist

Order matters. Migrations run before the new code serves traffic, the seed runs
before any AI job is enqueued, and the drain scheduler needs a heartbeat before
the queue-health checks mean anything.

### Before deploying

1. Confirm CI is green on the exact commit being deployed.
   `.github/workflows/ci.yml` runs the whole gate (dependency audit, migrate,
   lint, typecheck, unit, integration, build, browser) against an ephemeral
   Postgres service, so a green run is the evidence that this release candidate
   works. It needs no repository secrets.
2. Ask production what it is actually missing, rather than trusting a count from
   a plan or a PR description — migrations are added between releases:

   ```bash
   npx prisma migrate status   # against the production DATABASE_URL
   ```

   Whatever it lists as not yet applied is exactly what `migrate deploy` will
   run in step 6.

   Note that `migrate status` only reports on the migrations table. Production
   also carries tables that no migration created and `prisma/schema.prisma`
   does not declare - a lowercase set (`user`, `account`, `session`,
   `verification`, `organization`, `member`, `invitation`, `jwks`,
   `project_config`) left over from an earlier authentication schema. As of
   2026-11-10 all of them are empty except `project_config` (1 row). They are
   inert: `migrate deploy` only executes pending SQL files and will not touch
   them. **Never run `prisma db push` against production** - it reconciles the
   database to the schema and would propose dropping them. Removing them is a
   separate, deliberate migration once someone has confirmed nothing external
   still reads them.
3. Capture a restore point.
   `20261110100000_drop_deprecated_user_business_columns` is destructive and has
   no down migration, so before this release set:

   - note the current Neon timestamp so a point-in-time branch can be created at
     it, and
   - run `.github/workflows/backup.yml` manually (`workflow_dispatch`) and wait
     for the verified dump artifact.

   For a release whose migrations are all additive, the most recent nightly dump
   is sufficient.
4. Confirm every Vercel environment variable is present and non-placeholder.
   `assertProductionEnv()`
   ([`src/lib/env-validation.ts`](../src/lib/env-validation.ts)) throws at boot
   in production, so a bad value fails the deploy loudly instead of degrading
   weeks later:

   - Required: `DATABASE_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `AWS_REGION`,
     `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`.
   - Optional, warn and self-disable: `OPENAI_API_KEY` (AI generation),
     `RESEND_API_KEY` (transactional email), `STRIPE_SECRET_KEY` /
     `STRIPE_WEBHOOK_SECRET` (online checkout).
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
7. Seed the managed starter templates: `npx prisma db seed`. **This is required,
   not optional**: autonomous AI book generation only offers templates that pass
   the shared preflight, and a job enqueued with no `aiReady` template available
   fails terminally at `CONCEPT` with `This template is not AI-ready yet`.
   Seeding is idempotent — recipes are matched by `Submission.managedKey`, so
   re-running updates the three seed-owned templates and never touches an
   admin-authored one (whose `managedKey` is `NULL`).
8. Confirm the AI template inventory is non-empty before announcing the feature:

   ```bash
   psql "$DATABASE_URL" -c 'SELECT count(*) AS ai_ready_templates FROM "Submission" \
     WHERE "isTemplate" = true AND "aiReady" = true AND status = '\''APPROVED'\'';'
   ```

   A count of `0` means every AI book request will fail. Publish a template from
   `/admin/templates` or re-run the seed.
9. If online checkout is enabled, confirm the Stripe dashboard has a webhook
   endpoint for `https://<production-origin>/api/stripe/webhook` subscribed to
   `checkout.session.completed` and `checkout.session.expired`, and that
   `STRIPE_WEBHOOK_SECRET` is that endpoint's signing secret. A missing or
   mismatched endpoint fails silently: buyers are still charged, but every order
   stays `PENDING_PAYMENT` and vault entries are never created.
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
- **Payment reconciliation banner on `/admin/orders`:** every entry is a payment
  that was handled without failing, so money and fulfilment may disagree. Work
  the action column in
  [Payments and reconciliation](#payments-and-reconciliation), then dismiss.
- **Orders stuck in `PENDING_PAYMENT` after buyers report paying:** the webhook
  is not reaching the app or its secret does not match. Check the endpoint's
  delivery log in the Stripe dashboard, then re-deliver the event; the handler
  is idempotent, so a repeat is safe.
- **Accidental deletion or bad migration:** create a Neon branch at the
  pre-incident timestamp, validate it, then promote; restore the nightly dump
  only if PITR is outside its window.
