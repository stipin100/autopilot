// CONNECT X - log in each X account once (OAuth 2.0 with PKCE), then AUTOPILOT posts from it by itself.
// Needs your own X developer app: X_CLIENT_ID + X_CLIENT_SECRET in the env, and its callback set to
// <your AUTOPILOT address>/api/x/callback. Tokens are kept in x-accounts.json (locked like the wallet keys online).

import { createHash, randomBytes } from "node:crypto";

const AUTH = "https://x.com/i/oauth2/authorize";
const TOKEN = "https://api.x.com/2/oauth2/token";
const SCOPES = "tweet.read tweet.write users.read media.write offline.access"; // media.write = attach the banner

export const xAppReady = () => !!((process.env.X_CLIENT_ID || "").trim() && (process.env.X_CLIENT_SECRET || "").trim());

export function createX({ readSecret, writeSecret }) {
  const accounts = readSecret("x-accounts.json", []); // [{ id, handle, name, access, refresh, expires, at }]
  const pending = new Map(); // state -> { verifier, redirect, at }
  const save = () => writeSecret("x-accounts.json", accounts);
  const basic = () => "Basic " + Buffer.from(`${process.env.X_CLIENT_ID.trim()}:${process.env.X_CLIENT_SECRET.trim()}`).toString("base64");

  /** Where to send the browser to log in to X. */
  function connectUrl(redirect) {
    if (!xAppReady()) throw new Error("Add X_CLIENT_ID and X_CLIENT_SECRET first (see Settings > Connections).");
    for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
    const state = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    pending.set(state, { verifier, redirect, at: Date.now() });
    const q = new URLSearchParams({ response_type: "code", client_id: process.env.X_CLIENT_ID.trim(), redirect_uri: redirect, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" });
    return `${AUTH}?${q}`;
  }

  async function token(body) {
    const r = await fetch(TOKEN, { method: "POST", headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`X login failed (${r.status}): ${j.error_description || j.error || "no token"}`);
    return j;
  }

  /** X sends the browser back here after you log in. Returns the connected account. */
  async function callback(state, code) {
    const p = pending.get(state);
    if (!p) throw new Error("This X login link expired - press Connect X again.");
    pending.delete(state);
    const t = await token({ grant_type: "authorization_code", code, redirect_uri: p.redirect, code_verifier: p.verifier, client_id: process.env.X_CLIENT_ID.trim() });
    const me = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json()).catch(() => ({}));
    const u = me.data ?? {};
    if (!u.id) throw new Error("Logged in, but X didn't say which account it is.");
    const acc = { id: u.id, handle: u.username, name: u.name, access: t.access_token, refresh: t.refresh_token, expires: Date.now() + (t.expires_in ?? 7200) * 1000, at: Date.now() };
    const old = accounts.findIndex((a) => a.id === u.id);
    if (old >= 0) accounts[old] = acc;
    else accounts.push(acc);
    save();
    return { id: acc.id, handle: acc.handle };
  }

  async function fresh(acc) {
    if (acc.expires - Date.now() > 120_000) return acc.access;
    if (!acc.refresh) throw new Error(`@${acc.handle} needs to be connected again`);
    const t = await token({ grant_type: "refresh_token", refresh_token: acc.refresh, client_id: process.env.X_CLIENT_ID.trim() });
    Object.assign(acc, { access: t.access_token, refresh: t.refresh_token ?? acc.refresh, expires: Date.now() + (t.expires_in ?? 7200) * 1000 });
    save();
    return acc.access;
  }

  /** Uploads one picture for a post. Returns its media id. */
  async function uploadImage(acc, { bytes, type }) {
    const form = new FormData();
    form.append("media", new Blob([bytes], { type }), type === "image/png" ? "banner.png" : "banner.jpg");
    form.append("media_category", "tweet_image");
    const r = await fetch("https://api.x.com/2/media/upload", { method: "POST", headers: { Authorization: `Bearer ${await fresh(acc)}` }, body: form });
    const j = await r.json().catch(() => ({}));
    const id = j.data?.id ?? j.media_id_string;
    if (r.status === 403) throw new Error(`@${acc.handle} was connected before pictures were allowed - press Connect X again for it`);
    if (!r.ok || !id) throw new Error(`X picture upload said ${r.status}: ${JSON.stringify(j).slice(0, 120)}`);
    return String(id);
  }

  /**
   * Posts (or replies) from one connected account, with an optional picture { bytes, type }.
   * If only the picture fails, it still posts the text. Returns { id, url, imageError? }.
   */
  async function post(accountId, text, replyTo, image) {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) throw new Error("That X account isn't connected any more");
    let mediaId = null, imageError = null;
    if (image) mediaId = await uploadImage(acc, image).catch((e) => { imageError = e.message; return null; });
    const body = { text: text.slice(0, 280), ...(replyTo && { reply: { in_reply_to_tweet_id: replyTo } }), ...(mediaId && { media: { media_ids: [mediaId] } }) };
    const send = async () => fetch("https://api.x.com/2/tweets", { method: "POST", headers: { Authorization: `Bearer ${await fresh(acc)}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let r = await send();
    if (r.status === 401) { acc.expires = 0; r = await send(); } // token went stale early: refresh once
    const j = await r.json().catch(() => ({}));
    if (r.status === 402) throw new Error("X says your API credits ran out - top up at developer.x.com");
    if (!r.ok || !j.data?.id) throw new Error(`X said ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
    return { id: j.data.id, url: `https://x.com/${acc.handle}/status/${j.data.id}`, imageError };
  }

  function remove(accountId) {
    const i = accounts.findIndex((a) => a.id === accountId);
    if (i >= 0) accounts.splice(i, 1);
    save();
  }

  const list = () => accounts.map(({ id, handle, name, at }) => ({ id, handle, name, at }));
  const find = (id) => accounts.find((a) => a.id === id);
  return { connectUrl, callback, post, remove, list, find, all: () => accounts };
}
