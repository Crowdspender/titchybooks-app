# AI-Prompt-to-Finished-Book Roadmap

> Restored. The previous copy of this file was truncated on disk
> mid-milestone-table (2,101 bytes, ending at
> `| P0 | M1 — Correct resumability and ide`). This version is rewritten from
> the shipped code rather than recovered from the fragment, and records Release
> A as delivered.

## Target and scope

- **Phased delivery:** complete text-only books first (Release A); AI
  illustrations and automatic controlled-layout selection second (Release B).
- **Two outputs:** one A4-landscape foldable print sheet and one eight-page
  reading-order PDF.
- **Serverless production topology:** Next.js on Vercel. The long-lived
  `worker:ai` / `worker:render` processes cannot run there, so the queues are
  drained by `CRON_SECRET`-guarded routes (`/api/ai/drain`, `/api/render/drain`)
  driven every 5 minutes by `.github/workflows/drain.yml`. PostgreSQL remains
  the durable queue. The standalone workers remain supported for non-serverless
  hosts.

A finished book means one authenticated prompt — with no required uploads,
template selection, editing, or payment — produces coherent cover / interior /
back-cover content, passes quality checks, and exposes both downloadable PDFs.
Physical ordering remains a separate optional workflow.

The format remains eight pages: `FRONT_COVER`, `PAGE_2`–`PAGE_7`, `BACK_COVER`.
Longer books, arbitrary model-generated geometry, and commercial PDF/X
certification are out of scope for both releases.

**Effort scale:** Small = localized changes; Medium = several modules and tests;
Large = cross-cutting behavior, migrations, or substantial qualification. These
are relative effort, not calendar commitments.

## Output contract (frozen for Release A)

`src/lib/pdf/print-profile.ts` is the single source of truth:

| Property               | Value                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Profile id             | `titchybook-single-sheet-rgb-v2` (version 2)                                                                       |
| Print sheet            | 297 × 210 mm, A4 landscape, folded, geometry from `PANELS`                                                         |
| Reading page           | 74 × 105 mm, eight pages                                                                                           |
| Reading order          | explicit `READING_ORDER` constant — never derived from panel order, database order, or element serialization order |
| Color / renderer       | RGB, raster, 300 DPI                                                                                               |
| Minimum body size      | 8 pt (`MIN_BODY_POINT_SIZE`)                                                                                       |
| Auto-approve DPI floor | 200 effective DPI (`MIN_EFFECTIVE_DPI`)                                                                            |
| Required outputs       | `["print-sheet", "reading-pdf"]`                                                                                   |
| Allowed fonts          | `AI_SUPPORTED_FONT_FAMILIES`; an unsupported family is rejected, never silently substituted                        |

The profile identity is persisted into render snapshots, so
`isCurrentPrintProfile()` keeps historical jobs reproducible instead of silently
re-qualifying them. Commercial printing needs a **separately proofed profile**,
not an edit to this one.

## Release A — delivered

| Milestone                                      | Effort | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Reproducible baseline and output contract | Small  | ✅ Done | `scripts/test-environment.mts` refuses a non-local or non-`test` database and never falls back to the application `DATABASE_URL`; `print-profile.ts`, `book-contract.ts`, `artifacts.ts`                                                                                                                                                                               |
| M1 — Resumability and idempotency              | Medium | ✅ Done | `AiBookJob.requestKey` + `payloadDigest` under a unique `(userId, requestKey)` index: `200` duplicate, `202` new, `409` key reused for different text, `429` inside the spacing window. `stageOutput` persists per stage so a retry resumes from the last completed stage                                                                                              |
| M2 — Bounded, fenced execution                 | Medium | ✅ Done | `attempts` (claim telemetry) is separated from `failureCount`/`maxAttempts` (execution budget) and `repairCount`/`maxRepairs` (content budget); `deadlineAt` caps lifetime from first claim; `claimToken` + `leaseExpiresAt` fence a stale worker out of advancing or approving                                                                                        |
| M3 — Dual artifacts                            | Medium | ✅ Done | `Submission.pdfS3Key` + `readingPdfS3Key` + `artifactManifest` (checksums and profile identity). A book is finished only when the submission is `APPROVED` **and** both keys exist. Print-only historical submissions report the reading PDF unavailable (`409`, `readingPdfAvailable: false`) rather than substituting the print sheet                                |
| M4 — Template readiness and pinning            | Medium | ✅ Done | One definition of AI-ready in `template-readiness.ts`, called by publication, the admin list, explicit selection and automatic selection, so a template cannot be published AI-ready and rejected at generation time. `Submission.pinnedTemplate` freezes the scenes at compose time: editing or unpublishing the source cannot change an existing book                |
| M5 — QA and repair                             | Medium | ✅ Done | `CONCEPT → CONTENT → COMPOSE → RENDER → QA`. QA rejection spends the repair budget and rewrites only the failing pages. Exhaustion is a terminal `needs-review` outcome (the draft stays `PENDING` for moderation), not a retryable failure — regenerating the same prompt would be rejected again. `AI_QA_SAMPLE_RATE` flags auto-approved books for admin spot-check |
| M6 — Customer-visible state                    | Small  | ✅ Done | `job-status.ts` derives the phase once (`queued`, `generating`, `repairing`, `waiting-for-render`, `reviewing`, `needs-review`, `completed`, `failed`) so the status API, creation page and dashboard cannot disagree. The five internal stages are never exposed                                                                                                      |
| M7 — Recovery and operations                   | Medium | ✅ Done | `/api/health`, `/api/queue/health` (503 with `reasons[]` for `drain-never-ran`, `drain-stalled`, `last-run-error`, `due-backlog`), `/admin/queue` with `QueueDrainRun` heartbeats, `drain.yml` failing on 503, nightly verified `pg_dump`, S3 bucket hardening, and `assertProductionEnv()` refusing to boot on missing or placeholder secrets                         |

**Release A gate:** `AI_TEXT_BOOKS_ENABLED=true`.

### Deploy dependency (easy to miss)

Autonomous generation only offers templates that pass the shared preflight, and
a job enqueued with no AI-ready template **fails terminally at `CONCEPT`**. The
three starter recipes (`story`, `guide`, `promo`) exist only via
`prisma/seed-templates.ts`, matched by `Submission.managedKey`. A fresh or
restored database therefore requires `npx prisma db seed` after `migrate deploy`
— see the deploy checklist in `docs/operations-runbook.md`. Admin-authored
templates have a `NULL` `managedKey` and are never touched by re-seeding.

## Release B — illustrated books (not started)

**Gate:** `AI_ILLUSTRATED_BOOKS_ENABLED=false`. Keep it off until every exit
criterion below is met. The manual editor flow is the fallback throughout.

Exit criteria:

1. **Image generation provider and cost ceiling.** A chosen provider, a per-book
   image budget, and a hard cap on regeneration attempts. Illustration
   multiplies both latency and cost per job, so the budget must be enforced per
   job the same way `AI_BOOK_MAX_REPAIRS` and `AI_BOOK_LIFETIME_MS` are today —
   not per queue.
2. **Layout selection contract.** Automatic controlled-layout selection must be
   expressed as data the preflight can validate, not as model discretion. Extend
   `template-contract.ts` with image-slot geometry (placement box, aspect ratio,
   minimum effective DPI at the placed size) so `template-preflight.ts` can
   reject a template whose artwork slots cannot be filled safely.
3. **Moderation policy for generated art.** Text moderation already exists in
   QA; generated imagery needs its own policy, a rejection path, and a decision
   on whether a moderation rejection is retryable with a revised prompt or
   terminal. Assume terminal until proven otherwise, matching the text
   behaviour.
4. **QA beyond text.** `qa.ts` currently verifies text, layout and the PDFs.
   Illustrated books additionally need: artwork present in every required slot,
   effective DPI at the placed size ≥ `MIN_EFFECTIVE_DPI`, no artwork crossing
   the trim boundary, and no visible seam between artwork and background colour.
5. **Print-profile impact.** Confirm the RGB single-sheet profile still holds at
   300 DPI with full-page artwork (file size and raster memory), or introduce a
   new versioned profile id. Do not mutate `titchybook-single-sheet-rgb-v2`: the
   persisted identity exists so old jobs stay reproducible.
6. **Pinning parity.** Generated artwork must be captured in `pinnedTemplate`
   (or an equivalent frozen reference) so a regenerated or removed source image
   cannot alter a book that already exists.
7. **Repair semantics.** Decide whether a QA failure on artwork repairs the
   image, the layout, or both, and give it its own budget rather than sharing
   `maxRepairs` with text.

## Deferred / explicitly out of scope

- Books longer than eight pages, or arbitrary model-generated page geometry.
- Commercial PDF/X certification and printer-approved profiles.
- Replacing the raster path with direct vector PDF rendering for AI books. A
  vector renderer exists for the editor flow (`generate-vector.ts`, behind
  `VECTOR_RENDER`), but the AI profile is `renderer: "raster"` by design.
- Physical fulfilment automation; ordering stays a separate optional workflow.

## Verification baseline

Recorded after the working tree was committed and the full local gate was run
against an isolated Dockerized Postgres 16:

| Gate                       | Result                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc --noEmit`             | pass                                                                                                                                                |
| `eslint --max-warnings 0`  | pass                                                                                                                                                |
| `vitest run` (unit)        | 15 files / 103 tests pass                                                                                                                           |
| `npm run test:db:migrate`  | 15 migrations applied, `prisma migrate diff` reports no drift                                                                                       |
| `npm run test:integration` | 11 files / 78 tests pass                                                                                                                            |
| `npm run test:browser`     | 3 specs / 10 tests pass; the eight-page editor regression needed an explicit `aria-current` wait because a page switch awaits the outgoing autosave |
| `npm run build`            | pass, route table contains `ƒ Proxy (Middleware)`                                                                                                   |

These are baselines, not acceptance of future changes. Live services, the
deployed template inventory, and physical printed output remain unverified.
