import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadPricingConfig, savePricingConfig } from "@/lib/pricing/config";
import { pricingConfigInputSchema } from "@/lib/pricing/schema";

export const dynamic = "force-dynamic";


export async function GET() {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await loadPricingConfig();
  return NextResponse.json({ config: cfg });
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = pricingConfigInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message, issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const saved = await savePricingConfig(parsed.data, session.user.id);
    return NextResponse.json({ config: saved });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Save failed" },
      { status: 400 }
    );
  }
}
