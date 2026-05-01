import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateTitchybookPdf } from "@/lib/pdf/generate";

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
    const pdfS3Key = await generateTitchybookPdf(id);
    return NextResponse.json({ success: true, pdfS3Key });
  } catch (err) {
    console.error("PDF generation error:", err);
    return NextResponse.json(
      { error: "PDF generation failed" },
      { status: 500 }
    );
  }
}
