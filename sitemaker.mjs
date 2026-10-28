// Site maker: builds each coin's website from a template, renders its banner, puts it on Vercel
// and points <sub>.degenlab.fun at it (Hostinger DNS). Sites live in Desktop\DEGENLAB\<sub>.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const SITE_DOMAIN = (process.env.SITE_DOMAIN || "degenlab.fun").trim();
const SITES_DIR = path.resolve(process.env.SITES_DIR || "C:/Users/Admin/Desktop/DEGENLAB");
const VERCEL_SCOPE = (process.env.VERCEL_SCOPE || "supertoshi").trim();
const HOSTINGER_TOKEN = (process.env.HOSTINGER_API_TOKEN || "").trim();

// Off on the online server (SITE_MAKER=0): it needs Edge + the Vercel CLI, which only exist on your PC.
export const siteConfig = { domain: SITE_DOMAIN, hostinger: !!HOSTINGER_TOKEN, enabled: process.env.SITE_MAKER !== "0" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function run(cmd, args, cwd, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: process.platform === "win32", windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${out.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`));
    });
  });
}

/** Splits "Last Brain Cell" into "Last Brain" + "Cell" so the last word gets the accent color. */
function titleHtml(name) {
  const words = esc(name).split(" ");
  if (words.length === 1) return `<span>${words[0]}</span>`;
  return `${words.slice(0, -1).join(" ")} <span>${words.at(-1)}</span>`;
}

function siteHtml(c, sub, logoFile) {
  const url = `https://${sub}.${SITE_DOMAIN}`;
  const accent = /^#[0-9a-f]{6}$/i.test(c.accent) ? c.accent : "#ff86b6";
  const story = esc(c.story || c.description || "").replace(/\n/g, "<br>");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name)} ($${esc(c.symbol)})</title>
<meta name="description" content="${esc(c.tagline || c.name)} - $${esc(c.symbol)}">
<meta property="og:title" content="${esc(c.name)} ($${esc(c.symbol)})">
<meta property="og:description" content="${esc(c.tagline || "")}">
<meta property="og:image" content="${url}/banner.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${url}/banner.png">
<link rel="icon" href="${logoFile}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@500;700;900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --a: ${accent}; --bg: #07060a; --text: #f4f0f6; --muted: #9b93a3; --line: color-mix(in srgb, var(--a) 22%, transparent); --panel: rgba(255,255,255,.04); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 Rubik, system-ui, sans-serif; overflow-x: hidden; }
  body::before { content: ""; position: fixed; inset: 0; z-index: -1; background: radial-gradient(ellipse at 70% 30%, color-mix(in srgb, var(--a) 22%, #0d0a10) 0%, #0b090e 40%, #050407 78%); }
  a { color: inherit; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
  nav { display: flex; align-items: center; gap: 10px; padding: 18px 0; }
  nav .brand { display: flex; align-items: center; gap: 10px; font-weight: 900; }
  nav img { width: 34px; height: 34px; border-radius: 9px; object-fit: cover; }
  nav .sp { flex: 1; }
  .btn { display: inline-flex; align-items: center; padding: 12px 20px; border-radius: 14px; font: 700 15px Rubik, sans-serif; text-decoration: none; border: 2px solid var(--a); color: var(--text); background: transparent; cursor: pointer; transition: transform .12s, filter .12s; }
  .btn:hover { transform: translateY(-2px); filter: brightness(1.1); }
  .btn.fill { background: var(--a); color: #0b0810; }
  .btn.sm { padding: 8px 14px; font-size: 13px; border-radius: 11px; }
  .hero { display: grid; grid-template-columns: 1.1fr 1fr; gap: 34px; align-items: center; padding: 34px 0 60px; }
  h1 { font: 900 clamp(48px, 8.5vw, 98px)/.92 Rubik, sans-serif; margin: 0; letter-spacing: -2px; text-transform: uppercase; text-shadow: 0 0 50px color-mix(in srgb, var(--a) 35%, transparent); }
  h1 span { color: var(--a); }
  .tag { font: 700 21px 'Space Mono', monospace; color: var(--a); margin: 18px 0 10px; filter: brightness(1.15); }
  .lead { color: var(--muted); max-width: 480px; margin: 0 0 24px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .note { margin-top: 26px; display: inline-block; background: #ffe98a; color: #3a2a05; padding: 14px 18px 12px; transform: rotate(-2deg); box-shadow: 0 10px 30px rgba(0,0,0,.5); max-width: 100%; cursor: pointer; }
  .note small { display: block; font: 700 11px 'Space Mono', monospace; letter-spacing: 2px; opacity: .7; }
  .note b { font: 700 14px 'Space Mono', monospace; word-break: break-all; }
  .art { justify-self: center; width: 100%; max-width: 440px; aspect-ratio: 1; position: relative; }
  .art::before { content: ""; position: absolute; inset: -8%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--a) 45%, transparent), transparent 65%); animation: pulse 3s ease-in-out infinite; }
  .art img { position: relative; width: 100%; height: 100%; object-fit: cover; border-radius: 34px; border: 3px solid var(--line); box-shadow: 0 30px 80px rgba(0,0,0,.6); animation: bob 3.4s ease-in-out infinite; }
  @keyframes bob { 50% { transform: translateY(-12px) rotate(1deg); } }
  @keyframes pulse { 50% { opacity: .6; transform: scale(.95); } }
  .strip { border-block: 1px solid var(--line); overflow: hidden; white-space: nowrap; padding: 14px 0; font: 900 22px Rubik, sans-serif; color: var(--a); }
  .strip div { display: inline-block; animation: slide 22s linear infinite; }
  @keyframes slide { to { transform: translateX(-50%); } }
  section { padding: 56px 0; }
  h2 { font: 900 clamp(30px, 5vw, 44px)/1 Rubik, sans-serif; margin: 0 0 22px; text-transform: uppercase; }
  h2 span { color: var(--a); }
  .steps { counter-reset: s; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .steps div { border: 1px solid var(--line); background: var(--panel); border-radius: 20px; padding: 22px; color: var(--muted); }
  .steps div::before { counter-increment: s; content: "0" counter(s); display: block; font: 700 14px 'Space Mono', monospace; color: var(--a); margin-bottom: 8px; }
  .steps b { color: var(--text); display: block; margin-bottom: 4px; }
  footer { padding: 30px 0 60px; text-align: center; color: var(--muted); font-size: 13px; }
  footer p { max-width: 620px; margin: 10px auto 0; }
  .toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: var(--a); color: #0b0810; font-weight: 700; padding: 10px 18px; border-radius: 12px; opacity: 0; transition: .2s; pointer-events: none; }
  .toast.on { opacity: 1; }
  @media (max-width: 820px) { .hero { grid-template-columns: 1fr; padding-top: 10px; } .art { max-width: 320px; order: -1; } .steps { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <div class="brand"><img src="${logoFile}" alt="">$${esc(c.symbol)}</div>
    <div class="sp"></div>
    <a class="btn sm" id="x" target="_blank" rel="noopener">X</a>
    <a class="btn sm fill" id="buyTop" target="_blank" rel="noopener">Buy</a>
  </nav>
  <div class="hero">
    <div>
      <h1>${titleHtml(c.name)}</h1>
      ${c.tagline ? `<div class="tag">${esc(c.tagline)}</div>` : ""}
      ${story ? `<p class="lead">${story}</p>` : ""}
      <div class="row">
        <a class="btn fill" id="buy" target="_blank" rel="noopener">Buy $${esc(c.symbol)}</a>
        <button class="btn" id="share">Share on X</button>
      </div>
      <div class="note" id="ca" title="Click to copy"><small>CONTRACT ADDRESS</small><b id="caText">dropping soon...</b></div>
    </div>
    <div class="art"><img src="${logoFile}" alt="${esc(c.name)}"></div>
  </div>
</div>
<div class="strip"><div>${`$${esc(c.symbol)} &nbsp;★&nbsp; `.repeat(24)}</div></div>
<div class="wrap">
  <section>
    <h2>How to <span>buy</span></h2>
    <div class="steps">
      <div><b>Get Phantom</b>Download the Phantom wallet and add some SOL.</div>
      <div><b>Open Pump.fun</b>Tap Buy above, or paste the contract address on pump.fun.</div>
      <div><b>Buy $${esc(c.symbol)}</b>Swap your SOL and join the community on X.</div>
    </div>
  </section>
  <footer>
    <div style="font-weight:900">${esc(c.name).toUpperCase()}</div>
    <p>$${esc(c.symbol)} is a meme coin made for fun. It has no intrinsic value, no promises and no expectation of financial return. Only spend what you can afford to lose.</p>
  </footer>
</div>
<div class="toast" id="toast"></div>
<script>
const CONFIG = ${JSON.stringify({ ca: c.mint || "", x: c.twitter || "" })};
const $ = (id) => document.getElementById(id);
const pump = CONFIG.ca ? "https://pump.fun/coin/" + CONFIG.ca : "https://pump.fun";
$("buy").href = $("buyTop").href = pump;
$("x").href = CONFIG.x || "https://x.com";
if (!CONFIG.x) $("x").style.display = "none";
if (CONFIG.ca) $("caText").textContent = CONFIG.ca;
function toast(m) { $("toast").textContent = m; $("toast").classList.add("on"); setTimeout(() => $("toast").classList.remove("on"), 1800); }
$("ca").onclick = () => CONFIG.ca ? navigator.clipboard.writeText(CONFIG.ca).then(() => toast("CA copied")) : toast("CA drops at launch");
$("share").onclick = () => window.open("https://x.com/intent/post?text=" + encodeURIComponent(${JSON.stringify(`${c.name} $${c.symbol}\n\n`)} + location.origin), "_blank");
</script>
</body>
</html>`;
}

function bannerHtml(c, logoFile) {
  const accent = /^#[0-9a-f]{6}$/i.test(c.accent) ? c.accent : "#ff86b6";
  const size = c.name.length > 16 ? 76 : c.name.length > 10 ? 92 : 112;
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@900&family=Space+Mono:wght@700&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; width: 1500px; height: 500px; overflow: hidden; background: #07060a; }
  .s { position: absolute; inset: 0; background: radial-gradient(ellipse at 76% 50%, color-mix(in srgb, ${accent} 30%, #0d0a10) 0%, #0b090e 42%, #050407 80%); }
  .t { position: absolute; left: 90px; top: 0; bottom: 0; right: 560px; display: flex; flex-direction: column; justify-content: center; }
  h1 { margin: 0; font: 900 ${size}px/.92 Rubik, sans-serif; color: #f4f0f6; text-transform: uppercase; letter-spacing: -2px; text-shadow: 0 0 40px ${accent}55; }
  h1 span { color: ${accent}; }
  .g { font: 700 28px 'Space Mono', monospace; color: ${accent}; margin-top: 22px; filter: brightness(1.15); }
  .k { font: 700 22px 'Space Mono', monospace; color: #9b93a3; margin-top: 10px; letter-spacing: 2px; }
  .glow { position: absolute; right: 60px; top: 0; width: 500px; height: 500px; border-radius: 50%; background: radial-gradient(circle, ${accent}66, transparent 65%); }
  img { position: absolute; right: 120px; top: 70px; width: 360px; height: 360px; object-fit: cover; border-radius: 40px; border: 4px solid ${accent}55; box-shadow: 0 30px 80px rgba(0,0,0,.6); }
</style></head><body><div class="s"></div><div class="glow"></div>
<div class="t"><h1>${titleHtml(c.name)}</h1>${c.tagline ? `<div class="g">${esc(c.tagline)}</div>` : ""}<div class="k">$${esc(c.symbol)}</div></div>
<img src="${logoFile}"></body></html>`;
}

function edgePath() {
  return [`${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`].find((p) => fs.existsSync(p));
}

async function renderBanner(dir, c, logoFile) {
  const edge = edgePath();
  if (!edge) throw new Error("Microsoft Edge not found - can't draw the banner");
  const page = path.join(dir, "brand", "banner.html");
  fs.writeFileSync(page, bannerHtml(c, `../public/${logoFile}`));
  const out = path.join(dir, "brand", `${c.sub}-banner.png`);
  await new Promise((resolve) => {
    const p = spawn(edge, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=6000", "--window-size=1500,500", `--screenshot=${out}`, "file:///" + page.replace(/\\/g, "/")], { windowsHide: true });
    p.on("close", resolve);
  });
  if (!fs.existsSync(out)) throw new Error("banner render failed");
  fs.copyFileSync(out, path.join(dir, "public", "banner.png"));
}

async function deploy(dir, sub) {
  const out = path.join(dir, ".deploy", `degenlab-${sub}`); // folder name = Vercel project name
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(path.join(dir, "public"))) fs.copyFileSync(path.join(dir, "public", f), path.join(out, f));
  fs.writeFileSync(path.join(out, "vercel.json"), JSON.stringify({ cleanUrls: true }));
  await run("vercel", ["deploy", "--prod", "--yes", "--scope", VERCEL_SCOPE], out);
  return out;
}

async function addSubdomain(sub, deployDir) {
  const host = `${sub}.${SITE_DOMAIN}`;
  await run("vercel", ["domains", "add", host, `degenlab-${sub}`, "--scope", VERCEL_SCOPE], deployDir).catch((e) => {
    if (!/already|in use|exists/i.test(e.message)) throw e;
  });
  if (!HOSTINGER_TOKEN) throw new Error("HOSTINGER_API_TOKEN missing in .env - site is up on Vercel but not on your domain yet");
  const r = await fetch(`https://developers.hostinger.com/api/dns/v1/zones/${SITE_DOMAIN}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${HOSTINGER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ overwrite: false, zone: [{ name: sub, type: "CNAME", ttl: 300, records: [{ content: "cname.vercel-dns.com" }] }] }),
  });
  if (!r.ok) throw new Error(`Hostinger DNS said ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

/** Writes the site files (index.html + logo) for this coin; used on create and after launch (to add the CA). */
function writeSite(c, imagesDir) {
  const dir = path.join(SITES_DIR, c.sub);
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.mkdirSync(path.join(dir, "brand"), { recursive: true });
  const logoFile = `logo.${c.image.split(".").pop()}`;
  fs.copyFileSync(path.join(imagesDir, c.image), path.join(dir, "public", logoFile));
  fs.writeFileSync(path.join(dir, "public", "index.html"), siteHtml(c, c.sub, logoFile));
  return { dir, logoFile };
}

/** Full build: site + banner + Vercel + subdomain. Returns the live URL. */
export async function buildSite(c, imagesDir, log) {
  const { dir, logoFile } = writeSite(c, imagesDir);
  log("Website: drawing the banner");
  await renderBanner(dir, c, logoFile);
  log("Website: uploading to Vercel");
  const deployDir = await deploy(dir, c.sub);
  log(`Website: connecting ${c.sub}.${SITE_DOMAIN}`);
  await addSubdomain(c.sub, deployDir);
  return `https://${c.sub}.${SITE_DOMAIN}`;
}

/** After launch: puts the contract address on the site. */
export async function updateSiteCA(c, imagesDir) {
  const { dir } = writeSite(c, imagesDir);
  await deploy(dir, c.sub);
}

export function bannerPath(c) {
  return path.join(SITES_DIR, c.sub, "brand", `${c.sub}-banner.png`);
}
