import OpenAI from "openai";

let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === "sk-your-openai-api-key") {
      throw new Error(
        "OPENAI_API_KEY is not configured. Add it to your .env file.",
      );
    }
    client = new OpenAI({ apiKey });
  }
  return client;
}

export function getOpenAIModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o";
}

export function isAIConfigured(): boolean {
  const key = process.env.OPENAI_API_KEY;
  return !!key && key !== "sk-your-openai-api-key";
}
