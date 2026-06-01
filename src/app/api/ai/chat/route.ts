import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getOpenAIClient, getOpenAIModel, isAIConfigured } from "@/lib/ai/client";
import { buildSystemPrompt, type BookContext } from "@/lib/ai/system-prompt";
import { PAGE_LABELS, type PageLabel } from "@/lib/constants";
import { z } from "zod";

export const dynamic = "force-dynamic";


const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(10000),
});

const pageContextSchema = z.object({
  label: z.enum(PAGE_LABELS),
  elementCount: z.number().int().min(0),
  textSnippets: z.array(z.string()),
});

const requestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(50),
  context: z.object({
    title: z.string().max(200),
    activePage: z.enum(PAGE_LABELS),
    pages: z.array(pageContextSchema).min(1).max(8),
  }),
});

// Simple per-user rate limiting (in-memory, resets on server restart)
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 2000;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAIConfigured()) {
    return NextResponse.json(
      { error: "AI assistant is not configured. OPENAI_API_KEY is missing." },
      { status: 503 },
    );
  }

  // Rate limiting
  const userId = session.user.id;
  const lastRequest = rateLimitMap.get(userId) ?? 0;
  const now = Date.now();
  if (now - lastRequest < RATE_LIMIT_MS) {
    return NextResponse.json(
      { error: "Please wait a moment before sending another message." },
      { status: 429 },
    );
  }
  rateLimitMap.set(userId, now);

  // Parse and validate request body
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid request format." },
      { status: 400 },
    );
  }

  const { messages, context } = body;
  const bookContext: BookContext = {
    title: context.title,
    activePage: context.activePage as PageLabel,
    pages: context.pages.map((p) => ({
      label: p.label as PageLabel,
      elementCount: p.elementCount,
      textSnippets: p.textSnippets,
    })),
  };

  const systemPrompt = buildSystemPrompt(bookContext);

  try {
    const openai = getOpenAIClient();
    const model = getOpenAIModel();

    const stream = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ],
      stream: true,
      temperature: 0.8,
      max_tokens: 2000,
    });

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ token: delta })}\n\n`),
              );
            }
          }
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`),
          );
          controller.close();
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Stream error";
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: message })}\n\n`,
            ),
          );
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "OpenAI API error";
    console.error("AI chat error:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
