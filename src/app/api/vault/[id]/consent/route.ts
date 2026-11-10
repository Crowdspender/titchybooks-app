import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const consentSchema = z.object({ consent: z.boolean() });

// PATCH /api/vault/[id]/consent - the entry's owner opts their book in to
// (or out of) the public /vault directory. Entries default to private; this
// route is the only way they become public.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = consentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "consent (boolean) is required" }, { status: 400 });
  }

  const entry = await prisma.vaultEntry.findUnique({
    where: { id },
    include: { order: { select: { userId: true } } },
  });
  if (!entry) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (entry.order.userId !== session.user.id && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const updated = await prisma.vaultEntry.update({
    where: { id },
    data: { publicConsent: parsed.data.consent },
    select: { id: true, publicConsent: true },
  });
  return NextResponse.json(updated);
}
