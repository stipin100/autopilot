// LOGO + BANNER MAKER. House style (from the owner's reference logos): pure black ground, ONE bold mark in the
// middle, built from pixels or dots - glowing neon pixels in one colour, or a white dot matrix - with faint
// "data noise" specks around it, lots of empty space, no words on the logo.
// Any mark (Claude's or a built-in one) is first drawn as a plain shape, then turned into a pixel grid and painted
// in the house style, so every coin looks like part of the same family.
// Output: logo.png (512x512) + banner.png (1500x500), rendered on the server with resvg.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";
import { aiReady, askJson } from "./ai.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FONT = { fontFiles: [path.join(ROOT, "fonts", "Inter-800.ttf"), path.join(ROOT, "fonts", "Inter-500.ttf")], loadSystemFonts: false, defaultFontFamily: "Inter" };

const BG = "#070707";
// neon colours that glow well on black (yellow and white first: the reference logos)
const ACCENTS = { yellow: "#ffe600", white: "#f4f4f4", green: "#2bff88", cyan: "#22d3ee", pink: "#ff3d8b", orange: "#ff8a00", violet: "#a66bff" };
const STYLES = ["neon", "neon", "neon", "dots"]; // neon pixels most of the time, a white dot matrix sometimes

const xml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
function hash(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function mix(hexColor, to, t) {
  const a = hexColor.match(/\w\w/g).map((h) => parseInt(h, 16)), b = to.match(/\w\w/g).map((h) => parseInt(h, 16));
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

/** The built-in marks (drawn on a 512 box, centre 256). INK = the mark, ACC = its one accent part. Chunky, so they pixelate well. */
function builtInMark(r) {
  const c = 256;
  const S = `stroke="INK" stroke-width="46" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  const F = `fill="INK"`;
  const dot = (x, y, rad = 30) => `<circle cx="${x}" cy="${y}" r="${rad}" fill="ACC"/>`;
  const hexPath = (cx, cy, R) => Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return `${i ? "L" : "M"} ${(cx + R * Math.cos(a)).toFixed(1)} ${(cy + R * Math.sin(a)).toFixed(1)}`; }).join(" ") + " Z";
  const marks = [
    () => `<path d="M ${c + 85} ${c + 85} A 120 120 0 1 1 ${c + 120} ${c - 40}" ${S}/>${dot(c + 95, c + 95)}`,
    () => `<rect x="${c - 115}" y="${c - 115}" width="230" height="230" rx="56" ${S}/>${dot(c, c)}`,
    () => `<path d="M ${c - 125} ${c + 95} L ${c} ${c - 120} L ${c + 125} ${c + 95} Z" ${S}/>${dot(c, c + 30, 28)}`,
    () => [0, 1, 2].map((i) => `<path d="M ${c - 110 + i * 70} ${c - 100} L ${c - 40 + i * 70} ${c} L ${c - 110 + i * 70} ${c + 100}" ${S}/>`).join("") + dot(c + 130, c, 26),
    () => [-3, -2, -1, 0, 1, 2, 3].map((i) => { const h = 70 + (3 - Math.abs(i)) * 45; return `<rect x="${c + i * 48 - 17}" y="${c - h / 2}" width="34" height="${h}" rx="17" ${F}/>`; }).join(""), // sound bars
    () => [[-62, -54], [62, -54], [0, 54]].map(([dx, dy], i) => `<path d="${hexPath(c + dx, c + dy, 58)}" ${i === 2 ? `fill="ACC"` : F}/>`).join(""), // three hexes
    () => `<circle cx="${c - 70}" cy="${c}" r="88" ${F}/>` + [-70, 0, 70].map((dy, i) => `<rect x="${c + 34}" y="${c + dy - 24}" width="${170 - i * 40}" height="48" rx="6" ${F}/>`).join(""), // disc + bars
    () => `<path d="${hexPath(c, c, 135)}" ${S}/>${dot(c, c, 36)}`,
    () => `<path d="M ${c - 120} ${c + 40} L ${c - 40} ${c - 40} L ${c + 20} ${c + 20} L ${c + 120} ${c - 80}" ${S}/>${dot(c + 120, c - 80, 30)}`,
    () => `<rect x="${c - 120}" y="${c - 80}" width="240" height="160" rx="28" ${S}/><path d="M ${c - 60} ${c - 10} L ${c - 20} ${c + 20} L ${c - 60} ${c + 50}" ${S}/>${dot(c + 55, c + 35, 20)}`,
    () => [0, 1, 2].map((i) => `<rect x="${c - 120 + i * 24}" y="${c - 120 + i * 24}" width="${240 - i * 48}" height="${240 - i * 48}" rx="${70 - i * 20}" ${i === 2 ? `fill="ACC"` : `stroke="INK" stroke-width="22" fill="none"`}/>`).join(""), // nested squares
    () => `<path d="M ${c} ${c - 135} L ${c + 135} ${c} L ${c} ${c + 135} L ${c - 135} ${c} Z" ${S}/>${dot(c, c, 34)}`,
  ];
  return marks[Math.floor(r() * marks.length)]();
}

/** Only plain drawing tags may come back from Claude - no scripts, links, images or text. */
function cleanMark(svg) {
  const s = String(svg).replace(/<\?xml[^>]*>|<!--[\s\S]*?-->/g, "").trim();
  const tags = s.match(/<\/?([a-zA-Z]+)/g) ?? [];
  const allowed = new Set(["g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
  if (!tags.length || tags.some((t) => !allowed.has(t.replace(/[</]/g, "").toLowerCase()))) throw new Error("mark used tags we don't allow");
  if (/href|url\(|on[a-z]+\s*=|javascript:/i.test(s)) throw new Error("mark had links or scripts");
  if (s.length > 12000) throw new Error("mark too big");
  return s;
}

const MarkSchema = z.object({
  style: z.enum(["neon", "dots"]).describe("neon = glowing pixels in one colour; dots = white dot matrix"),
  color: z.enum(Object.keys(ACCENTS)),
  mark: z.string().describe("SVG drawing elements only (path, circle, rect, line, polyline, polygon, ellipse, g) on a 512x512 canvas, centred on 256,256, kept inside 110..402, using fill/stroke INK for the mark and ACC for its one accent part"),
  idea: z.string().describe("one short sentence: what the mark shows"),
});

async function claudeMark(brand) {
  const sys = `You design logos for crypto apps in one house style: a single bold geometric symbol on black, later rendered as a ~44x44 grid of glowing neon pixels (or a white dot matrix).
Rules: ONE chunky symbol centred with lots of empty space; filled shapes or very thick strokes (stroke-width 40-56, round caps); no thin lines or tiny details (they vanish in the pixel grid); no words, letters, numbers, faces or animals; at most one small accent part in ACC.
Think of: sound bars, hexagon cells, a disc with bars, nested squares, a bolt, a node graph, a shield, a chip. Pick a symbol that shows what the product does.`;
  const out = await askJson(MarkSchema, sys, `Coin: ${brand.name} ($${brand.symbol}).\nWhat it is: ${brand.tagline || brand.description || brand.name}`, 3000);
  return { mark: cleanMark(out.mark), style: out.style, color: out.color, idea: out.idea };
}

function palette(brand, seed, pick) {
  const r = rng(hash(brand.name) + seed * 7919);
  const names = Object.keys(ACCENTS);
  const style = pick?.style ?? STYLES[Math.floor(r() * STYLES.length)];
  const color = pick?.color && ACCENTS[pick.color] ? pick.color : names[Math.floor(r() * names.length)];
  const accent = ACCENTS[color];
  // dot matrix = white dots with the accent on the accent part; neon = everything in the accent colour
  return { style, accent, ink: style === "dots" ? "#f2f2f2" : accent, r };
}

// ---------- shape -> pixel grid ----------

/** Draws the mark plain white at n x n pixels and reads which cells are filled. Returns { ink: Set, acc: Set }. */
function gridOf(mark, n) {
  const read = (svgInner) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${svgInner}</svg>`;
    const img = new Resvg(svg, { fitTo: { mode: "width", value: n }, background: "rgba(0,0,0,0)" }).render();
    const set = new Set();
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (img.pixels[(y * img.width + x) * 4 + 3] >= 110) set.add(y * n + x);
    return set;
  };
  const ink = read(mark.replaceAll("INK", "#ffffff").replaceAll("ACC", "none"));
  const acc = read(mark.replaceAll("INK", "none").replaceAll("ACC", "#ffffff"));
  for (const k of acc) ink.delete(k);
  if (ink.size + acc.size < 12) throw new Error("mark is too thin to draw as pixels");
  return { ink, acc, n };
}

/** Paints a pixel grid in the house style, sized `size` px, placed at (ox, oy). */
function paintGrid(g, p, size, ox, oy) {
  const cell = size / g.n;
  const has = (set, x, y) => x >= 0 && y >= 0 && x < g.n && y < g.n && set.has(y * g.n + x);
  const filled = (x, y) => has(g.ink, x, y) || has(g.acc, x, y);
  let glow = "", body = "", shine = "";
  const add = (set, base, isAcc) => {
    for (const k of set) {
      const x = k % g.n, y = Math.floor(k / g.n);
      const X = (ox + x * cell).toFixed(1), Y = (oy + y * cell).toFixed(1);
      if (p.style === "dots") {
        const rr = (cell * 0.36).toFixed(2), cx = (ox + (x + 0.5) * cell).toFixed(1), cy = (oy + (y + 0.5) * cell).toFixed(1);
        body += `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${isAcc ? p.accent : base}"/>`;
        glow += `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${isAcc ? p.accent : base}"/>`;
      } else {
        const edge = !filled(x - 1, y) || !filled(x + 1, y) || !filled(x, y - 1) || !filled(x, y + 1);
        const col = isAcc ? mix(base, "#ffffff", 0.55) : edge ? mix(base, "#ffffff", 0.18) : mix(base, "#000000", 0.14);
        const w = (cell + 0.6).toFixed(1); // tiny overlap = no hairline gaps
        body += `<rect x="${X}" y="${Y}" width="${w}" height="${w}" fill="${col}"/>`;
        glow += `<rect x="${X}" y="${Y}" width="${w}" height="${w}" fill="${base}"/>`;
        // a small highlight on the top-left corner of each shape, like a lit pixel edge
        if (!filled(x - 1, y) && !filled(x, y - 1) && !filled(x - 1, y - 1)) shine += `<rect x="${X}" y="${Y}" width="${(cell * 2).toFixed(1)}" height="${(cell * 0.9).toFixed(1)}" fill="#ffffff" opacity=".55"/>`;
      }
    }
  };
  add(g.ink, p.ink, false);
  add(g.acc, p.accent, true);
  const blur = p.style === "dots" ? cell * 0.5 : cell * 1.1;
  return `<g filter="url(#glow)" opacity="${p.style === "dots" ? 0.55 : 0.9}">${glow}</g><g filter="url(#soft)" opacity=".5">${glow}</g>${body}${shine}`
    .replace("url(#glow)", `url(#glow${Math.round(blur)})`).replace("url(#soft)", `url(#soft${Math.round(blur)})`) + `<!--b${Math.round(blur)}-->`;
}
const filters = (svgBody) => {
  const ids = [...new Set([...svgBody.matchAll(/<!--b(\d+)-->/g)].map((m) => Number(m[1])))];
  return ids.map((b) => `<filter id="glow${b}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${b}"/></filter><filter id="soft${b}" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="${b * 3}"/></filter>`).join("");
};

/** Faint "data noise": short grey dashes scattered around, kept away from the middle. */
function noise(r, w, h, count, keepOut) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const x = r() * w, y = r() * h;
    if (keepOut && Math.abs(x - keepOut.x) < keepOut.w && Math.abs(y - keepOut.y) < keepOut.h) continue;
    const len = 6 + Math.floor(r() * 5) * 6, rows = 1 + Math.floor(r() * 3);
    for (let k = 0; k < rows; k++) out += `<rect x="${x.toFixed(0)}" y="${(y + k * 5).toFixed(0)}" width="${(len * (0.5 + r() * 0.5)).toFixed(0)}" height="2" fill="#ffffff" opacity="${(0.05 + r() * 0.09).toFixed(2)}"/>`;
  }
  return out;
}

function logoSvg(grid, p, r) {
  const body = paintGrid(grid, p, 440, 36, 36); // the mark sits in 110..402 of its box, so it fills ~55% of the logo
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs>${filters(body)}</defs>
<rect width="512" height="512" fill="${BG}"/>${noise(r, 512, 512, 34, { x: 256, y: 256, w: 170, h: 170 })}${body}</svg>`;
}

function bannerSvg(grid, p, brand, r) {
  const name = xml(brand.name);
  const size = brand.name.length > 14 ? 92 : 116;
  const tag = xml((brand.tagline || "").replace(/\.$/, "").slice(0, 60));
  const body = paintGrid(grid, p, 430, 80, 35);
  const dots = Array.from({ length: 8 }, (_, i) => `<circle cx="${1080 + i * 46}" cy="452" r="5" fill="${p.accent}" opacity="${(0.15 + i * 0.1).toFixed(2)}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500"><defs>${filters(body)}
<pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse"><circle cx="15" cy="15" r="1.2" fill="#ffffff" opacity=".07"/></pattern></defs>
<rect width="1500" height="500" fill="${BG}"/><rect width="1500" height="500" fill="url(#grid)"/>${noise(r, 1500, 500, 60, { x: 290, y: 250, w: 230, h: 230 })}
${body}
<rect x="560" y="${tag ? 128 : 160}" width="14" height="14" fill="${p.accent}"/><text x="586" y="${tag ? 141 : 173}" font-family="Inter" font-weight="800" font-size="22" letter-spacing="4" fill="${p.accent}">LIVE ON SOLANA</text>
<text x="556" y="${tag ? 262 : 292}" font-family="Inter" font-weight="800" font-size="${size}" fill="#f4f4f4" letter-spacing="-3">${name}</text>
${tag ? `<text x="560" y="322" font-family="Inter" font-weight="500" font-size="38" fill="#f4f4f4" opacity="0.55">${tag}</text>` : ""}
<rect x="560" y="${tag ? 360 : 330}" width="${44 + brand.symbol.length * 23}" height="54" fill="none" stroke="${p.accent}" stroke-width="3"/>
<text x="582" y="${tag ? 397 : 367}" font-family="Inter" font-weight="800" font-size="29" fill="${p.accent}">$${xml(brand.symbol)}</text>${dots}
</svg>`;
}

const png = (svg, width) => new Resvg(svg, { fitTo: { mode: "width", value: width }, font: FONT }).render().asPng();

function draw(brand, seed, mark, p) {
  const grid = gridOf(mark, p.style === "dots" ? 30 : 44);
  const rr = rng(hash(brand.symbol) + seed * 31);
  return { logo: png(logoSvg(grid, p, rr), 512), banner: png(bannerSvg(grid, p, brand, rr), 1500) };
}

/**
 * Makes the coin's logo + banner. seed changes the built-in design ("Remake").
 * Returns { logo: Buffer, banner: Buffer, palette, by: "claude" | "built-in", note }.
 */
export async function makeArt(brand, seed = 0) {
  let pick = null, note = "";
  if (aiReady()) {
    try {
      pick = await claudeMark(brand);
      note = pick.idea;
    } catch (e) {
      note = `Claude logo failed (${e.message}) - used a built-in mark`;
      pick = null;
    }
  }
  const p = palette(brand, seed, pick);
  try {
    const { logo, banner } = draw(brand, seed, pick?.mark ?? builtInMark(p.r), p);
    return { logo, banner, palette: { bg: BG, ink: p.ink, accent: p.accent, style: p.style }, by: pick ? "claude" : "built-in", note };
  } catch (e) {
    if (!pick) throw e;
    // Claude's mark didn't draw (too thin, bad SVG): same colours, a built-in mark
    const q = palette(brand, seed, null);
    Object.assign(q, { style: p.style, accent: p.accent, ink: p.ink });
    const { logo, banner } = draw(brand, seed, builtInMark(q.r), q);
    return { logo, banner, palette: { bg: BG, ink: q.ink, accent: q.accent, style: q.style }, by: "built-in", note: `Claude's logo didn't draw (${e.message}) - used a built-in mark` };
  }
}
