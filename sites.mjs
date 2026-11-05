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
Pick a dark palette that fits the idea (bg very dark, surface slightly lighter, one bright accent, one soft second accent).`;

/** Claude's plan, or a plan written from the coin's own text. */
export async function planSite(brand) {
  if (aiReady()) {
    const prompt = `Coin: ${brand.name} ($${brand.symbol})\nPitch: ${brand.tagline || ""}\nDescription: ${brand.description || ""}\n${brand.siteDirection ? `Extra direction from the owner: ${brand.siteDirection}\n` : ""}${brand.x?.handle ? `Built by @${brand.x.handle}.\n` : ""}Write the plan. Use these 4 modules once each, in a sensible order: steps, demo, table, bento (or terminal instead of table if the product is technical).`;
    const plan = await askJson(PlanSchema, SYSTEM, prompt, 16000);
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

function sectionHtml(s, i) {
  const head = `<div class="shead"><span class="kick">${esc(s.kicker)}</span><h2>${hl(s.title, s.highlight)}</h2><p>${esc(s.text)}</p></div>`;
  let body = "";
  if (s.module === "steps") {
    body = `<div class="steps">${s.items.map((it, n) => `<div class="step glass"><b>${String(n + 1).padStart(2, "0")}</b><h3>${esc(it.name)}</h3><p>${esc(it.detail)}</p>${it.value ? `<span class="val">${esc(it.value)}</span>` : ""}</div>`).join("")}</div>`;
  } else if (s.module === "demo") {
    const d = s.input;
    body = `<div class="demo glass" data-result="${esc(d.result)}" data-steps="${esc(JSON.stringify(d.steps?.length ? d.steps : ["Working", "Done"]))}">
      <label>${esc(d.label)}</label><div class="drow"><input placeholder="${esc(d.placeholder)}" maxlength="80"><button class="btn">${esc(d.button || "Run")}</button></div>
      <div class="dsteps"></div><div class="dout"></div></div>`;
  } else if (s.module === "table") {
    body = `<div class="glass tablewrap"><table><tr>${s.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${s.rows.map((r) => `<tr>${r.map((c, k) => `<td>${k === r.length - 1 ? `<span class="st st-${esc(String(c).toLowerCase().replace(/[^a-z]/g, ""))}">${esc(c)}</span>` : esc(c)}</td>`).join("")}</tr>`).join("")}</table></div>`;
  } else if (s.module === "terminal") {
    body = `<div class="term glass"><div class="tbar"><i></i><i></i><i></i></div><pre data-lines="${esc(JSON.stringify(s.lines))}"></pre></div>`;
  } else {
    body = `<div class="bento">${s.items.map((it, n) => `<div class="glass b${n}"><span class="val">${esc(it.value)}</span><h3>${esc(it.name)}</h3><p>${esc(it.detail)}</p></div>`).join("")}</div>`;
  }
  return `<section id="s${i}" class="sec reveal">${head}${body}</section>`;
}

/**
 * page = { plan, brand, ca, xUrl, siteUrl, logo, banner } (logo / banner = image URLs)
 */
export function renderSite({ plan, brand, ca, xUrl, siteUrl, logo, banner }) {
  const p = plan.palette ?? {};
  const bg = hex(p.bg, "#08090c"), surface = hex(p.surface, "#11141a"), accent = hex(p.accent, "#d5f26c"), accent2 = hex(p.accent2, "#7da7ff");
  const title = `${brand.name} ($${brand.symbol})`;
  const desc = plan.hero?.subhead || brand.tagline || brand.description || brand.name;
  const pump = ca ? `https://pump.fun/coin/${ca}` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(banner)}"><meta property="og:url" content="${esc(siteUrl)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(banner)}"><link rel="icon" href="${esc(logo)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:${bg};--sf:${surface};--ac:${accent};--ac2:${accent2};--tx:#eef1f6;--mu:#8e97a8;--ln:rgba(255,255,255,.08);--mono:"JetBrains Mono",ui-monospace,monospace}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.55 Inter,system-ui,sans-serif;overflow-x:hidden}
a{color:inherit}canvas#bg{position:fixed;inset:0;z-index:-1;width:100%;height:100%}
.glow{position:fixed;width:900px;height:900px;border-radius:50%;filter:blur(120px);opacity:.16;z-index:-1;pointer-events:none}
.g1{background:var(--ac);top:-420px;right:-300px}.g2{background:var(--ac2);bottom:-500px;left:-350px;opacity:.1}
.wrap{max-width:1160px;margin:0 auto;padding:0 20px}
nav{position:sticky;top:0;z-index:20;backdrop-filter:blur(14px);background:color-mix(in srgb,var(--bg) 70%,transparent);border-bottom:1px solid var(--ln)}
nav .wrap{display:flex;align-items:center;gap:22px;height:64px}nav .logo{display:flex;align-items:center;gap:10px;font-weight:800;text-decoration:none}
nav .logo img{width:32px;height:32px;border-radius:9px}nav .links{display:flex;gap:18px;margin-left:auto;font-size:14px;color:var(--mu)}nav .links a{text-decoration:none}nav .links a:hover{color:var(--tx)}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--ac);color:#0b0c0f;border:0;border-radius:12px;padding:12px 18px;font:700 15px Inter,sans-serif;cursor:pointer;text-decoration:none;box-shadow:0 0 0 0 var(--ac);transition:.2s}
.btn:hover{transform:translateY(-1px);box-shadow:0 8px 30px -8px var(--ac)}.btn.ghost{background:transparent;color:var(--tx);border:1px solid var(--ln)}.btn.sm{padding:8px 13px;font-size:13px;border-radius:10px}
.glass{background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.015));border:1px solid var(--ln);border-radius:20px;backdrop-filter:blur(8px)}
em{font-style:normal;background:linear-gradient(90deg,var(--ac),var(--ac2));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero{padding:90px 0 40px;display:grid;grid-template-columns:1.25fr .75fr;gap:40px;align-items:center}
.chip{display:inline-flex;align-items:center;gap:8px;font:600 12.5px var(--mono);color:var(--mu);border:1px solid var(--ln);border-radius:99px;padding:6px 12px;margin-bottom:22px}
.chip i{width:7px;height:7px;border-radius:50%;background:var(--ac);box-shadow:0 0 10px var(--ac);animation:pl 1.6s infinite}@keyframes pl{50%{opacity:.35}}
.kick{font:700 12.5px var(--mono);color:var(--ac);letter-spacing:1.5px;text-transform:uppercase}
h1{font-size:clamp(42px,6.4vw,78px);line-height:1.02;letter-spacing:-2.5px;margin:12px 0 18px;font-weight:800}
.hero p.sub{font-size:19px;color:var(--mu);max-width:560px;margin:0 0 28px}.ctas{display:flex;gap:12px;flex-wrap:wrap}
.hcards{display:grid;gap:14px}.hcard{padding:20px;position:relative;overflow:hidden}.hcard span{color:var(--mu);font-size:13px}.hcard b{display:block;font:700 30px var(--mono);margin:4px 0;letter-spacing:-1px}
.hcard small{color:var(--mu)}.hcard .bar{height:6px;background:var(--ln);border-radius:9px;margin-top:12px;overflow:hidden}.hcard .bar i{display:block;height:100%;width:40%;background:linear-gradient(90deg,var(--ac),var(--ac2));border-radius:9px;animation:fill 6s ease-in-out infinite alternate}
@keyframes fill{to{width:92%}}
.heroimg{width:100%;aspect-ratio:1;border-radius:28px;border:1px solid var(--ln);display:block;box-shadow:0 30px 80px -30px var(--ac)}
.tick{border-block:1px solid var(--ln);overflow:hidden;white-space:nowrap;margin:30px 0;padding:14px 0;mask:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent)}
.tick div{display:inline-block;animation:mq 60s linear infinite}.tick span{font:500 13.5px var(--mono);color:var(--mu);margin-right:46px}.tick span b{color:var(--ac);margin-right:8px}
@keyframes mq{to{transform:translateX(-50%)}}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:30px 0 40px}.stat{padding:22px}.stat b{display:block;font:700 34px var(--mono);letter-spacing:-1.5px}.stat span{color:var(--mu);font-size:13.5px}
.sec{padding:70px 0}.shead{max-width:680px;margin-bottom:34px}.shead h2{font-size:clamp(30px,4vw,46px);letter-spacing:-1.5px;line-height:1.08;margin:10px 0 12px}.shead p{color:var(--mu);font-size:17px;margin:0}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;counter-reset:s}.step{padding:22px;position:relative}.step b{font:700 13px var(--mono);color:var(--ac)}
.step h3{margin:14px 0 6px;font-size:18px}.step p{margin:0;color:var(--mu);font-size:14.5px}.val{display:inline-block;margin-top:12px;font:700 13px var(--mono);color:var(--ac2)}
.step:not(:last-child)::after{content:"";position:absolute;right:-14px;top:50%;width:14px;height:2px;background:linear-gradient(90deg,var(--ac),transparent)}
.demo{padding:26px;max-width:760px}.demo label{color:var(--mu);font-size:14px}.drow{display:flex;gap:10px;margin-top:10px}
.drow input{flex:1;background:rgba(0,0,0,.35);border:1px solid var(--ln);border-radius:12px;padding:13px 14px;color:var(--tx);font:15px Inter,sans-serif;min-width:0}
.drow input:focus{outline:none;border-color:var(--ac)}.dsteps{display:grid;gap:8px;margin-top:18px}.dsteps div{font:500 14px var(--mono);color:var(--mu);display:flex;gap:10px;align-items:center}
.dsteps div i{width:16px;height:16px;border-radius:50%;border:2px solid var(--ln);display:inline-block}.dsteps div.on i{border-color:var(--ac);border-top-color:transparent;animation:sp .7s linear infinite}
.dsteps div.ok{color:var(--tx)}.dsteps div.ok i{background:var(--ac);border-color:var(--ac)}@keyframes sp{to{transform:rotate(360deg)}}
.dout{margin-top:14px;font:600 14.5px var(--mono);color:var(--ac);min-height:22px}
.tablewrap{overflow-x:auto;padding:8px}table{width:100%;border-collapse:collapse;font-size:14.5px}th{text-align:left;color:var(--mu);font:600 11.5px var(--mono);text-transform:uppercase;letter-spacing:1px;padding:12px 14px}
td{padding:13px 14px;border-top:1px solid var(--ln);white-space:nowrap}td:nth-child(2){font-family:var(--mono);font-size:13px;color:var(--mu)}
.st{font:700 11.5px var(--mono);padding:4px 10px;border-radius:99px;border:1px solid var(--ln);text-transform:uppercase}.st-live,.st-hot{color:var(--ac);border-color:color-mix(in srgb,var(--ac) 40%,transparent)}.st-ok{color:#5fdc8a}.st-new{color:var(--ac2)}
.term{max-width:860px;overflow:hidden}.tbar{display:flex;gap:7px;padding:14px 16px;border-bottom:1px solid var(--ln)}.tbar i{width:11px;height:11px;border-radius:50%;background:var(--ln)}
.term pre{margin:0;padding:20px;font:500 13.5px/1.8 var(--mono);color:var(--mu);min-height:260px;white-space:pre-wrap}.term pre b{color:var(--ac)}
.bento{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.bento>div{padding:24px}.bento .b0{grid-column:span 2}.bento .b3{grid-column:span 2}.bento h3{margin:10px 0 6px;font-size:19px}.bento p{margin:0;color:var(--mu)}
.bento .val{font-size:26px;margin:0;color:var(--ac);letter-spacing:-1px}
.token{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:34px;align-items:center}.token h2{margin:0 0 10px;font-size:32px;letter-spacing:-1px}.token p{color:var(--mu);margin:0}
.ca{font:600 13.5px var(--mono);background:rgba(0,0,0,.35);border:1px solid var(--ln);border-radius:12px;padding:14px;word-break:break-all;margin-bottom:12px;display:flex;gap:10px;align-items:center}
.ca span{flex:1}.soon{color:var(--mu)}
.faq{display:grid;gap:10px;max-width:780px}.faq details{padding:18px 20px}.faq summary{cursor:pointer;font-weight:700}.faq p{color:var(--mu);margin:10px 0 0}
.close{text-align:center;padding:90px 20px}.close h2{font-size:clamp(34px,5vw,58px);letter-spacing:-2px;margin:0 0 14px}.close p{color:var(--mu);font-size:18px;margin:0 auto 26px;max-width:560px}
footer{border-top:1px solid var(--ln);padding:28px 0;color:var(--mu);font-size:13px}footer .wrap{display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.reveal{opacity:0;transform:translateY(24px);transition:opacity .7s ease,transform .7s ease}.reveal.in{opacity:1;transform:none}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--sf);border:1px solid var(--ln);padding:10px 16px;border-radius:10px;opacity:0;transition:.2s}.toast.on{opacity:1}
@media(max-width:860px){.hero{grid-template-columns:1fr;padding-top:50px}.stats{grid-template-columns:1fr 1fr}.bento{grid-template-columns:1fr}.bento>div{grid-column:auto!important}.token{grid-template-columns:1fr}nav .links{display:none}.step::after{display:none}}
</style></head><body>
<canvas id="bg"></canvas><div class="glow g1"></div><div class="glow g2"></div>
<nav><div class="wrap"><a class="logo" href="#"><img src="${esc(logo)}" alt="">${esc(brand.name)}</a>
<div class="links">${plan.sections.map((s, i) => `<a href="#s${i}">${esc(s.nav)}</a>`).join("")}<a href="#token">$${esc(brand.symbol)}</a></div>
${pump ? `<a class="btn sm" href="${pump}" target="_blank" rel="noopener">Buy $${esc(brand.symbol)}</a>` : `<a class="btn sm" href="#token">$${esc(brand.symbol)}</a>`}</div></nav>
<main class="wrap">
<header class="hero"><div><div class="chip"><i></i>${esc(plan.chip)}</div><div class="kick">${esc(plan.hero.kicker)}</div>
<h1>${hl(plan.hero.headline, plan.hero.highlight)}</h1><p class="sub">${esc(plan.hero.subhead)}</p>
<div class="ctas"><a class="btn" href="#s1">${esc(plan.hero.cta)} →</a><a class="btn ghost" href="#s0">${esc(plan.hero.cta2)}</a></div></div>
<div class="hcards"><img class="heroimg" src="${esc(logo)}" alt="">${plan.heroCards.slice(0, 2).map((c) => `<div class="hcard glass"><span>${esc(c.label)}</span><b>${esc(c.value)}</b><small>${esc(c.detail)}</small><div class="bar"><i></i></div></div>`).join("")}</div></header>
<div class="tick"><div id="tick"></div></div>
<div class="stats">${plan.stats.slice(0, 4).map((s, i) => `<div class="stat glass"><b data-stat="${i}">0</b><span>${esc(s.label)}</span></div>`).join("")}</div>
${plan.sections.map(sectionHtml).join("")}
<section id="token" class="sec reveal"><div class="token glass"><div><span class="kick">The coin</span><h2>${esc(plan.token.title)}</h2><p>${esc(plan.token.text)}</p></div>
<div>${ca ? `<div class="ca"><span id="ca">${esc(ca)}</span><button class="btn sm" id="copy">Copy</button></div><div class="ctas"><a class="btn" href="${pump}" target="_blank" rel="noopener">Buy on pump.fun</a><a class="btn ghost" href="https://dexscreener.com/solana/${esc(ca)}" target="_blank" rel="noopener">Chart</a>${xUrl ? `<a class="btn ghost" href="${esc(xUrl)}" target="_blank" rel="noopener">X</a>` : ""}</div>`
    : `<div class="ca soon"><span>Contract address appears here at launch</span></div>${xUrl ? `<a class="btn ghost" href="${esc(xUrl)}" target="_blank" rel="noopener">Follow on X</a>` : ""}`}</div></div></section>
<section class="sec reveal"><div class="shead"><span class="kick">Questions</span><h2>Good to know</h2></div><div class="faq">${plan.faq.map((f) => `<details class="glass"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}</div></section>
<section class="close reveal"><h2>${hl(plan.closing.title, plan.closing.highlight)}</h2><p>${esc(plan.closing.text)}</p>${pump ? `<a class="btn" href="${pump}" target="_blank" rel="noopener">Get $${esc(brand.symbol)}</a>` : `<a class="btn" href="#s1">${esc(plan.hero.cta)}</a>`}</section>
</main>
<footer><div class="wrap"><img src="${esc(logo)}" alt="" style="width:24px;height:24px;border-radius:6px"><b>${esc(brand.name)}</b><span>$${esc(brand.symbol)} · fair launch on pump.fun · not financial advice</span><span style="flex:1"></span>${xUrl ? `<a href="${esc(xUrl)}" target="_blank" rel="noopener">X</a>` : ""}</div></footer>
<div class="toast" id="toast">Copied</div>
<script>
const PLAN=${JSON.stringify({ ticker: plan.ticker, stats: plan.stats }).replace(/</g, "\\u003c")};
const R=(a,b)=>Math.floor(a+Math.random()*(b-a));const B58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const rs=(n,set)=>Array.from({length:n},()=>set[R(0,set.length)]).join("");
const fill=(t)=>t.replace(/\\{n\\}/g,()=>R(2,90)).replace(/\\{sol\\}/g,()=>(Math.random()*9+.1).toFixed(2)).replace(/\\{addr\\}/g,()=>rs(4,B58)+"…"+rs(4,B58)).replace(/\\{hex\\}/g,()=>rs(6,"0123456789abcdef")).replace(/\\{pct\\}/g,()=>R(40,99)).replace(/\\{[a-z]+\\}/g,"");
const esc=(s)=>String(s).replace(/[&<>]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"})[c]);
const tk=document.getElementById("tick");const line=()=>PLAN.ticker.map((t)=>"<span><b>●</b>"+esc(fill(t))+"</span>").join("");tk.innerHTML=line()+line();
const start=Date.now();function stats(){PLAN.stats.forEach((s,i)=>{const el=document.querySelector('[data-stat="'+i+'"]');if(!el)return;const grow=s.ratePerMin*(Date.now()-start)/60000;const shown=el.dataset.in?s.value+grow:(el._v=(el._v||0)+(s.value-(el._v||0))*.08);if(!el.dataset.in&&Math.abs(s.value-el._v)<s.value*.002)el.dataset.in=1;el.textContent=Number(shown).toLocaleString(undefined,{minimumFractionDigits:s.decimals,maximumFractionDigits:s.decimals})+(s.unit?" "+s.unit:"")});requestAnimationFrame(stats)}stats();
const io=new IntersectionObserver((es)=>es.forEach((e)=>{if(e.isIntersecting){e.target.classList.add("in");const pre=e.target.querySelector("pre[data-lines]");if(pre&&!pre.dataset.go){pre.dataset.go=1;typeLines(pre)}}}),{threshold:.15});document.querySelectorAll(".reveal").forEach((el)=>io.observe(el));
async function typeLines(pre){const lines=JSON.parse(pre.dataset.lines||"[]");for(;;){pre.innerHTML="";for(const l of lines){const row=document.createElement("div");pre.appendChild(row);const t="<b>›</b> "+esc(fill(l));row.innerHTML=t;row.style.opacity=0;await new Promise(r=>setTimeout(r,60));row.style.transition="opacity .3s";row.style.opacity=1;await new Promise(r=>setTimeout(r,R(500,1100)))}await new Promise(r=>setTimeout(r,4000))}}
document.querySelectorAll(".demo").forEach((d)=>{const btn=d.querySelector("button"),inp=d.querySelector("input"),st=d.querySelector(".dsteps"),out=d.querySelector(".dout");const steps=JSON.parse(d.dataset.steps);
btn.onclick=async()=>{const v=inp.value.trim()||inp.placeholder;btn.disabled=true;out.textContent="";st.innerHTML=steps.map((s)=>"<div><i></i>"+esc(s)+"</div>").join("");const rows=[...st.children];for(const r of rows){r.className="on";await new Promise(x=>setTimeout(x,R(600,1200)));r.className="ok"}out.textContent=fill(d.dataset.result.replace(/\\{input\\}/g,v));btn.disabled=false}});
const cp=document.getElementById("copy");if(cp)cp.onclick=async()=>{await navigator.clipboard.writeText(document.getElementById("ca").textContent);const t=document.getElementById("toast");t.classList.add("on");setTimeout(()=>t.classList.remove("on"),1500)};
document.querySelectorAll("td .st").forEach((s,i)=>{if(/live|hot/.test(s.className))setInterval(()=>{s.style.opacity=s.style.opacity==="0.4"?"1":"0.4"},900+i*80)});
const cv=document.getElementById("bg"),g=cv.getContext("2d");let W,H,P=[];function rz(){W=cv.width=innerWidth;H=cv.height=innerHeight;P=Array.from({length:Math.min(70,W/18)},()=>({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.25,vy:(Math.random()-.5)*.25}))}rz();addEventListener("resize",rz);
const AC=getComputedStyle(document.documentElement).getPropertyValue("--ac").trim();function draw(){g.clearRect(0,0,W,H);for(const p of P){p.x=(p.x+p.vx+W)%W;p.y=(p.y+p.vy+H)%H}g.strokeStyle=AC;for(let i=0;i<P.length;i++)for(let j=i+1;j<P.length;j++){const a=P[i],b=P[j],d=Math.hypot(a.x-b.x,a.y-b.y);if(d<140){g.globalAlpha=(1-d/140)*.12;g.beginPath();g.moveTo(a.x,a.y);g.lineTo(b.x,b.y);g.stroke()}}g.globalAlpha=.35;g.fillStyle=AC;for(const p of P){g.beginPath();g.arc(p.x,p.y,1.3,0,7);g.fill()}requestAnimationFrame(draw)}if(!matchMedia("(prefers-reduced-motion: reduce)").matches)draw();
</script></body></html>`;
}
