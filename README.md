# Titchybook

Titchybook is a web app for designing, generating and buying short printed
books. Users compose a book in a canvas-based page editor (or let the AI
pipeline write and lay one out end to end), an admin moderates the result, a
render worker produces the print-ready PDF, and the buyer downloads it from
their vault once the order is paid.

Built with Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind 4,
Prisma 5 + PostgreSQL, NextAuth v5, S3, Stripe Checkout, OpenAI and `pdf-lib`.

## Documentation

Read these before changing anything that touches queues, payments or deploys.

| Where | What it covers |
| --- | --- |
| [`docs/operations-runbook.md`](docs/operations-runbook.md) | The operational source of truth: health and alerting, payments and reconciliation, the AI book lifecycle, S3 configuration, backups and restore, the release-verification gate, the deploy checklist and the incident checklist. |
| [`docs/titchybook-editor-implementation-spec.md`](docs/titchybook-editor-implementation-spec.md) | The page-editor implementation spec. |
| [`.qoder/repowiki/en/content/`](.qoder/repowiki/en/content) | The generated architecture wiki. Start with `Project Overview.md` and `Getting Started.md`, then the per-subsystem trees (Architecture Overview, API Reference, Authentication & Authorization, Database Design, Deployment & Operations, PDF Generation Engine, Administrative Features, Component Library, Configuration & Environment, Image Upload System, User Dashboard). |
| [`.env.example`](.env.example) | Every environment variable, with the reason each one exists and the invariants between them. |

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from `.env.example` and fill in real values. `.env` is
   gitignored; never commit keys, and never put local-only values in
   `.env.example`.

   `DATABASE_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET` and the four AWS/S3
   variables are required: `assertProductionEnv()`
   ([`src/lib/env-validation.ts`](src/lib/env-validation.ts)) refuses to boot a
   production process without them. `OPENAI_API_KEY`, `RESEND_API_KEY` and the
   Stripe pair degrade to warnings instead — AI generation, transactional email
   and online checkout switch themselves off.

3. Apply migrations and seed:

   ```bash
   npx prisma migrate dev
   npx prisma db seed
   ```

   Seeding requires `ADMIN_PASSWORD` and fails without it, so an admin account
   is never created with a known password. It is idempotent: the admin, the
   pricing configuration and the three starter templates are matched by
   `ADMIN_EMAIL` / `managedKey`, so re-running never duplicates or overwrites
   them.

   The seed step is not optional for the AI pipeline. Book generation only
   picks templates that pass the shared preflight, and it fails terminally when
   no `APPROVED`, `aiReady` template exists — which is exactly what a
   migrated-but-unseeded database looks like.

4. Start the app:

   ```bash
   npm run dev
   ```

   Open <http://localhost:3000>.

5. The PDF render and AI book queues are drained by separate long-lived
   processes locally (on Vercel they are drained by secret-guarded routes on a
   cron — see the runbook):

   ```bash
   npm run worker:render
   npm run worker:ai
   ```

   Jobs sit in the queue until one of these is running.

## Testing

### The test database is required

`test:db:migrate`, `test:integration` and `test:browser` all read
`TEST_DATABASE_URL` and refuse to run without it. They never fall back to the
application `DATABASE_URL`, so there is no way to point a destructive test run
at real data by accident. The URL must be local (`127.0.0.1` or `localhost`)
and the database name must contain `test` — `scripts/test-environment.mts`
enforces both.

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

If you add a required environment variable, also add a test-only value to
`scripts/test-environment.mts`; otherwise the production-mode browser server
refuses to boot by design.

### Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint. CI runs `npx eslint --max-warnings 0`, so warnings are failures. |
| `npm test` | Unit tests (Vitest). |
| `npm run test:pricing` | The pricing engine's standalone assertions. |
| `npm run test:db:migrate` | Migrates the test database and fails on any schema/migration drift. |
| `npm run test:integration` | Integration tests against the test database — Stripe webhook and checkout retry, queue claim/retry/fencing, rate limiting, payment alerts. |
| `npm run test:browser` | Playwright against a production build on port 3100. |
| `npm run build` | `prisma generate && next build`. The route table must include `ƒ Proxy (Middleware)`. |
| `npm run audit:dependencies` | Production advisories at `low`, dev advisories at `critical`. |

Run the whole gate in the order given in
[Release verification](docs/operations-runbook.md#release-verification) before
tagging a release.
