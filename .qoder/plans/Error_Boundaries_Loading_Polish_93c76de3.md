# Error Boundaries, Loading States, and Primary Color Fix

## Task 1: Darken primary color for WCAG AA contrast

**File:** `src/app/globals.css`

Change `--color-primary` from `#27c7f9` (1.9:1 contrast with white) to `#0891b2` (cyan-600, ~4.6:1 with white -- passes AA). Also update `--color-primary-hover` to `#0e7490` (cyan-700) and adjust the light/muted variants to stay harmonious.

## Task 2: Create shared loading skeleton component

**New file:** `src/components/ui/LoadingSkeleton.tsx`

A reusable set of skeleton primitives used by `loading.tsx` files:
- `SkeletonCard` -- pulsing card placeholder
- `SkeletonList` -- renders N skeleton cards in a stack (for list pages)
- `SkeletonPageHeader` -- pulsing header block (section-label + h1 + subtitle)

## Task 3: Add `loading.tsx` to server-rendered routes

Each file exports a default component that renders skeleton UI matching the page layout:

| File | Skeleton shape |
|---|---|
| `src/app/(protected)/dashboard/loading.tsx` | PageHeader + toolbar row + 3 card skeletons |
| `src/app/(protected)/dashboard/orders/loading.tsx` | PageHeader + 4 card skeletons (order rows) |
| `src/app/(protected)/dashboard/orders/[id]/loading.tsx` | PageHeader + 2-column detail cards |
| `src/app/(protected)/dashboard/orders/new/loading.tsx` | PageHeader + large card skeleton |
| `src/app/vault/loading.tsx` | PageHeader + 6-card grid skeletons |
| `src/app/(admin)/admin/loading.tsx` | 3 stat card skeletons |
| `src/app/(admin)/admin/orders/loading.tsx` | PageHeader + 3 card skeletons |
| `src/app/(admin)/admin/pricing/loading.tsx` | PageHeader + form skeleton card |
| `src/app/(admin)/admin/templates/loading.tsx` | PageHeader + 3 card skeletons |

## Task 4: Add `error.tsx` to route groups

Each `error.tsx` is a client component that catches render/async errors and shows a friendly recovery UI with a "Try again" button (calling `reset()`).

| File | Scope |
|---|---|
| `src/app/(protected)/dashboard/error.tsx` | Covers dashboard + orders routes |
| `src/app/(admin)/admin/error.tsx` | Covers all admin routes |
| `src/app/vault/error.tsx` | Covers vault route |

Each shows: icon, "Something went wrong" heading, fixed user-safe copy (never the raw `error.message`, which can leak internals), and a "Try again" button. Diagnostic details stay out of the rendered UI — they are confined to secured server-side logging/monitoring (Next.js surfaces the error `digest` for correlation).

## Task 5: Add `not-found.tsx` custom 404 page

**File:** `src/app/not-found.tsx`

A styled 404 page matching the app's design system: centered card with a book icon, "Page not found" heading, description, and a "Go to dashboard" link.

## Task 6: Add `global-error.tsx` root error boundary

**File:** `src/app/global-error.tsx`

A minimal root-level error boundary that replaces the entire HTML (as required by Next.js). Shows a simple centered message with a "Try again" button. This catches catastrophic failures that escape route-level boundaries.

## Task 7: Verify build passes

Run `npx next build` to confirm no type errors or build issues from the new files.
