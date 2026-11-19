import type { Order, Prisma } from "@prisma/client";
import { ORDER_STATUS_TRANSITIONS } from "@/lib/pricing/constants";
import { adminUpdateOrderSchema, type AdminUpdateOrderInput } from "@/lib/pricing/schema";

/** All callers supply a transaction. Lock order first, then create/upsert Vault. */
export type OrderLifecycleCommand =
  | { source: "stripe" }
  | { source: "admin"; operatorId: string; update: AdminUpdateOrderInput };

export type OrderLifecycleResult =
  | { ok: true; order: Order; settled: boolean }
  | { ok: false; reason: "not-found" | "bad-state" | "conflict" | "payment-review"; status?: Order["status"] };

const SETTLED_STATUSES: Order["status"][] = ["PAID", "IN_PRODUCTION", "SHIPPED", "DELIVERED"];

/** Settlement, notes, and fulfillment transitions share the same row lock.
 * No provider network calls belong in this transaction. Any Vault error escapes
 * to the caller and rolls back the order update; webhook retry can recover it.
 */
export async function applyOrderLifecycle(
  tx: Prisma.TransactionClient,
  orderId: string,
  command: OrderLifecycleCommand,
): Promise<OrderLifecycleResult> {
  // Validate even internal admin callers; operator identity never comes from the body.
  const update = command.source === "admin" ? adminUpdateOrderSchema.parse(command.update) : null;
  if (command.source === "admin" && !command.operatorId.trim()) throw new Error("Missing operator identity");
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  const current = await tx.order.findUnique({ where: { id: orderId } });
  if (!current) return { ok: false, reason: "not-found" };
  if (update?.expectedUpdatedAt && current.updatedAt.toISOString() !== update.expectedUpdatedAt) {
    return { ok: false, reason: "conflict", status: current.status };
  }

  const requested = command.source === "stripe" ? "PAID" : update?.status;
  if (command.source === "stripe") {
    if (current.status !== "PENDING_PAYMENT" && !SETTLED_STATUSES.includes(current.status)) {
      return { ok: false, reason: "bad-state", status: current.status };
    }
  } else if (requested && requested !== current.status && !ORDER_STATUS_TRANSITIONS[current.status].includes(requested)) {
    return { ok: false, reason: "bad-state", status: current.status };
  }

  if (current.paymentHold && ((requested === "PAID" && current.status === "PENDING_PAYMENT") ||
      (current.status === "PAID" && requested === "IN_PRODUCTION"))) {
    return { ok: false, reason: "payment-review", status: current.status };
  }
  const settling = requested === "PAID" && current.status === "PENDING_PAYMENT";
  const data: Prisma.OrderUpdateInput = {};
  if (settling) {
    data.status = "PAID";
    data.paidAt = current.paidAt ?? new Date();
    if (command.source === "admin" && update?.manualSettlement) {
      data.manualSettlement = {
        source: "manual", operatorId: command.operatorId, recordedAt: new Date().toISOString(),
        ...update.manualSettlement,
      };
      data.paymentState = "MANUAL_PAID";
      data.paymentRevision = { increment: 1 };
    }
  } else if (command.source === "admin" && requested && requested !== current.status) {
    data.status = requested;
  }
  if (update?.notes !== undefined && update.notes !== current.notes) data.notes = update.notes;
  // Millisecond timestamps must still advance for two fast serialized writes.
  if (Object.keys(data).length) data.updatedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
  const order = Object.keys(data).length
    ? await tx.order.update({ where: { id: orderId }, data }) : current;

  // Late Stripe deliveries never reset fulfillment or fabricate legacy paidAt.
  // Existing Vault rows (including withdrawn rows and consent) are untouched.
  if (SETTLED_STATUSES.includes(order.status) && order.vaultAddOn) {
    await ensureVaultEntry(tx, order);
  }
  return { ok: true, order, settled: settling };
}

async function ensureVaultEntry(tx: Prisma.TransactionClient, order: Order): Promise<void> {
  const [submission, user] = await Promise.all([
    tx.submission.findUniqueOrThrow({ where: { id: order.submissionId }, select: { title: true } }),
    tx.user.findUniqueOrThrow({ where: { id: order.userId }, select: { name: true } }),
  ]);
  await tx.vaultEntry.upsert({
    where: { orderId: order.id },
    update: {},
    create: {
      orderId: order.id, submissionId: order.submissionId,
      title: submission.title || "Untitled", authorName: user.name || "Anonymous",
      quantity: 2, status: "STORED", publicConsent: false,
    },
  });
}
