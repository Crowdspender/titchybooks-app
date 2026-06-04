import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@/lib/pricing/constants";
import { adminUpdateOrderSchema } from "@/lib/pricing/schema";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      submission: { select: { id: true, title: true, status: true } },
      user: { select: { id: true, email: true, name: true } },
    },
  });

  if (!order) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ order });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = adminUpdateOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      submission: { select: { id: true, title: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });
  if (!order) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Validate status transition (if a status change is requested).
  if (parsed.data.status && parsed.data.status !== order.status) {
    const allowed = ORDER_STATUS_TRANSITIONS[order.status as OrderStatus] ?? [];
    if (!allowed.includes(parsed.data.status)) {
      return NextResponse.json(
        {
          error: `Cannot transition from ${order.status} to ${parsed.data.status}`,
          allowed,
        },
        { status: 400 }
      );
    }
  }

  const updated = await prisma.order.update({
    where: { id },
    data: {
      status: parsed.data.status ?? undefined,
      notes: parsed.data.notes === undefined ? undefined : parsed.data.notes,
    },
  });

  // Auto-create VaultEntry when order transitions to PAID with vault add-on.
  if (
    parsed.data.status === "PAID" &&
    order.vaultAddOn &&
    order.submission
  ) {
    try {
      // Avoid duplicates: check if a vault entry already exists for this order.
      const existing = await prisma.vaultEntry.findFirst({
        where: { orderId: order.id },
      });
      if (!existing) {
        // Require explicit name for public vault listing; fall back to "Anonymous" to protect privacy.
        const authorName = order.user.name || "Anonymous";
        await prisma.vaultEntry.create({
          data: {
            orderId: order.id,
            submissionId: order.submissionId,
            title: order.submission.title || "Untitled",
            authorName,
            quantity: 2,
            status: "STORED",
          },
        });
      }
    } catch (error) {
      // Log error with context for recovery
      console.error(
        `[VaultEntry] Failed to create vault entry for order ${order.id}, submission ${order.submissionId}:`,
        error
      );
      // TODO: Enqueue admin alert for manual recovery
    }
  }

  return NextResponse.json({ order: updated });
}
