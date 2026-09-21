# Titchybooks Editor Reliability Sprint

## Scope and decisions
- Execute in this order: migration repair → lint/test foundations and CI → editor persistence → durable rendering → live feedback and final regression checks.
- Use the user-selected persistent Node.js worker with PostgreSQL as the queue; no Redis, managed task provider, or deployment changes.
- Retain Next.js 16, Prisma 5, the existing eight-page geometry, raster output by default, and opt-in vector output. Do not perform framework upgrades or redesign the editor.
- Preserve existing Vault, repowiki, and screenshot changes. Do not commit, push, deploy, seed the application database, or apply migrations to its current `DATABASE_URL`.
- Install and activate the selected `aj-geddes/useful-ai-prompts@integration-testing` guidance after approval. Installation failure must not block the sprint.

## Database and migration reproducibility
- Add forward-only migrations for the missing business-account fields and existing `RenderJob` model. Preserve the three existing migration files unchanged.
- Add a subsequent queue-hardening migration: nullable versioned JSON input snapshot for historical compatibility, next-attempt timestamp, lease-expiry timestamp, claim token, and queue-selection indexes.
- Add submission/page revision integers for optimistic save concurrency; existing records start at revision zero. Return revisions from draft load/save APIs.
- Validate migration replay and schema equivalence against a disposable PostgreSQL 16 database. Test registration-related fields and render-job persistence there.
- Do not disguise schema drift with broad `IF NOT EXISTS` statements. Application-database reconciliation requires a separately confirmed target and inspection before migration application.

## Lint, test tooling, and CI
- Fix the three known lint errors and resolve existing warnings. Correct hook dependencies and storage initialization; do not globally disable React hook rules. Use narrowly documented image-rule exceptions only where authenticated/proxied asset URLs require native images.
- Add Vitest, React Testing Library, jsdom, and Playwright as development dependencies. Preserve the current pricing tests.
- Add scripts for type checking, unit/component tests, PostgreSQL integration tests, Chromium browser tests, and worker execution. Use the existing `tsx` runtime for the worker, moving it to runtime dependencies.
- Add `.github/workflows/ci.yml` for pull requests and pushes: Node 22, `npm ci`, Prisma generation/validation, migration replay and drift check, lint, type checking, pricing/unit/integration tests, production build, and browser tests. Use a PostgreSQL service and upload browser traces on failure; do not require application secrets.
- Test runners require an explicit local `TEST_DATABASE_URL` naming a dedicated test database and refuse to fall back to `.env`. Fixture creation and cleanup remain confined to that database. External email/AI/storage calls are mocked in integration tests.

## Reliable eight-page persistence
Primary changes: `src/components/editor/EditorWorkspace.tsx`, submission metadata/page routes, and small extracted persistence/history modules.
- Replace separate overlapping saves with a coordinator that tracks title and all eight dirty pages, serializes writes per document part, coalesces newer edits, and ignores responses belonging to an old submission.
- Keep the current debounce behavior, but derive save status from the entire document. Add explicit retry feedback and retry on reconnect.
- Page navigation waits for the outgoing save and remains on the page if saving fails. Final submission freezes editing while it flushes the title and every dirty page; any failure prevents the submit request.
- Use revision-based conditional updates. A stale-tab write returns `409` and preserves local work instead of silently overwriting newer server content.
- Store recoverable scene/title edits locally under user-and-submission-scoped keys; never store credentials or signed asset URLs. Offer restore/discard on reopening, warn before unloading dirty work, handle storage errors, and clear acknowledged recovery data.
- Correct history snapshots so undo/redo round-trips the actual current document. Apply the same persistence rules to cross-page AI insertions and template text overrides. Preserve native undo inside text inputs.
- Separate initial thumbnail refresh from editor boot so hook fixes cannot recreate or reload drafts during editing. Limit thumbnail changes to preventing stale refreshes; broader print-preview fidelity work remains out of scope.

## Submission contract and immutable render input
Primary changes: submission create/submit/PDF routes, page/metadata/detach routes, and shared server-side validation.
- Serialize submission state changes using a PostgreSQL row lock. Save operations acquire the same lock before checking draft status and revisions, preventing a save from racing submission.
- Validate all eight unique labels, supported scene version/types, object/text limits, existing accessible assets, and existing DPI rules before enqueueing. Share the existing owner/admin/authorized-template asset access policy; do not reject legitimate template images.
- At submission, persist a versioned snapshot containing merged scenes, template text overrides, source-asset descriptors, and renderer selection. Subsequent template edits must not change queued output.
- Commit the snapshot, queued job, and submission `PROCESSING` status in one transaction. Return `202` only after persistence succeeds; repeated submission while processing returns the existing active job.
- Disallow editing/detaching an ordinary submission after it leaves `DRAFT`; retain existing template-editing behavior. Reject inappropriate resubmissions of reviewed content.
- Route legacy uploads through the same queue. Convert `POST /api/submissions/[id]/pdf` from inline generation to an ownership-checked retry of a failed submission, returning the existing active job when applicable. Keep draft submission on `/submit`.
- Retry creates a new bounded attempt cycle from the frozen input. Historical jobs without snapshots are validated and snapshotted once when explicitly retried or recovered; completed historical jobs remain unchanged.
- Admin moderation requires a generated PDF and `PENDING` status so it cannot race an active render.

## Persistent render worker
Primary changes: `src/lib/pdf/render-job.ts`, both PDF generators, S3 output-key helpers, and a new worker entry point.
- Claim due jobs atomically using PostgreSQL `FOR UPDATE SKIP LOCKED`; default to one active render per worker and a two-second idle poll. Multiple worker processes can safely share the queue.
- Use a unique claim token, a 120-second lease, and a 20-second heartbeat. Reclaim expired processing jobs after crashes.
- Allow three total attempts, with five- and thirty-second retry delays. Keep the submission processing while retries remain; mark both job and submission failed on exhaustion. Treat invalid immutable inputs as terminal errors.
- Separate rendering/uploading from submission status publication. Raster and vector generators consume the frozen input and return output descriptors rather than changing submission state.
- Write PDF and preview objects under job-and-attempt-specific S3 keys. Publish those keys and mark completion transactionally only while the claim token and lease remain current. An expired worker cannot overwrite a newer attempt's artifacts or database result.
- Missing source objects produce an explicit failed result, never a silently incomplete booklet. Keep legacy uploads on raster rendering even when vector mode is enabled.
- On shutdown, stop claiming jobs and allow the current job thirty seconds to finish; otherwise exit and let lease recovery handle it. Log job IDs, attempts, and state transitions without secrets. Add worker settings to `.env.example`; never edit `.env`.

## Live rendering feedback
Primary changes: render-status route, `SubmissionList`, and admin submission views.
- Return separate job and submission statuses, attempt counts, retry timing, and safe user-facing failure messages. Keep owner/admin checks and avoid exposing raw provider/database errors.
- Poll active jobs every two seconds, backing off to five seconds after thirty seconds. Pause while hidden/offline, resume on return, abort on unmount, and stop at terminal states.
- Show queued, rendering, retrying, awaiting review, and failed states using the current design system and accessible live announcements. Refresh list data on completion; never equate render completion with admin approval.
- Expose a retry action for failed submissions through the secured queue endpoint. Preserve existing approval-dependent user download/order controls.

## Acceptance tests and completion criteria
- **Migrations:** Fresh replay matches Prisma schema; business fields and queue tables work; existing pricing tests remain green.
- **Editor API:** Create eight-page draft, save unique content to every label, reload exactly, reject stale revisions and unauthorized asset/submission access, submit transactionally, and reject edits after submission.
- **Browser:** Against real Next.js APIs and test PostgreSQL, log in with a test fixture account, edit all eight pages using text/shapes, navigate, reload, and submit with the worker paused. Inject a failed save and verify navigation/submission does not discard work. Mock AI only for cross-page suggestion tests.
- **Persistence/history:** Fake timers and delayed responses cover coalescing, save failure/retry, old-response isolation, all-page flushing, local recovery, concurrent tabs, and undo/redo.
- **Worker:** Real PostgreSQL plus mocked storage verifies concurrent claims, duplicate enqueue, crash/lease recovery, delayed retries, exhaustion, legacy compatibility, frozen template input, and stale-attempt publication rejection. Exercise real raster rendering with in-memory assets and inspect PDF page dimensions.
- **Status UI:** Test polling cleanup, visibility/offline behavior, retry states, completion refresh, and the distinction between rendering and approval.
- Finish with clean lint, TypeScript, Prisma validation, passing tests, and a production build. Report every unrun check explicitly rather than treating CI configuration as a passing CI run.

## Environment and exclusions
- Docker CLI is installed, but the Docker engine is currently unavailable. Local database/browser integration execution requires Docker to be started; otherwise prepare the suites and report the local verification blocker. Do not silently substitute the application database.
- Live S3/email/AI validation, production worker hosting, application-database migration application, broad auth hardening, and full raster/vector visual parity remain separate follow-ups.