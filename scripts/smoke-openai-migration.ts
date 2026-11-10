/**
 * Live smoke test for the GPT-4o -> gpt-6-sol migration.
 *
 * Mirrors the two real call sites:
 *   1. src/app/api/ai/chat/route.ts  (streaming, chat route params)
 *   2. src/lib/ai/pipeline.ts        (non-streaming json_object, chatJson params)
 *
 * Run: npx tsx scripts/smoke-openai-migration.ts
 */
import "dotenv/config";
import OpenAI from "openai";
import { buildSystemPrompt } from "../src/lib/ai/system-prompt";
import { parseContentPlan } from "../src/lib/ai/content-plan";
import {
  validatePlanAgainstTemplate,
  type TemplateTextSlot,
} from "../src/lib/ai/composer";

const MODEL = process.env.OPENAI_MODEL || "gpt-6-sol";

// Budgets currently configured in the call sites.
const CHAT_MAX_COMPLETION_TOKENS = 4000;
const PIPELINE_MAX_COMPLETION_TOKENS = 8000;

interface UsageLike {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function reportUsage(usage: UsageLike | null | undefined) {
  if (!usage) {
    console.log("  usage:              (none returned by the API)");
    return;
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const visible = usage.completion_tokens - reasoning;
  console.log(`  prompt tokens:      ${usage.prompt_tokens}`);
  console.log(
    `  completion tokens:  ${usage.completion_tokens}  (reasoning ${reasoning} / visible ${visible})`,
  );
  console.log(`  total tokens:       ${usage.total_tokens}`);
}

/** 1. Streaming call using the exact params from the chat route. */
async function smokeChatStream(client: OpenAI) {
  console.log("\n=== 1. Streaming chat route (reasoning_effort=low, max_completion_tokens=4000) ===");

  const systemPrompt = buildSystemPrompt({
    title: "The Rainy Day",
    activePage: "PAGE_2",
    pages: [
      { label: "FRONT_COVER", elementCount: 2, textSnippets: ["The Rainy Day"] },
      { label: "PAGE_2", elementCount: 1, textSnippets: [] },
    ],
  });

  const stream = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          "Write a two-line rhyming opening for page 2 about a duck who loves rainy days.",
      },
    ],
    stream: true,
    reasoning_effort: "low",
    max_completion_tokens: CHAT_MAX_COMPLETION_TOKENS,
    // NOT part of the route's params — added only so usage is observable here.
    stream_options: { include_usage: true },
  });

  let text = "";
  let chunks = 0;
  let finishReason: string | null = null;
  let usage: UsageLike | null = null;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      text += delta;
      chunks++;
    }
    const reason = chunk.choices[0]?.finish_reason;
    if (reason) finishReason = reason;
    if (chunk.usage) usage = chunk.usage as UsageLike;
  }

  console.log(`  model:              ${MODEL}`);
  console.log(`  finish_reason:      ${finishReason}`);
  console.log(`  content chunks:     ${chunks}`);
  reportUsage(usage);

  check("content is non-empty", text.trim().length > 0, `${text.length} chars`);
  check(
    "finish_reason is not 'length'",
    finishReason !== "length",
    finishReason ?? "unknown",
  );

  // The chat system prompt demands raw JSON, but the route does not set
  // response_format — so this is informational, not a hard assertion.
  try {
    const parsed = JSON.parse(text);
    check("streamed text parses as the prompt's JSON envelope", true);
    console.log(`  envelope keys:      ${Object.keys(parsed).join(", ")}`);
  } catch {
    console.log("  NOTE  streamed text is not raw JSON (informational only)");
  }

  console.log(`  first 180 chars:    ${JSON.stringify(text.slice(0, 180))}`);
}

/** 2. Non-streaming json_object call using the exact params from chatJson(). */
async function smokePipelineJson(client: OpenAI) {
  console.log(
    "\n=== 2. Pipeline chatJson (json_object, reasoning_effort=low, max_completion_tokens=8000) ===",
  );

  const slots: TemplateTextSlot[] = [
    { id: "cover-title", pageLabel: "FRONT_COVER" },
    { id: "page2-body", pageLabel: "PAGE_2" },
    { id: "page3-body", pageLabel: "PAGE_3" },
    { id: "page4-body", pageLabel: "PAGE_4" },
    { id: "page5-body", pageLabel: "PAGE_5" },
    { id: "page6-body", pageLabel: "PAGE_6" },
    { id: "page7-body", pageLabel: "PAGE_7" },
    { id: "back-blurb", pageLabel: "BACK_COVER" },
  ];

  const slotLines = slots
    .map((s) => `- id: "${s.id}" | page: ${s.pageLabel}`)
    .join("\n");

  const system = `You are "Titchybooks AI". You write text for a small 8-page A7 booklet by filling a template's text slots.
Respond with raw JSON only, matching exactly:
{"title": string (<=120 chars), "overrides": [{"templateElementId": string, "text": string}]}
Rules:
- Only use templateElementId values from the provided list.
- Provide one override per slot you want to fill; keep each text concise and print-friendly.
- Do NOT invent ids. Do NOT emit any layout, geometry, or styling.`;

  const user = `Book concept: "A duck who is afraid of the dark learns to love bedtime"\n\nTemplate text slots:\n${slotLines}\n\nWrite the booklet content now.`;

  const resp = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    reasoning_effort: "low",
    max_completion_tokens: PIPELINE_MAX_COMPLETION_TOKENS,
  });

  const raw = resp.choices[0]?.message?.content ?? "";
  const finishReason = resp.choices[0]?.finish_reason ?? null;

  console.log(`  model:              ${MODEL}`);
  console.log(`  finish_reason:      ${finishReason}`);
  reportUsage(resp.usage);

  check("content is non-empty", raw.trim().length > 0, `${raw.length} chars`);
  check("finish_reason is not 'length'", finishReason !== "length", finishReason ?? "unknown");

  const plan = parseContentPlan(raw);
  check("parseContentPlan() returned a plan", plan !== null);

  if (plan) {
    console.log(`  title:              ${JSON.stringify(plan.title)}`);
    console.log(`  overrides:          ${plan.overrides.length}/${slots.length} slots`);
    const validation = validatePlanAgainstTemplate(plan, slots);
    check(
      "validatePlanAgainstTemplate() ok",
      validation.ok,
      validation.ok ? "" : validation.issues.map((issue) => issue.message).join("; "),
    );
    console.log(`  filled slots:       ${plan.overrides.map((o) => o.templateElementId).join(", ")}`);
  } else {
    console.log(`  raw (first 400):    ${JSON.stringify(raw.slice(0, 400))}`);
  }
}

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log(`OPENAI_MODEL resolved to: ${MODEL}`);

  await smokeChatStream(client);
  await smokePipelineJson(client);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("\nSMOKE TEST ERROR:", err?.status ?? "", err?.message ?? err);
  if (err?.error) console.error(JSON.stringify(err.error, null, 2));
  process.exitCode = 1;
});
