import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Shared order state transitions, used by both the Stripe webhook and the
 * admin manual "mark PAID" path so the vault side-effect can never drift
 * between them.
 */

export type OrderDb = PrismaClient | Prisma.TransactionClient;

export interface PaidTransitionResult {
  ok: boolean;
  /** "already-paid" is a successful no-op (webhook retries land here). */
  reason?: "not-found" | "bad-state" | "already-paid";
}

/**
 * Atomically move PENDING_PAYMENT -> PAID. Concurrent callers are safe:
 * the conditional updateMany lets exactly one winner transition the row.
 */
export async function transitionOrderToPaid(
  db: OrderDb,
  orderId: string,
): Promise<PaidTransitionResult> {
  const updated = await db.order.updateMany({
    where: { id: orderId, status: "PENDING_PAYMENT" },
    data: { status: "PAID", paidAt: new Date() },
  });
  if (updated.count === 1) return { ok: true };

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  });
  if (!order) return { ok: false, reason: "not-found" };
  return {
    ok: false,
    reason: order.status === "PAID" ? "already-paid" : "bad-state",
  };
}

/**
 * Idempotently create the vault entry for a PAID order with the vault
 * add-on. Never throws for orders without the add-on or when an entry
 * already exists.
 */
export async function createVaultEntryForOrder(
  db: OrderDb,
  orderId: string,
): Promise<boolean> {
  const existing = await db.vaultEntry.findFirst({
    where: { orderId },
    select: { id: true },
  });
  if (existing) return false;

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      submission: { select: { title: true } },
      user: { select: { name: true } },
    },
  });
  if (!order || !order.vaultAddOn || !order.submission) return false;

  await db.vaultEntry.create({
    data: {
      orderId: order.id,
      submissionId: order.submissionId,
      title: order.submission.title || "Untitled",
      // Fall back to "Anonymous" to protect privacy in the public directory.
      authorName: order.user.name || "Anonymous",
      quantity: 2,
      status: "STORED",
    },
  });
  return true;
}
