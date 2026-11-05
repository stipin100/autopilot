// Claude helper. Only used when ANTHROPIC_API_KEY is set (Render env) - without it every caller falls back to templates.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const MODEL = "claude-opus-5-5";
export const aiReady = () => !!(process.env.ANTHROPIC_API_KEY || "").trim();

let client = null;

/** Asks Claude for JSON that matches a zod schema. Throws on refusal / bad output so callers can fall back. */
export async function askJson(schema, system, prompt, maxTokens = 16000) {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY.trim() });
  const r = await client.messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "medium", format: zodOutputFormat(schema) },
  });
  if (r.stop_reason === "refusal") throw new Error("Claude declined this one");
  if (r.stop_reason === "max_tokens") throw new Error("Claude's answer was too long");
  if (!r.parsed_output) throw new Error("Claude's answer didn't match the format");
  return r.parsed_output;
}

/** Turns an API error into one short line for the activity log. */
export function aiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "Claude key is wrong (ANTHROPIC_API_KEY)";
  if (e instanceof Anthropic.PermissionDeniedError) return "Claude key has no access - check billing on console.anthropic.com";
  if (e instanceof Anthropic.RateLimitError) return "Claude is busy (rate limit) - will retry";
  if (e instanceof Anthropic.APIError) return `Claude error ${e.status}: ${e.message.slice(0, 120)}`;
  return e.message;
}
