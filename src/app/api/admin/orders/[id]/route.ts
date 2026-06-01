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

  const order = await prisma.order.findUnique({ where: { id } });
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

  return NextResponse.json({ order: updated });
}
