// Keys you type into the app (Accounts → Keys). Imported first by server.mjs, so a saved key is in
// process.env before anything else reads it. Online they're locked (AES-256-GCM) with APP_PASSWORD,
// exactly like the wallet key files. A key saved here wins over the same key set on Render.

import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { fileURLToPath } from "node:url";

export const KEY_FIELDS = [
  { k: "ANTHROPIC_API_KEY", label: "Claude", what: "writes coin ideas, logos and websites", where: "console.anthropic.com → API Keys → Create key", test: /^sk-ant-\S{20,}$/ },
  { k: "X_CLIENT_ID", label: "X app - Client ID", what: "lets AUTOPILOT post on X", where: "developer.x.com → your app → Keys and tokens → OAuth 2.0 Client ID", test: /^\S{10,}$/ },
  { k: "X_CLIENT_SECRET", label: "X app - Client Secret", what: "goes with the Client ID", where: "same page → OAuth 2.0 Client Secret", test: /^\S{10,}$/ },
  { k: "PUMPPORTAL_API_KEY", label: "PumpPortal", what: "live trade data for the Brain's hot words + bot radar", where: "pumpportal.fun → Create API key (fund it with ~0.02 SOL)", test: /^\S{20,}$/ },
  { k: "PINATA_JWT", label: "Pinata", what: "uploads each coin's picture + details (needed to launch)", where: "app.pinata.cloud → API Keys → New key (Admin) → JWT", test: /^\S+\.\S+\.\S+$/ },
  { k: "SOLANA_RPC_URL", label: "Solana RPC", what: "your own fast connection to Solana", where: "helius.dev → your Mainnet RPC URL", test: /^https:\/\/\S+$/ },
  { k: "PUBLIC_URL", label: "Your AUTOPILOT address", what: "for links + the X login return", where: "e.g. https://pilot.degenlab.fun", test: /^https:\/\/[^\s/]+\/?$/ },
];

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const FILE = path.join(DATA, "app-keys.json");
const PUBLIC = process.env.PUBLIC === "1";
const fromHost = Object.fromEntries(KEY_FIELDS.map((f) => [f.k, (process.env[f.k] || "").trim()])); // set on Render / .env

function cryptKey() {
  if (!PUBLIC) return null;
  try {
    const salt = JSON.parse(fs.readFileSync(path.join(DATA, "salt.json"), "utf8"));
    return scryptSync(process.env.APP_PASSWORD || "", Buffer.from(salt, "hex"), 32);
  } catch {
    return null; // no salt yet = nothing was ever saved here
  }
}

function load() {
  try {
    const v = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!v?.enc) return v ?? {};
    const d = createDecipheriv("aes-256-gcm", cryptKey(), Buffer.from(v.iv, "hex"));
    d.setAuthTag(Buffer.from(v.tag, "hex"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data, "base64")), d.final()]).toString("utf8"));
  } catch {
    return {};
  }
}

let saved = load();
for (const [k, v] of Object.entries(saved)) if (v && KEY_FIELDS.some((f) => f.k === k)) process.env[k] = v;

/** What the Keys page shows: never the key itself, only whether it's set, where, and its last 4 characters. */
export function keyStatus() {
  return KEY_FIELDS.map(({ test, ...f }) => {
    const v = saved[f.k] || fromHost[f.k];
    return { ...f, set: !!v, source: saved[f.k] ? "app" : fromHost[f.k] ? "render" : "", tail: v ? v.slice(-4) : "" };
  });
}

/** values = { KEY: "new value" } (empty string = remove the one saved here). Returns the names that changed. */
export function saveKeys(values) {
  const next = { ...saved };
  const changed = [];
  for (const [k, raw] of Object.entries(values ?? {})) {
    const f = KEY_FIELDS.find((x) => x.k === k);
    if (!f) throw new Error(`Unknown key ${k}`);
    const v = String(raw ?? "").trim();
    if (v.length > 4000) throw new Error(`${f.label} is too long.`);
    if (v && !f.test.test(v)) throw new Error(`That doesn't look like a ${f.label} key - check you copied all of it.`);
    if ((next[k] || "") === v) continue;
    if (v) next[k] = v;
    else delete next[k];
    changed.push(f.label);
  }
  if (!changed.length) return changed;
  let out = next;
  const key = cryptKey();
  if (PUBLIC) {
    if (!key) throw new Error("AUTOPILOT isn't fully started yet - try again in a minute.");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(next), "utf8"), c.final()]);
    out = { enc: 1, iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: data.toString("base64") };
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(out, null, 2));
  fs.renameSync(FILE + ".tmp", FILE);
  saved = next;
  return changed;
}
