// WEBSITE MAKER. Every approved coin gets its own one-page site, served by AUTOPILOT itself.
// Claude (if ANTHROPIC_API_KEY is set) writes the site PLAN - headline, live stats, sections, demo, token text.
// Without a key a plan is written from the coin's own idea text. The template below turns any plan into the page.
// The CA, pump.fun button and X link appear by themselves once the coin is launched.

import { z } from "zod";
import { aiReady, askJson } from "./ai.mjs";

const Item = z.object({ name: z.string(), detail: z.string(), value: z.string() });
const Section = z.object({
  nav: z.string().describe("1 word for the menu"),
  kicker: z.string(), title: z.string(), highlight: z.string().describe("2-3 words of the title to colour"),
  text: z.string(),
  module: z.enum(["steps", "demo", "table", "bento", "terminal"]),
  items: z.array(Item).describe("steps: 4-5 stages; bento: 4-5 feature cards; demo/terminal/table: can be empty"),
  columns: z.array(z.string()).describe("table only: 4-6 column names"),
  rows: z.array(z.array(z.string())).describe("table only: 6-8 rows, last column a status word like live / ok / new / hot"),
  lines: z.array(z.string()).describe("terminal only: 6-9 log lines the product would print"),
  input: z.object({ label: z.string(), placeholder: z.string(), button: z.string(), steps: z.array(z.string()), result: z.string().describe("one line shown after the steps; {input} is replaced with what the visitor typed") })
    .describe("demo only; other modules: empty strings / empty array"),
});
export const PlanSchema = z.object({
  palette: z.object({ bg: z.string(), surface: z.string(), accent: z.string(), accent2: z.string() }).describe("dark background, hex colours"),
  chip: z.string().describe("tiny status line above the headline"),
  hero: z.object({ kicker: z.string(), headline: z.string().describe("max 8 words"), highlight: z.string(), subhead: z.string(), cta: z.string(), cta2: z.string() }),
  heroCards: z.array(z.object({ label: z.string(), value: z.string(), detail: z.string() })).describe("exactly 2 small live-looking cards"),
  ticker: z.array(z.string()).describe("8 short activity lines; may use {n} {sol} {addr} {hex} {pct} placeholders"),
  stats: z.array(z.object({ label: z.string(), value: z.number(), unit: z.string(), decimals: z.number(), ratePerMin: z.number() })).describe("exactly 4 counters"),
  sections: z.array(Section).describe("exactly 4 sections, each a different module"),
  token: z.object({ title: z.string(), text: z.string() }),
  faq: z.array(z.object({ q: z.string(), a: z.string() })).describe("3 short Q&As"),
  closing: z.object({ title: z.string(), highlight: z.string(), text: z.string() }),
});

const SYSTEM = `You write the landing page plan for a memecoin that is pitched as a real product (an app, agent, card, pad...).
Write like a calm, premium fintech product page: concrete, specific, believable numbers and names, short sentences, no hype words (no "revolutionary", "moon", "100x", "guaranteed"), no promises of profit, no financial advice.
The token text must say it's a fair launch on pump.fun with no presale and promise nothing else. Never invent partnerships with real companies.
Keep every text short and punchy (headlines under 8 words, details under 15 words). The colours come from the coin logo - just return any dark hex values for palette.`;

/** Claude's plan, or a plan written from the coin's own text. */
export async function planSite(brand) {
  if (aiReady()) {
    const prompt = `Coin: ${brand.name} ($${brand.symbol})\nPitch: ${brand.tagline || ""}\nDescription: ${brand.description || ""}\n${brand.siteDirection ? `Extra direction from the owner: ${brand.siteDirection}\n` : ""}${brand.x?.handle ? `Built by @${brand.x.handle}.\n` : ""}Write the plan. Use these 4 modules once each, in a sensible order: steps, demo, table, bento (or terminal instead of table if the product is technical).`;
    const plan = await askJson(PlanSchema, SYSTEM, prompt, 8000);
    return { ...plan, by: "claude" };
  }
  return templatePlan(brand);
}

export function templatePlan(b) {
  const what = (b.tagline || b.description || `${b.name} on Solana`).replace(/\.$/, "");
  const word = b.name.split(" ")[0];
  return {
    by: "template",
    palette: { bg: "#08090c", surface: "#11141a", accent: b.palette?.accent || "#d5f26c", accent2: "#7da7ff" },
    chip: `${b.name} · live on Solana`,
    hero: { kicker: `$${b.symbol}`, headline: b.name, highlight: b.name.split(" ").slice(-1)[0], subhead: `${what}.`, cta: "Open the app", cta2: "How it works" },
    heroCards: [
      { label: "Running now", value: "24/7", detail: "no sign-up, just a wallet" },
      { label: "Avg time", value: "38s", detail: "from start to done" },
    ],
    ticker: [`{addr} just used ${b.name}`, `${word} job {hex} done in {n}s`, `{n} people online`, `{sol} SOL moved through ${b.name}`, `New user from {addr}`, `${word} run {hex} · {pct}% done`, `{addr} came back for more`, `Another one done · {n}s`],
    stats: [
      { label: "Jobs done", value: 12840, unit: "", decimals: 0, ratePerMin: 4 },
      { label: "Wallets", value: 3910, unit: "", decimals: 0, ratePerMin: 1 },
      { label: "Volume", value: 842, unit: "K USD", decimals: 0, ratePerMin: 0.4 },
      { label: "Avg time", value: 38, unit: "s", decimals: 0, ratePerMin: 0 },
    ],
    sections: [
      { nav: "How", kicker: "How it works", title: "Three taps and it's done", highlight: "it's done", text: `${b.name} keeps it simple: connect, choose, done.`, module: "steps", items: [
        { name: "Connect", detail: "Any Solana wallet", value: "" }, { name: "Choose", detail: "Pick what you want done", value: "" },
        { name: "Run", detail: `${b.name} does the work`, value: "" }, { name: "Done", detail: "Receipt saved on chain", value: "" }], columns: [], rows: [], lines: [], input: { label: "", placeholder: "", button: "", steps: [], result: "" } },
      { nav: "Try", kicker: "Try it", title: `See ${b.name} work`, highlight: b.name, text: "Type anything and watch it run. This is a preview.", module: "demo", items: [], columns: [], rows: [], lines: [], input: { label: "What should it do?", placeholder: `Try ${word.toLowerCase()} on anything`, button: "Run it", steps: ["Reading", "Working", "Checking", "Done"], result: `Done · {input} · receipt {hex}` } },
      { nav: "Live", kicker: "Right now", title: "Live on the network", highlight: "Live", text: "A preview of what's running across the app.", module: "table", items: [], columns: ["Job", "Wallet", "Time", "Status"], rows: [
        ["Job #4821", "7xKX…9fQa", "12s", "live"], ["Job #4820", "Bq4m…Lr2T", "31s", "ok"], ["Job #4819", "9dPe…c7Wn", "44s", "ok"], ["Job #4818", "Fh2s…Ux8k", "8s", "new"], ["Job #4817", "3vNq…aT5e", "51s", "hot"], ["Job #4816", "Kc8r…2mZp", "27s", "ok"]], lines: [], input: { label: "", placeholder: "", button: "", steps: [], result: "" } },
      { nav: "Why", kicker: "Why it's nice", title: "The small things", highlight: "small things", text: "Made to be easy.", module: "bento", items: [
        { name: "No sign-up", detail: "Your wallet is your account.", value: "0 forms" }, { name: "Fast", detail: "Most runs finish in under a minute.", value: "38s" },
        { name: "On chain", detail: "Every run leaves a receipt.", value: "100%" }, { name: "Cheap", detail: "Pennies per run.", value: "<$0.01" }], columns: [], rows: [], lines: [], input: { label: "", placeholder: "", button: "", steps: [], result: "" } },
    ],
    token: { title: `About $${b.symbol}`, text: `$${b.symbol} is the coin for ${b.name}, fair launched on pump.fun. No presale, no team bag promises. That's it.` },
    faq: [
      { q: `What is ${b.name}?`, a: `${what}.` },
      { q: `Where do I get $${b.symbol}?`, a: "On pump.fun - the button above opens it once the coin is live." },
      { q: "Is anything promised?", a: "No. It's a fair launch with no presale. Only buy what you're fine losing." },
    ],
    closing: { title: `Start with ${b.name}`, highlight: b.name, text: "Connect a wallet and try it in under a minute." },
  };
}

// ---------- the page ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hl = (text, part) => {
  const t = esc(text), p = esc(part);
  return p && t.includes(p) ? t.replace(p, `<em>${p}</em>`) : t;
};
const hex = (c, fb) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c : fb);
function mix(a, b, t) {
  const x = a.match(/\w\w/g).map((h) => parseInt(h, 16)), y = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
const rgb = (h) => h.match(/\w\w/g).map((x) => parseInt(x, 16)).join(" ");
const IC = {
  bolt: `<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>`,
  copy: `<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  search: `<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  link: `<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`,
  layers: `<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>`,
  pulse: `<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>`,
  chart: `<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 5-6"/></svg>`,
  home: `<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 11 12 4l9 7v9H3z"/></svg>`,
  dot: `<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>`,
  coin: `<svg class="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 9h4.5a1.5 1.5 0 0 1 0 3H9h5a1.5 1.5 0 0 1 0 3H9"/></svg>`,
};
const pad2 = (n) => String(n).padStart(2, "0");

function sectionHead(s, i) {
  return `<div class="shead"><div><div class="kicker">${pad2(i + 1)} · ${esc(s.kicker)}</div><h2>${hl(s.title, s.highlight)}</h2><p class="sub">${esc(s.text)}</p></div><span class="pill acc">preview data</span></div>`;
}

function sectionHtml(s, i, ctx) {
  let body = "";
  if (s.module === "demo") {
    const d = s.input;
    const navs = ctx.plan.sections.map((x) => x.nav);
    body = `<div class="card win reveal"><div class="winbar"><span class="dots"><i></i><i></i><i></i></span><span class="url">🔒 ${esc(ctx.host)}/app</span><span class="pill good" style="justify-self:end">live</span></div>
<div class="app"><aside class="side"><div class="brand sm"><img src="${esc(ctx.logo)}" alt="">${esc(ctx.brand.name)}</div><div class="slabel">Menu</div>${navs.map((n, k) => `<a class="${k === i ? "on" : ""}" href="#s${k}">${IC.dot}${esc(n)}</a>`).join("")}
<div class="slabel">Token</div><a href="#token">${IC.coin}$${esc(ctx.brand.symbol)}</a><div class="perk"><b>Holder perk</b><span>Hold $${esc(ctx.brand.symbol)} for early access to new features.</span></div></aside>
<div class="appmain demo" data-result="${esc(d.result)}" data-steps="${esc(JSON.stringify(d.steps?.length ? d.steps : ["Working", "Done"]))}">
<div class="apphead"><div><div class="k">${esc(d.label || "Try it")}</div><b>${esc(ctx.brand.name)}</b></div><span class="pill acc">instant</span></div>
<div class="drow"><input placeholder="${esc(d.placeholder)}" maxlength="80"><button class="btn go">${IC.bolt}${esc(d.button || "Run")}</button></div>
<div class="dsteps">${(d.steps?.length ? d.steps : ["Working", "Done"]).map((x, k) => `<div><i>${k + 1}</i>${esc(x)}</div>`).join("")}</div>
<div class="dbar"><i></i></div><div class="dout">Ready.</div></div></div></div>`;
  } else if (s.module === "steps") {
    const n = s.items.length || 1;
    body = `<div class="card flow reveal"><svg class="flines" viewBox="0 0 1000 560" preserveAspectRatio="none">${s.items.map((_, k) => {
      const a = (-90 + (360 / n) * k) * (Math.PI / 180);
      return `<path d="M500 280 L${(500 + Math.cos(a) * 380).toFixed(0)} ${(280 + Math.sin(a) * 210).toFixed(0)}"/>`;
    }).join("")}</svg>
<div class="fcore"><img src="${esc(ctx.logo)}" alt=""><b>${esc(ctx.brand.name)}</b></div>
${s.items.map((it, k) => {
      const a = (-90 + (360 / n) * k) * (Math.PI / 180);
      return `<div class="fnode" style="--x:${(50 + Math.cos(a) * 38).toFixed(1)}%;--y:${(50 + Math.sin(a) * 37.5).toFixed(1)}%"><b><i></i>${esc(it.name)}</b><span>${esc(it.detail)}</span>${it.value ? `<em>${esc(it.value)}</em>` : ""}</div>`;
    }).join("")}</div>`;
  } else if (s.module === "table") {
    body = `<div class="card reveal"><div class="chead">${IC.search}<b>${esc(s.kicker)} (preview)</b><input class="tsearch" placeholder="Search..."></div><div class="tbl-scroll"><table class="tbl"><thead><tr>${s.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${s.rows.map((r) => `<tr>${r.map((c, k) => k === r.length - 1 ? `<td><span class="st st-${esc(String(c).toLowerCase().replace(/[^a-z]/g, ""))}">${esc(c)}</span></td>` : `<td class="${k === 0 ? "strong" : "mono"}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
  } else if (s.module === "terminal") {
    body = `<div class="card term reveal"><div class="winbar"><span class="dots"><i></i><i></i><i></i></span><span class="url">${esc(ctx.brand.symbol.toLowerCase())}-agent · ~</span><span class="pill good" style="justify-self:end">running</span></div><pre data-lines="${esc(JSON.stringify(s.lines))}"></pre></div>`;
  } else {
    body = `<div class="bento">${s.items.map((it, n) => `<div class="card pad top-glow reveal b${n}"><span class="big">${esc(it.value)}</span><h3>${esc(it.name)}</h3><p>${esc(it.detail)}</p></div>`).join("")}</div>`;
  }
  return `<section id="s${i}" data-nav="${esc(s.nav)}"><div class="wrap">${sectionHead(s, i)}${body}</div></section>`;
}

/**
 * page = { plan, brand, ca, xUrl, siteUrl, logo, banner } (logo / banner = image URLs)
 * One design for every coin (glass top bar, network globe, numbered sections) - only the colour and words change.
 */
export function renderSite({ plan, brand, ca, xUrl, siteUrl, logo, banner }) {
  const p = plan.palette ?? {};
  const accent = hex(brand.palette?.accent, hex(p.accent, "#f0bf60"));
  const accent2 = mix(accent, "#f4f7a0", 0.45);
  const bg = mix("#060606", accent, 0.05);
  const title = `${brand.name} ($${brand.symbol})`;
  const desc = plan.hero?.subhead || brand.tagline || brand.description || brand.name;
  const pump = ca ? `https://pump.fun/coin/${ca}` : "";
  let host = "";
  try { host = new URL(siteUrl).host; } catch { host = `${brand.symbol.toLowerCase()}.app`; }
  const ctx = { plan, brand, logo, host };
  const sym = esc(brand.symbol);
  const demoIdx = Math.max(0, plan.sections.findIndex((s) => s.module === "demo"));
  const navs = [["top", "Home"], ...plan.sections.map((s, i) => [`s${i}`, s.nav]), ["token", `$${brand.symbol}`]];
  const shortCa = ca ? `${ca.slice(0, 6)}…${ca.slice(-6)}` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(brand.name)} · $${sym} — ${esc(plan.hero.headline)}</title><meta name="description" content="${esc(desc)}"><meta name="theme-color" content="${bg}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(banner)}"><meta property="og:url" content="${esc(siteUrl)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(banner)}"><link rel="icon" href="${esc(logo)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:${bg};--bg-rgb:${rgb(bg)};--acc:${rgb(accent)};--acc2:${rgb(accent2)};--good:${rgb(accent2)};--warn:255 184 77;--bad:255 92 108;
--ink:#eef1f8;--ink2:#aab3c5;--ink3:#6d7689;--line:rgb(255 255 255 / .08);--line2:rgb(255 255 255 / .14);
--grad:linear-gradient(100deg,rgb(var(--acc)),rgb(var(--acc2)));--r2:20px;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace;--sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.55 var(--sans);font-feature-settings:"cv11","ss01","ss03";overflow-x:hidden;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}button{font:inherit;color:inherit;cursor:pointer}
canvas#bg{position:fixed;inset:0;z-index:0;width:100%;height:100%;pointer-events:none}
.glow{position:fixed;width:520px;height:520px;border-radius:50%;pointer-events:none;z-index:1;left:0;top:0;background:radial-gradient(circle,rgb(var(--acc) / .1),transparent 62%);transform:translate(-50%,-50%);mix-blend-mode:screen}
main,footer{position:relative;z-index:3}
.wrap{width:min(1240px,calc(100% - 40px));margin:0 auto}
.ic{flex:none}
/* top bar */
.top{position:fixed;top:12px;left:50%;transform:translateX(-50%);width:min(1240px,calc(100% - 24px));z-index:50;border-radius:18px;background:rgb(var(--bg-rgb) / .55);border:1px solid var(--line);backdrop-filter:saturate(150%) blur(16px);-webkit-backdrop-filter:saturate(150%) blur(16px);box-shadow:inset 0 1px 0 rgb(255 255 255 / .05)}
.top-row{display:flex;align-items:center;gap:14px;padding:10px 12px 10px 14px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:-.02em;white-space:nowrap}.brand img{width:30px;height:30px;border-radius:9px;object-fit:cover;background:#000}
.pills{display:flex;gap:2px;margin:0 auto;padding:3px;border-radius:999px;background:rgb(255 255 255 / .03);border:1px solid var(--line)}
.pills a{font-size:13px;font-weight:600;color:var(--ink2);padding:6px 13px;border-radius:999px;transition:.2s;white-space:nowrap}.pills a:hover,.pills a.on{color:var(--ink);background:rgb(255 255 255 / .07)}
.chip{display:inline-flex;align-items:center;gap:7px;font:600 12px/1 var(--mono);padding:8px 11px;border-radius:999px;background:rgb(255 255 255 / .04);border:1px solid var(--line);color:var(--ink2);white-space:nowrap}
.chip .dot{width:7px;height:7px;border-radius:50%;background:rgb(var(--good));box-shadow:0 0 10px rgb(var(--good));animation:blink 1.6s infinite}.chip.warn .dot{background:rgb(var(--warn));box-shadow:0 0 10px rgb(var(--warn))}
@keyframes blink{50%{opacity:.35}}
.ticker{display:flex;align-items:center;gap:10px;border-top:1px solid var(--line);padding:7px 14px;overflow:hidden;font:500 12px/1 var(--mono);color:var(--ink3)}
.ticker>b{color:rgb(var(--acc));font-weight:700;white-space:nowrap;display:flex;gap:6px;align-items:center}
.ticker-wrap{overflow:hidden;mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);flex:1}
.ticker-track{display:flex;gap:28px;white-space:nowrap;width:max-content;animation:marquee 48s linear infinite}.ticker-track span b{color:var(--ink);font-weight:600}
@keyframes marquee{to{transform:translateX(-50%)}}
/* buttons */
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:9px;height:46px;padding:0 20px;border-radius:14px;border:1px solid var(--line2);background:rgb(255 255 255 / .05);font-weight:700;font-size:15px;letter-spacing:-.01em;transition:transform .2s,background .2s,box-shadow .2s;backdrop-filter:blur(10px);white-space:nowrap}
.btn:hover{background:rgb(255 255 255 / .09);transform:translateY(-1px)}
.btn.go{border:0;color:#120f08;background:var(--grad);box-shadow:0 10px 40px -10px rgb(var(--acc) / .8),inset 0 1px 0 rgb(255 255 255 / .35)}.btn.go:hover{box-shadow:0 14px 50px -8px rgb(var(--acc) / 1),inset 0 1px 0 rgb(255 255 255 / .4)}
.btn.sm{height:36px;padding:0 14px;font-size:13px;border-radius:11px}.btn[disabled]{opacity:.55;cursor:default}
/* hero */
.hero{min-height:100vh;min-height:100svh;display:flex;align-items:center;padding:150px 0 90px;position:relative}
.hero-in{max-width:680px;position:relative;z-index:2}
.eyebrow{display:inline-flex;align-items:center;gap:8px;font:600 12px/1 var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--ink2);padding:8px 12px;border-radius:999px;background:rgb(255 255 255 / .04);border:1px solid var(--line);margin-bottom:26px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eyebrow .dot{width:7px;height:7px;flex:none;border-radius:50%;background:rgb(var(--good));box-shadow:0 0 10px rgb(var(--good))}
h1{font-size:clamp(46px,7.6vw,96px);line-height:.96;letter-spacing:-.055em;font-weight:900;margin:0 0 24px;text-shadow:0 4px 40px rgb(var(--bg-rgb) / .6)}
h1 em,h2 em{font-style:normal;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{font-size:clamp(17px,1.6vw,20px);color:var(--ink2);max-width:560px;margin:0 0 32px}
.ctas{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.ca-row{display:flex;align-items:center;gap:10px;margin-top:26px;font:500 13px/1 var(--mono);color:var(--ink3);flex-wrap:wrap}
.ca-row code{color:var(--ink2);padding:8px 11px;border-radius:10px;background:rgb(255 255 255 / .04);border:1px solid var(--line);max-width:100%;overflow:hidden;text-overflow:ellipsis}
.ca-row .btn{height:32px;padding:0 11px;font:600 12px var(--mono);border-radius:10px;color:var(--ink3)}
.coin{position:absolute;right:9%;top:50%;width:min(23vw,250px);aspect-ratio:1;border-radius:50%;transform:translateY(-50%);z-index:1;animation:float 6s ease-in-out infinite}
.coin img{width:100%;height:100%;border-radius:50%;object-fit:cover;border:2px solid rgb(var(--acc) / .55);box-shadow:0 0 0 10px rgb(var(--acc) / .06),0 0 120px 10px rgb(var(--acc) / .35),inset 0 0 40px rgb(0 0 0 / .5);background:#000}
.coin::after{content:"";position:absolute;inset:-26px;border-radius:50%;border:1px dashed rgb(var(--acc) / .25);animation:spin 40s linear infinite}
@keyframes float{50%{transform:translateY(calc(-50% - 14px))}}@keyframes spin{to{transform:rotate(360deg)}}
.scroll-cue{position:absolute;bottom:26px;left:50%;transform:translateX(-50%);font:600 11px/1 var(--mono);letter-spacing:.14em;color:var(--ink3);text-transform:uppercase;display:flex;flex-direction:column;align-items:center;gap:10px}
.scroll-cue i{width:1px;height:34px;background:linear-gradient(var(--ink3),transparent);animation:cue 2s infinite}@keyframes cue{50%{opacity:.3}}
/* stats */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.stat{padding:20px 22px}.stat .k{display:flex;align-items:center;gap:8px;font:600 11px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink3)}.stat .k .ic{color:rgb(var(--acc))}
.stat .v{font:800 30px/1.1 var(--sans);letter-spacing:-.035em;margin-top:12px;font-variant-numeric:tabular-nums}.stat .v small{font-size:15px;color:var(--ink3);font-weight:600;margin-left:4px;letter-spacing:0}
/* sections */
section{position:relative;padding:120px 0 0;scroll-margin-top:90px}
.shead{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:36px}
.kicker{font:600 12px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:rgb(var(--acc));margin-bottom:14px;display:flex;gap:10px;align-items:center}.kicker::before{content:"";width:22px;height:1px;background:rgb(var(--acc))}
h2{font-size:clamp(34px,4.6vw,58px);line-height:1;letter-spacing:-.045em;font-weight:900;margin:0;max-width:760px;text-shadow:0 4px 30px rgb(var(--bg-rgb) / .7)}
.sub{color:var(--ink2);max-width:520px;margin:14px 0 0;font-size:17px}
.pill{display:inline-flex;align-items:center;gap:6px;font:600 11px/1 var(--mono);padding:5px 9px;border-radius:999px;background:rgb(255 255 255 / .05);border:1px solid var(--line);text-transform:uppercase;white-space:nowrap}
.pill{}.pill.good{color:rgb(var(--good));background:rgb(var(--good) / .1);border-color:rgb(var(--good) / .22)}.pill.acc{color:rgb(var(--acc));background:rgb(var(--acc) / .12);border-color:rgb(var(--acc) / .25)}
.card{position:relative;border-radius:var(--r2);border:1px solid var(--line);background:linear-gradient(180deg,rgb(255 255 255 / .055),rgb(255 255 255 / .018));backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);box-shadow:inset 0 1px 0 rgb(255 255 255 / .06),0 20px 60px -30px rgb(0 0 0 / .8)}
.card.pad{padding:24px}.card.top-glow::before{content:"";position:absolute;left:20px;right:20px;top:-1px;height:1px;background:linear-gradient(90deg,transparent,rgb(var(--acc) / .9),transparent)}
/* window */
.win{overflow:hidden}.winbar{display:grid;grid-template-columns:80px 1fr 80px;align-items:center;padding:10px 14px;background:linear-gradient(180deg,rgb(255 255 255 / .06),rgb(255 255 255 / .02));border-bottom:1px solid var(--line)}
.dots{display:flex;gap:7px}.dots i{width:11px;height:11px;border-radius:50%;background:#ff5f57}.dots i:nth-child(2){background:#febc2e}.dots i:nth-child(3){background:#28c840}
.winbar .url{justify-self:center;display:inline-flex;gap:7px;align-items:center;font:500 12px/1 var(--mono);color:var(--ink3);padding:7px 14px;border-radius:9px;background:rgb(0 0 0 / .35);border:1px solid var(--line);max-width:100%;overflow:hidden;white-space:nowrap}
.app{display:grid;grid-template-columns:230px 1fr;min-height:440px}
.side{border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;gap:4px;background:rgb(0 0 0 / .18)}
.brand.sm{margin:0 6px 14px;font-size:15px}.brand.sm img{width:28px;height:28px}
.slabel{font:600 10.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:14px 8px 8px}
.side a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:11px;font-size:14px;font-weight:600;color:var(--ink2);border:1px solid transparent}
.side a .ic{color:var(--ink3);width:15px;height:15px}.side a.on{color:var(--ink);background:rgb(var(--acc) / .1);border-color:rgb(var(--acc) / .22)}.side a.on .ic{color:rgb(var(--acc))}
.perk{margin-top:auto;padding:12px;border-radius:13px;background:rgb(255 255 255 / .04);border:1px solid var(--line);font-size:12px;color:var(--ink3)}.perk b{display:block;color:var(--ink);font-size:13px;margin-bottom:3px}
.appmain{padding:24px}
.apphead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}.apphead .k{font:600 11px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);margin-bottom:6px}.apphead b{font-size:20px;letter-spacing:-.02em}
.drow{display:flex;gap:10px}
.drow input,.tsearch{flex:1;min-width:0;height:46px;background:rgb(0 0 0 / .35);border:1px solid var(--line2);border-radius:14px;padding:0 16px;color:var(--ink);font:500 14px var(--sans)}
.drow input:focus,.tsearch:focus{outline:none;border-color:rgb(var(--acc) / .6);box-shadow:0 0 0 4px rgb(var(--acc) / .1)}
.dsteps{display:grid;gap:10px;margin:22px 0 18px}.dsteps div{display:flex;align-items:center;gap:12px;font-size:14px;color:var(--ink3);transition:color .3s}
.dsteps i{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font:600 11px var(--mono);font-style:normal;border:1px solid var(--line2);flex:none}
.dsteps div.on{color:var(--ink)}.dsteps div.on i{border-color:rgb(var(--acc));color:rgb(var(--acc));box-shadow:0 0 14px rgb(var(--acc) / .5)}
.dsteps div.ok{color:var(--ink2)}.dsteps div.ok i{background:var(--grad);border-color:transparent;color:#120f08}
.dbar{height:3px;background:var(--line);border-radius:3px;overflow:hidden}.dbar i{display:block;height:100%;width:0;background:var(--grad);transition:width .5s ease}
.dout{margin-top:12px;font:500 13px var(--mono);color:var(--ink3);min-height:20px}.dout.done{color:rgb(var(--acc))}
/* flow */
.flow{height:560px;overflow:hidden}.flines{position:absolute;inset:0;width:100%;height:100%}
.flines path{stroke:rgb(var(--acc) / .35);stroke-width:1.2;fill:none;stroke-dasharray:6 8;animation:dash 1.6s linear infinite;vector-effect:non-scaling-stroke}@keyframes dash{to{stroke-dashoffset:-28}}
.fcore{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:12px;padding:14px 22px 14px 14px;border-radius:16px;background:rgb(var(--bg-rgb) / .8);border:1px solid rgb(var(--acc) / .35);box-shadow:0 0 60px -10px rgb(var(--acc) / .5);font-weight:800;z-index:2}
.fcore img{width:38px;height:38px;border-radius:10px;object-fit:cover}
.fnode{position:absolute;left:var(--x);top:var(--y);transform:translate(-50%,-50%);width:250px;padding:14px 16px;border-radius:16px;background:rgb(var(--bg-rgb) / .72);border:1px solid var(--line2);backdrop-filter:blur(10px);z-index:2;transition:border-color .3s,box-shadow .3s}
.fnode:hover,.fnode.lit{border-color:rgb(var(--acc) / .55);box-shadow:0 0 40px -12px rgb(var(--acc) / .7)}
.fnode b{display:flex;align-items:center;gap:8px;font-size:15px}.fnode b i{width:8px;height:8px;border-radius:50%;background:rgb(var(--acc));box-shadow:0 0 10px rgb(var(--acc))}
.fnode span{display:block;margin-top:6px;font:500 12px/1.5 var(--mono);color:var(--ink3)}.fnode em{display:inline-block;margin-top:8px;font:700 12px var(--mono);font-style:normal;color:rgb(var(--acc))}
/* table */
.chead{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line)}.chead .ic{color:rgb(var(--acc))}.chead b{font-size:15px}
.chead .tsearch{flex:0 1 240px;margin-left:auto;height:38px;border-radius:11px;font-size:13px}
.tbl-scroll{overflow-x:auto}.tbl{width:100%;border-collapse:collapse;font-size:14px}
.tbl th{text-align:left;font:600 10.5px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);padding:12px 18px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:13px 18px;border-bottom:1px solid rgb(255 255 255 / .045);white-space:nowrap;font-variant-numeric:tabular-nums}.tbl tr:last-child td{border-bottom:0}
.tbl td.mono{font:500 12.5px var(--mono);color:var(--ink2)}.tbl td.strong{font-weight:700}.tbl tbody tr{transition:background .2s}.tbl tbody tr:hover{background:rgb(255 255 255 / .025)}
.st{font:700 11px/1 var(--mono);padding:5px 9px;border-radius:999px;border:1px solid var(--line);color:var(--ink2);text-transform:lowercase}
.st-live,.st-hot,.st-new{color:rgb(var(--good));background:rgb(var(--good) / .1);border-color:rgb(var(--good) / .22)}.st-ok,.st-done{color:rgb(var(--acc));background:rgb(var(--acc) / .1);border-color:rgb(var(--acc) / .25)}
/* terminal */
.term{overflow:hidden}.term::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgb(255 255 255 / .018) 0 1px,transparent 1px 3px)}
.term pre{margin:0;padding:20px 22px;font:500 13.5px/1.85 var(--mono);color:var(--ink2);min-height:300px;white-space:pre-wrap;background:rgb(0 0 0 / .25)}.term pre b{color:rgb(var(--acc))}.term pre .hot{color:rgb(var(--good))}
.cur{display:inline-block;width:8px;height:15px;background:rgb(var(--acc));vertical-align:-2px;animation:blink 1s steps(1) infinite}
/* bento */
.bento{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.bento .b0,.bento .b3{grid-column:span 2}
.bento .big{display:block;font:900 34px/1 var(--sans);letter-spacing:-.04em;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.bento h3{margin:16px 0 6px;font-size:19px;letter-spacing:-.02em}.bento p{margin:0;color:var(--ink2);font-size:15px}
/* token */
.tokgrid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:14px;align-items:start}.tokgrid>*{min-width:0}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.ca-big{display:flex;gap:8px;align-items:center;padding:14px;border-radius:14px;background:rgb(0 0 0 / .35);border:1px solid var(--line2);font:500 13.5px/1 var(--mono);margin:18px 0}
.ca-big code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}.ca-big .ic{color:var(--ink3)}
.mstats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}
.mstats div{padding:16px;border-radius:14px;background:rgb(255 255 255 / .035);border:1px solid var(--line)}.mstats .k{font:600 10.5px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink3)}
.mstats b{display:block;margin-top:10px;font:800 22px/1 var(--sans);letter-spacing:-.03em;color:var(--ink2)}.mstats b.live{color:var(--ink)}
.chart{overflow:hidden}.chart iframe{display:block;width:100%;height:440px;border:0}
.faq{display:grid;gap:10px;max-width:820px}.faq details{padding:18px 22px}.faq summary{cursor:pointer;font-weight:700;list-style:none;display:flex;justify-content:space-between;gap:12px}.faq summary::after{content:"+";color:rgb(var(--acc));font:700 18px var(--mono)}.faq details[open] summary::after{content:"–"}.faq p{color:var(--ink2);margin:10px 0 0}
.closing{text-align:center;padding:140px 0 120px}.closing h2{margin:0 auto 18px;max-width:900px}.closing .lead{margin:0 auto 30px}.closing .ctas{justify-content:center}
footer{border-top:1px solid var(--line);padding:28px 0 40px;color:var(--ink3);font-size:13px}footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center}footer .links{display:flex;gap:18px}footer a:hover{color:var(--ink)}
.sdots{position:fixed;right:18px;top:50%;transform:translateY(-50%);z-index:40;display:flex;flex-direction:column;gap:12px}
.sdots a{width:8px;height:8px;border-radius:50%;background:rgb(255 255 255 / .2);transition:.3s}.sdots a.on{background:rgb(var(--acc));box-shadow:0 0 12px rgb(var(--acc));transform:scale(1.3)}
.bnav{display:none;position:fixed;left:12px;right:12px;bottom:12px;z-index:50;padding:6px;border-radius:18px;background:rgb(var(--bg-rgb) / .72);border:1px solid var(--line);backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%)}
.bnav-in{display:grid;grid-auto-flow:column;grid-auto-columns:1fr}.bnav a{display:grid;justify-items:center;gap:4px;padding:7px 0;font:600 10.5px/1 var(--sans);color:var(--ink3);border-radius:12px;overflow:hidden;white-space:nowrap}
.bnav a.on{color:var(--ink);background:rgb(255 255 255 / .06)}.bnav a.on .ic{color:rgb(var(--acc))}
.reveal{opacity:0;transform:translateY(26px);transition:opacity .8s ease,transform .8s ease}.reveal.in{opacity:1;transform:none}
.toast{position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:60;background:rgb(var(--bg-rgb) / .9);border:1px solid rgb(var(--acc) / .4);padding:10px 16px;border-radius:12px;font:600 13px var(--mono);opacity:0;transition:.2s;pointer-events:none}.toast.on{opacity:1}
@media(max-width:1060px){.pills{display:none}.top-row{justify-content:space-between}.coin{right:4%;opacity:.5}.fnode{width:200px}}
@media(max-width:860px){
.top .chip.px,.top .live,.sdots,.ticker,.coin,.glow{display:none}.bnav{display:block}
.wrap{width:calc(100% - 28px)}.hero{padding:120px 0 70px}.eyebrow{font-size:10.5px;letter-spacing:.03em;padding:7px 10px}
section{padding-top:90px}.shead{flex-direction:column;align-items:flex-start}.stats{grid-template-columns:1fr 1fr}.stat .v{font-size:24px}
.app{grid-template-columns:1fr}.side{display:none}.drow{flex-direction:column}
.flow{height:auto;padding:18px;display:grid;gap:10px}.flines{display:none}.fcore,.fnode{position:relative;left:auto;top:auto;transform:none;width:auto}.fcore{justify-self:start}
.bento{grid-template-columns:1fr}.bento>div{grid-column:auto!important}.tokgrid{grid-template-columns:minmax(0,1fr)}.top .btn.go{font-size:0;gap:0}.top .btn.go::after{content:"Buy";font-size:13px;margin-left:6px}.brand{min-width:0;overflow:hidden;text-overflow:ellipsis}.mstats{grid-template-columns:1fr 1fr 1fr}.mstats b{font-size:17px}
.chead{flex-wrap:wrap}.chead .tsearch{flex:1 1 100%;margin:0}footer{padding-bottom:110px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important}.reveal{opacity:1;transform:none}}
</style></head><body>
<canvas id="bg"></canvas><div class="glow" id="glow"></div>
<header class="top"><div class="top-row"><a class="brand" href="#top"><img src="${esc(logo)}" alt="">${esc(brand.name)}</a>
<nav class="pills">${navs.map(([id, n], k) => `<a href="#${id}" data-to="${id}"${k === 0 ? ' class="on"' : ""}>${esc(n)}</a>`).join("")}</nav>
${ca ? `<a class="chip live" href="${pump}" target="_blank" rel="noopener"><span class="dot"></span>Live on pump.fun</a>` : `<span class="chip live warn"><span class="dot"></span>Launching soon</span>`}
<span class="chip px" id="px" hidden>≡ <span id="pxv"></span></span>
${pump ? `<a class="btn go sm" href="${pump}" target="_blank" rel="noopener">${IC.bolt}Get $${sym}</a>` : `<a class="btn go sm" href="#token">${IC.bolt}$${sym}</a>`}</div>
<div class="ticker"><b>${IC.pulse}Live now</b><div class="ticker-wrap"><div class="ticker-track" id="tick"></div></div></div></header>
<main>
<section class="hero" id="top"><div class="wrap"><div class="hero-in">
<div class="eyebrow"><span class="dot"></span>${esc(plan.chip)}${brand.x?.handle ? ` · built by @${esc(brand.x.handle)}` : ""}</div>
<h1>${hl(plan.hero.headline, plan.hero.highlight)}</h1><p class="lead">${esc(plan.hero.subhead)}</p>
<div class="ctas"><a class="btn go" href="#s${demoIdx}">${IC.bolt}${esc(plan.hero.cta)}</a><a class="btn" href="#s0">${IC.link}${esc(plan.hero.cta2)}</a></div>
<div class="ca-row"># CA ${ca ? `<code>${esc(shortCa)}</code><button class="btn" data-copy="${esc(ca)}">${IC.copy}Copy</button>` : `<code>drops here at launch</code>`}</div>
</div></div><div class="coin"><img src="${esc(logo)}" alt="${esc(brand.name)}"></div><div class="scroll-cue">Scroll<i></i></div></section>
<div class="wrap"><div class="stats">${plan.stats.slice(0, 4).map((s, i) => `<div class="card stat reveal"><div class="k">${[IC.pulse, IC.layers, IC.chart, IC.bolt][i]}${esc(s.label)}</div><div class="v" data-stat="${i}">0</div></div>`).join("")}</div></div>
${plan.sections.map((s, i) => sectionHtml(s, i, ctx)).join("")}
<section id="token" data-nav="$${sym}"><div class="wrap">
<div class="shead"><div><div class="kicker">${pad2(plan.sections.length + 1)} · The token</div><h2><em>$${sym}</em></h2><p class="sub">${esc(plan.token.text)}${brand.x?.handle ? ` Built by @${esc(brand.x.handle)}.` : ""}</p></div></div>
<div class="tokgrid"><div class="card pad top-glow reveal">
<div class="chips">${ca ? `<span class="pill good"><span class="dot" style="width:6px;height:6px;border-radius:50%;background:currentColor"></span>Live on pump.fun</span>` : `<span class="pill">Launching soon</span>`}<span class="pill">${IC.layers}pump.fun</span><span class="pill">Fair launch</span></div>
<div class="ca-big"># <code>${ca ? esc(ca) : "Contract address appears here at launch"}</code>${ca ? `<button class="btn sm" data-copy="${esc(ca)}">${IC.copy}Copy</button>` : ""}</div>
<div class="mstats"><div><span class="k">Price</span><b id="m-price">at launch</b></div><div><span class="k">Market cap</span><b id="m-mc">at launch</b></div><div><span class="k">24h volume</span><b id="m-vol">at launch</b></div></div>
<div class="ctas">${pump ? `<a class="btn go" href="${pump}" target="_blank" rel="noopener">${IC.bolt}Buy on pump.fun</a>` : `<span class="btn go" style="opacity:.6">${IC.bolt}Live soon</span>`}${xUrl ? `<a class="btn" href="${esc(xUrl)}" target="_blank" rel="noopener">𝕏 Follow</a>` : ""}</div></div>
<div class="card pad reveal"><div class="chead" style="padding:0 0 14px;margin-bottom:6px">${IC.pulse}<b>Good to know</b><span class="pill acc" style="margin-left:auto" id="m-txs">${ca ? "loading" : "waiting for launch"}</span></div>
<div class="faq" style="gap:0">${plan.faq.slice(0, 3).map((f) => `<details style="padding:14px 0;border-bottom:1px solid var(--line)"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}</div></div></div>
${ca ? `<div class="card chart reveal" style="margin-top:14px"><div class="chead">${IC.chart}<b>Chart</b><span class="pill acc" style="margin-left:auto">DexScreener</span></div><iframe loading="lazy" src="https://dexscreener.com/solana/${esc(ca)}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15" title="chart"></iframe></div>` : ""}
</div></section>
<section class="closing"><div class="wrap"><h2>${hl(plan.closing.title, plan.closing.highlight)}</h2><p class="lead">${esc(plan.closing.text)}</p>
<div class="ctas"><a class="btn go" href="${pump || `#s${demoIdx}`}"${pump ? ' target="_blank" rel="noopener"' : ""}>${IC.bolt}${pump ? `Get $${sym}` : esc(plan.hero.cta)}</a><a class="btn" href="#token">${IC.link}$${sym}</a></div></div></section>
</main>
<footer><div class="wrap"><span>© 2026 ${esc(brand.name)} · $${sym} · Preview data is simulated; coin stats are live from the chain. Not financial advice.</span><span class="links">${xUrl ? `<a href="${esc(xUrl)}" target="_blank" rel="noopener">X</a>` : ""}${pump ? `<a href="${pump}" target="_blank" rel="noopener">pump.fun</a>` : ""}<a href="#token">$${sym}</a></span></div></footer>
<nav class="sdots">${navs.map(([id]) => `<a href="#${id}" data-to="${id}"></a>`).join("")}</nav>
<nav class="bnav"><div class="bnav-in">${navs.slice(0, 6).map(([id, n], k) => `<a href="#${id}" data-to="${id}">${k === 0 ? IC.home : id === "token" ? IC.coin : IC.dot}${esc(n)}</a>`).join("")}</div></nav>
<div class="toast" id="toast">Copied</div>
<script>
const PLAN=${JSON.stringify({ ticker: plan.ticker, stats: plan.stats, ca: ca || "" }).replace(/</g, "\\u003c")};
const R=(a,b)=>Math.floor(a+Math.random()*(b-a));const B58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const rs=(n,set)=>Array.from({length:n},()=>set[R(0,set.length)]).join("");
const fill=(t)=>t.replace(/\\{n\\}/g,()=>R(2,90)).replace(/\\{sol\\}/g,()=>(Math.random()*9+.1).toFixed(2)).replace(/\\{addr\\}/g,()=>rs(4,B58)+"…"+rs(4,B58)).replace(/\\{hex\\}/g,()=>rs(6,"0123456789abcdef")).replace(/\\{pct\\}/g,()=>R(40,99)).replace(/\\{[a-z]+\\}/g,"");
const esc=(s)=>String(s).replace(/[&<>]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"})[c]);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
// ticker
const tk=document.getElementById("tick");const ago=["now","now","12s ago","46s ago","1m ago"];
const line=()=>PLAN.ticker.map((t)=>"<span><b>"+esc(fill(t))+"</b> · "+ago[R(0,ago.length)]+"</span>").join("");tk.innerHTML=line()+line();
// counters
const start=Date.now();function stats(){PLAN.stats.forEach((s,i)=>{const el=document.querySelector('[data-stat="'+i+'"]');if(!el)return;const grow=s.ratePerMin*(Date.now()-start)/60000;const shown=el.dataset.in?s.value+grow:(el._v=(el._v||0)+(s.value-(el._v||0))*.08);if(!el.dataset.in&&Math.abs(s.value-el._v)<s.value*.002)el.dataset.in=1;el.innerHTML=Number(shown).toLocaleString(undefined,{minimumFractionDigits:s.decimals,maximumFractionDigits:s.decimals})+(s.unit?"<small>"+esc(s.unit)+"</small>":"")});requestAnimationFrame(stats)}stats();
// reveal + terminal start
const io=new IntersectionObserver((es)=>es.forEach((e)=>{if(e.isIntersecting){e.target.classList.add("in");const pre=e.target.querySelector("pre[data-lines]");if(pre&&!pre.dataset.go){pre.dataset.go=1;typeLines(pre)}}}),{threshold:.12});document.querySelectorAll(".reveal").forEach((el)=>io.observe(el));
async function typeLines(pre){const lines=JSON.parse(pre.dataset.lines||"[]");for(;;){pre.innerHTML="";for(const l of lines){const row=document.createElement("div");pre.appendChild(row);const txt=fill(l);for(let i=1;i<=txt.length;i+=2){row.innerHTML="<b>›</b> "+esc(txt.slice(0,i))+'<span class="cur"></span>';await sleep(12)}row.innerHTML="<b>›</b> "+esc(txt);await sleep(R(350,900))}pre.lastChild&&(pre.lastChild.innerHTML+=' <span class="cur"></span>');await sleep(4000)}}
// active section: pills, side dots, bottom nav
const secs=[...document.querySelectorAll("main > section[id]")];const navLinks=[...document.querySelectorAll("[data-to]")];
function active(){let cur=secs[0]?.id;for(const s of secs){if(s.getBoundingClientRect().top<innerHeight*.4)cur=s.id}navLinks.forEach((a)=>a.classList.toggle("on",a.dataset.to===cur))}addEventListener("scroll",active,{passive:true});active();
// demo
document.querySelectorAll(".demo").forEach((d)=>{const btn=d.querySelector("button"),inp=d.querySelector("input"),rows=[...d.querySelectorAll(".dsteps div")],bar=d.querySelector(".dbar i"),out=d.querySelector(".dout");
btn.onclick=async()=>{const v=inp.value.trim()||inp.placeholder;btn.disabled=true;out.className="dout";out.textContent="Working…";rows.forEach((r)=>r.className="");bar.style.width="0";
for(let k=0;k<rows.length;k++){rows[k].className="on";await sleep(R(550,1100));rows[k].className="ok";bar.style.width=((k+1)/rows.length*100)+"%"}
out.className="dout done";out.textContent=fill(d.dataset.result.replace(/\\{input\\}/g,v));btn.disabled=false}});
// flow: light the nodes one by one
const fn=[...document.querySelectorAll(".fnode")];if(fn.length){let k=0;setInterval(()=>{fn.forEach((n,i)=>n.classList.toggle("lit",i===k%fn.length));k++},1400)}
// table search + blinking live rows
document.querySelectorAll(".tsearch").forEach((s)=>{const rows=[...s.closest(".card").querySelectorAll("tbody tr")];s.oninput=()=>{const q=s.value.toLowerCase();rows.forEach((r)=>{r.hidden=q&&!r.textContent.toLowerCase().includes(q)})}});
document.querySelectorAll(".st-live,.st-hot").forEach((s,i)=>setInterval(()=>{s.style.opacity=s.style.opacity==="0.45"?"1":"0.45"},900+i*90));
// copy
const toast=document.getElementById("toast");document.querySelectorAll("[data-copy]").forEach((b)=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.copy)}catch(e){}toast.classList.add("on");setTimeout(()=>toast.classList.remove("on"),1400)});
// live coin stats from DexScreener
const usd=(n)=>n>=1e6?"$"+(n/1e6).toFixed(2)+"M":n>=1e3?"$"+(n/1e3).toFixed(1)+"K":"$"+Number(n).toFixed(n<1?6:2);
async function coin(){if(!PLAN.ca)return;try{const r=await fetch("https://api.dexscreener.com/latest/dex/tokens/"+PLAN.ca);const j=await r.json();const p=(j.pairs||[]).sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];if(!p)return;
const set=(id,v)=>{const el=document.getElementById(id);el.textContent=v;el.classList.add("live")};set("m-price",usd(+p.priceUsd));set("m-mc",usd(p.marketCap||p.fdv||0));set("m-vol",usd(p.volume?.h24||0));
const tx=p.txns?.h24||{};document.getElementById("m-txs").textContent=(tx.buys||0)+" buys · "+(tx.sells||0)+" sells";const px=document.getElementById("px");px.hidden=false;document.getElementById("pxv").textContent=usd(p.marketCap||p.fdv||0)+" mc"}catch(e){}}
coin();setInterval(coin,30000);
// pointer glow
const gl=document.getElementById("glow");addEventListener("pointermove",(e)=>{gl.style.left=e.clientX+"px";gl.style.top=e.clientY+"px"});
// background: a slowly turning globe of linked nodes with soft bokeh, in the coin colour
const cv=document.getElementById("bg"),g=cv.getContext("2d");const css=getComputedStyle(document.documentElement);const AC=css.getPropertyValue("--acc").trim().split(/ +/).map(Number),A2=css.getPropertyValue("--acc2").trim().split(/ +/).map(Number);
let W,H,DPR=Math.min(devicePixelRatio||1,2);function rz(){W=innerWidth;H=innerHeight;cv.width=W*DPR;cv.height=H*DPR;g.setTransform(DPR,0,0,DPR,0,0)}rz();addEventListener("resize",rz);
const N=innerWidth<860?70:120;const P=[];for(let i=0;i<N;i++){const u=Math.random()*2-1,th=Math.random()*Math.PI*2,r=.75+Math.random()*.5,s=Math.sqrt(1-u*u);P.push({x:s*Math.cos(th)*r,y:u*r,z:s*Math.sin(th)*r,b:Math.random()<.24,w:Math.random()<.35})}
const E=[];for(let i=0;i<N;i++)for(let j=i+1;j<N;j++){const a=P[i],b=P[j];if(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<.42)E.push([i,j])}
const col=(c,a)=>"rgba("+c[0]+","+c[1]+","+c[2]+","+a+")";let sy=0;addEventListener("scroll",()=>{sy=scrollY},{passive:true});const t0=performance.now();
function draw(now){const t=(now-t0)/1000;g.clearRect(0,0,W,H);const mob=W<860,cx=mob?W*.5:W*.7,cy=H*.46-sy*.08,RA=Math.min(W,H)*(mob?.55:.5);
const hg=g.createRadialGradient(cx,cy,0,cx,cy,RA*.9);hg.addColorStop(0,col(AC,.22));hg.addColorStop(1,col(AC,0));g.fillStyle=hg;g.fillRect(0,0,W,H);
const ry=t*.06,rx=.35+Math.sin(t*.1)*.08,cY=Math.cos(ry),sY=Math.sin(ry),cX=Math.cos(rx),sX=Math.sin(rx);
const Q=P.map((p)=>{const x=p.x*cY+p.z*sY,z1=-p.x*sY+p.z*cY,y=p.y*cX-z1*sX,z=p.y*sX+z1*cX,f=2.4/(2.4+z);return{x:cx+x*RA*f,y:cy+y*RA*f,z,f}});
g.lineWidth=1;for(const[i,j]of E){const a=Q[i],b=Q[j],d=(2-(a.z+b.z)/2)/3;g.strokeStyle=col(AC,.1+d*.28);g.beginPath();g.moveTo(a.x,a.y);g.lineTo(b.x,b.y);g.stroke()}
P.forEach((p,i)=>{const q=Q[i],d=(1.6-q.z)/2.6;if(p.b){const r=(10+d*16)*q.f,c=p.w?[235,235,240]:A2;const rg=g.createRadialGradient(q.x,q.y,0,q.x,q.y,r);rg.addColorStop(0,col(c,.55*d+.1));rg.addColorStop(.6,col(c,.25*d));rg.addColorStop(1,col(c,0));g.fillStyle=rg;g.beginPath();g.arc(q.x,q.y,r,0,7);g.fill()}
else{g.fillStyle=col(AC,.35+d*.6);g.beginPath();g.arc(q.x,q.y,1.2+d*1.6,0,7);g.fill()}});requestAnimationFrame(draw)}
if(!matchMedia("(prefers-reduced-motion: reduce)").matches)requestAnimationFrame(draw);
</script></body></html>`;
}
