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
2. `npm run audit:dependencies` (production findings fail; the only accepted
   finding is the dev-only `braces` chain pulled in by the ESLint plugin).
3. `npx prisma validate && npm run test:db:migrate`.
4. `npx eslint --max-warnings 0 && npm run typecheck`.
5. `npm run test:pricing && npm test && npm run test:integration`.
6. `npm run build`; the route table must include `ƒ Proxy (Middleware)`.
7. `npm run test:browser` (starts the production build on port 3100).

If a new required environment variable is added, add a test-only value to
`scripts/test-environment.mts`; otherwise the production-mode browser server
refuses to boot by design.

## Deploy checklist

1. Apply migrations explicitly: `npx prisma migrate deploy` against the
   production `DATABASE_URL`. (`npm run build` only regenerates the client.)
2. Seed the managed starter templates: `npx prisma db seed`. **This is
   required, not optional**: autonomous AI book generation only offers
   templates that pass the shared preflight, and a job enqueued with no
   `aiReady` template available fails terminally at `CONCEPT` with
   `This template is not AI-ready yet`. Seeding is idempotent — recipes are
   matched by `Submission.managedKey`, so re-running updates the three
   seed-owned templates and never touches an admin-authored one (whose
   `managedKey` is `NULL`).
3. Confirm the AI template inventory is non-empty before announcing the
   feature:

   ```bash
   psql "$DATABASE_URL" -c 'SELECT count(*) AS ai_ready_templates FROM "Submission" \
     WHERE "isTemplate" = true AND "aiReady" = true AND status = '\''APPROVED'\'';'
   ```

   A count of `0` means every AI book request will fail. Publish a template
   from `/admin/templates` or re-run the seed.
4. Ensure `CRON_SECRET` is identical in Vercel and in the GitHub repository
   secrets used by `drain.yml`.
5. Confirm `CORS_ALLOWED_ORIGINS` includes every production origin and re-run
   the S3 configurator if the origin changed.
6. Verify `GET /api/health` returns `200` after deploy, then trigger `drain.yml`
   manually once so `/api/queue/health` has a drain heartbeat. Also confirm a
   logged-out `GET /dashboard` returns `307` to `/login?callbackUrl=...`; page
   protection depends on the `Proxy` entry in the build.
7. Check `/admin/queue` after the first scheduled drain.

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
- **Accidental deletion or bad migration:** create a Neon branch at the
  pre-incident timestamp, validate it, then promote; restore the nightly dump
  only if PITR is outside its window.
