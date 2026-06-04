import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const where = { status: "STORED" };

  const [entries, total] = await Promise.all([
    prisma.vaultEntry.findMany({
      where,
      orderBy: { storedAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        title: true,
        authorName: true,
        quantity: true,
        storedAt: true,
      },
    }),
    prisma.vaultEntry.count({ where }),
  ]);

  return NextResponse.json({ entries, total, limit, offset });
}
