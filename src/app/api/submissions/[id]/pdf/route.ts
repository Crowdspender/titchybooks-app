import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { enqueueRenderJob } from "@/lib/pdf/render-job";
import { errorResponse } from "@/lib/editor/submission-store";

export const dynamic = "force-dynamic";


export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const result = await enqueueRenderJob(id, { id: session.user.id, role: session.user.role }, { retry: true });
    return NextResponse.json({ success: true, ...result }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
