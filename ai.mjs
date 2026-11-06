// Claude helper. Two ways in, either one is enough:
//  - CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`): runs Claude Code headless on your Claude subscription
//  - ANTHROPIC_API_KEY: the paid API (used first when both are set)
// Without either, every caller falls back to the built-in templates.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const MODEL = "claude-opus-5-5";
const apiKey = () => (process.env.ANTHROPIC_API_KEY || "").trim();
const subToken = () => (process.env.CLAUDE_CODE_OAUTH_TOKEN || "").trim();
export const aiReady = () => !!(apiKey() || subToken());
export const aiVia = () => (apiKey() ? "api" : subToken() ? "subscription" : "");

let client = null;

/** Asks Claude for JSON that matches a zod schema. Throws on refusal / bad output so callers can fall back. */
export async function askJson(schema, system, prompt, maxTokens = 16000) {
  if (!apiKey() && subToken()) return askViaClaudeCode(schema, system, prompt);
  client ??= new Anthropic({ apiKey: apiKey() });
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

// ---------- Claude Code on your subscription ----------

const ROOT = path.dirname(fileURLToPath(import.meta.url));
/** The native Claude Code binary from node_modules (the platform package, or the copy its installer made). */
function claudeBin() {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const tries = [
    path.join(ROOT, "node_modules", "@anthropic-ai", `claude-code-${process.platform}-${process.arch}`, exe),
    path.join(ROOT, "node_modules", "@anthropic-ai", `claude-code-${process.platform}-${process.arch}-musl`, exe),
    path.join(ROOT, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), // the installer's copy has this name everywhere
  ];
  const found = tries.find((p) => fs.existsSync(p) && fs.statSync(p).size > 1_000_000);
  if (!found) throw new Error("Claude Code isn't installed on the server");
  return found;
}

/** For the startup log + health page: is Claude Code ready to use a subscription token? */
export function claudeCodeInstalled() {
  try { return !!claudeBin(); } catch { return false; }
}

// Its own empty config folder: no settings, plugins, MCP servers or memory from anywhere else.
const CONFIG_DIR = path.join(os.tmpdir(), "autopilot-claude");

let queue = Promise.resolve(); // one Claude Code run at a time keeps the server light
function askViaClaudeCode(schema, system, prompt) {
  const run = queue.then(() => runClaudeCode(schema, system, prompt));
  queue = run.catch(() => {});
  return run;
}

function runClaudeCode(schema, system, prompt) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema); // Claude Code's checker doesn't know the 2020-12 tag
  const args = [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(jsonSchema), "--tools", "", "--strict-mcp-config",
    "--no-session-persistence", "--setting-sources", "", "--system-prompt", `${system}\n\nAnswer with the JSON object only.`,
  ];
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN: subToken() };
    delete env.ANTHROPIC_API_KEY; // make sure it runs on the subscription token
    const p = spawn(claudeBin(), args, { env, cwd: CONFIG_DIR, windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill(), 240_000);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", () => {
      clearTimeout(timer);
      let res;
      try { res = JSON.parse(out); } catch { return reject(new Error(`Claude Code: ${(err || out).trim().split("\n").pop()?.slice(0, 160) || "no answer"}`)); }
      if (res.is_error) return reject(new Error(`Claude Code: ${String(res.result || res.subtype || "error").slice(0, 160)}`));
      let data = res.structured_output;
      if (!data && typeof res.result === "string") {
        const m = res.result.match(/\{[\s\S]*\}/);
        try { data = m ? JSON.parse(m[0]) : null; } catch { data = null; }
      }
      const ok = schema.safeParse(data);
      if (!ok.success) return reject(new Error("Claude's answer didn't match the format"));
      resolve(ok.data);
    });
    p.stdin.end(prompt);
  });
}

/** Turns an API error into one short line for the activity log. */
export function aiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "Claude key is wrong (ANTHROPIC_API_KEY)";
  if (e instanceof Anthropic.PermissionDeniedError) return "Claude key has no access - check billing on console.anthropic.com";
  if (e instanceof Anthropic.RateLimitError) return "Claude is busy (rate limit) - will retry";
  if (e instanceof Anthropic.APIError) return `Claude error ${e.status}: ${e.message.slice(0, 120)}`;
  if (/invalid.*(token|api key)|authenticat|401|oauth/i.test(e.message)) return "Claude token is wrong or expired - run `claude setup-token` again and paste the new one";
  if (/usage limit|rate limit|429/i.test(e.message)) return "Claude subscription limit reached - it tries again later";
  return e.message;
}
