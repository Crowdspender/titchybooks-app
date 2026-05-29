import { z } from "zod";
import { PAGE_LABELS } from "@/lib/constants";

const pageLabelEnum = z.enum(PAGE_LABELS);

const textStyleSchema = z.object({
  fontSize: z.number().positive().max(400).optional(),
  fontFamily: z.string().min(1).max(100).optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  color: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/)
    .optional(),
  align: z.enum(["left", "center", "right"]).optional(),
});

export const suggestionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  targetPage: pageLabelEnum,
  text: z.string().min(1).max(5000),
  style: textStyleSchema.optional(),
});

export const aiResponseSchema = z.object({
  message: z.string(),
  suggestions: z.array(suggestionSchema).optional(),
});

export type AiSuggestion = z.infer<typeof suggestionSchema>;
export type AiResponse = z.infer<typeof aiResponseSchema>;

/**
 * Parse an AI response string as JSON, validating it against the schema.
 * Returns the parsed response or null if invalid.
 */
export function parseAiResponse(raw: string): AiResponse | null {
  try {
    const parsed = JSON.parse(raw);
    return aiResponseSchema.parse(parsed);
  } catch {
    return null;
  }
}

/**
 * Sanitize text content from the AI before inserting into the editor.
 * Strips control characters and enforces length limits.
 */
export function sanitizeAiText(text: string): string {
  // Remove control characters except newline, tab, carriage return
  const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Enforce max length matching the editor schema
  return cleaned.slice(0, 5000);
}
