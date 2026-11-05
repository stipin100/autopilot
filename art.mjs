// LOGO + BANNER MAKER. Style: dark (or off-white / one colour) ground, faint dot grid, ONE flat cream mark centred,
// ONE accent (usually a small dot), thick round strokes, no words on the logo.
// With a Claude key, Claude designs the mark for the coin's idea; without one a built-in mark is picked.
// Output: logo.png (512x512) + banner.png (1500x500), rendered on the server with resvg.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { z } from "zod";
import { aiReady, askJson } from "./ai.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FONT = { fontFiles: [path.join(ROOT, "fonts", "Inter-800.ttf"), path.join(ROOT, "fonts", "Inter-500.ttf")], loadSystemFonts: false, defaultFontFamily: "Inter" };

const GROUNDS = [
  { bg: "#121212", ink: "#ece4d6" }, { bg: "#0f1114", ink: "#ece4d6" }, { bg: "#161616", ink: "#ece4d6" },
  { bg: "#f3f2ee", ink: "#1b1b1b" }, { bg: "#1e3a2b", ink: "#ece4d6" }, { bg: "#1b2742", ink: "#ece4d6" }, { bg: "#c75b39", ink: "#f6efe3" },
];
const ACCENTS = ["#f5b43a", "#22c97f", "#9be35a", "#2ec4b6", "#5aa9ff", "#ff6b8a", "#d5f26c"];

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

/** The built-in marks (drawn on a 512 box, centre 256). INK / ACC are swapped for real colours later. */
function builtInMark(r) {
  const c = 256;
  const S = `stroke="INK" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  const dot = (x, y, rad = 26) => `<circle cx="${x}" cy="${y}" r="${rad}" fill="ACC"/>`;
  const marks = [
    () => `<path d="M ${c + 85} ${c + 85} A 120 120 0 1 1 ${c + 120} ${c - 40}" ${S}/>${dot(c + 95, c + 95)}`,
    () => `<rect x="${c - 115}" y="${c - 115}" width="230" height="230" rx="56" ${S}/>${dot(c, c)}`,
    () => `<path d="M ${c - 125} ${c + 95} L ${c} ${c - 120} L ${c + 125} ${c + 95} Z" ${S}/>${dot(c, c + 30, 24)}`,
    () => [0, 1, 2].map((i) => `<path d="M ${c - 110 + i * 70} ${c - 100} L ${c - 40 + i * 70} ${c} L ${c - 110 + i * 70} ${c + 100}" ${S}/>`).join("") + dot(c + 130, c, 22),
    () => `<path d="M ${c - 120} ${c + 80} Q ${c - 120} ${c - 110} ${c} ${c - 110} Q ${c + 120} ${c - 110} ${c + 120} ${c + 80}" ${S}/>${dot(c, c + 80, 30)}`,
    () => `<path d="M ${c} ${c - 135} L ${c + 135} ${c} L ${c} ${c + 135} L ${c - 135} ${c} Z" ${S}/>${dot(c + 135, c, 24)}`,
    () => [[-90, 60], [0, -10], [90, -80]].map(([dx, h]) => `<path d="M ${c + dx} ${c + 110} L ${c + dx} ${c + h}" ${S}/>`).join("") + dot(c + 90, c - 150, 24),
    () => `<path d="${Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return `${i ? "L" : "M"} ${(c + 125 * Math.cos(a)).toFixed(1)} ${(c + 125 * Math.sin(a)).toFixed(1)}`; }).join(" ")} Z" ${S}/>${dot(c, c, 30)}`,
    () => `<circle cx="${c - 50}" cy="${c}" r="85" ${S}/><path d="M ${c + 98} ${c - 76} A 85 85 0 0 1 ${c + 98} ${c + 76}" ${S}/>${dot(c + 150, c - 30, 22)}`,
    () => `<path d="M ${c - 120} ${c + 40} L ${c - 40} ${c - 40} L ${c + 20} ${c + 20} L ${c + 120} ${c - 80}" ${S}/>${dot(c + 120, c - 80, 26)}`,
    () => `<rect x="${c - 120}" y="${c - 80}" width="240" height="160" rx="28" ${S}/><path d="M ${c - 60} ${c - 10} L ${c - 20} ${c + 20} L ${c - 60} ${c + 50}" ${S}/>${dot(c + 55, c + 35, 16)}`,
    () => `<circle cx="${c}" cy="${c}" r="125" ${S}/><path d="M ${c} ${c - 60} L ${c} ${c + 60} M ${c - 60} ${c} L ${c + 60} ${c}" ${S}/>${dot(c + 88, c - 88, 22)}`,
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
  ground: z.enum(["dark", "light", "green", "navy", "terracotta"]),
  accent: z.string().describe("one hex colour like #f5b43a"),
  mark: z.string().describe("SVG drawing elements only (path, circle, rect, line, polyline, polygon, ellipse, g) for a 512x512 canvas, centred on 256,256, using fill/stroke INK for the main mark and ACC for the single accent"),
  idea: z.string().describe("one short sentence: what the mark shows"),
});

async function claudeMark(brand) {
  const sys = "You design minimal, premium crypto app logos. Style rules: ONE flat geometric mark centred with lots of empty space (keep it inside 120..392 on both axes), thick round strokes (stroke-width 28-40, stroke-linecap round), the mark in INK, exactly ONE small accent shape in ACC (often a dot or node). No words, no letters, no numbers, no gradients, no shadows, no faces, no animals, nothing childish. It should read at 48px.";
  const out = await askJson(MarkSchema, sys, `Coin: ${brand.name} ($${brand.symbol}).\nWhat it is: ${brand.tagline || brand.description || brand.name}\nDesign a mark that shows the product idea simply (like a tiny app icon).`, 4000);
  return { mark: cleanMark(out.mark), ground: out.ground, accent: /^#[0-9a-f]{6}$/i.test(out.accent) ? out.accent : null, idea: out.idea };
}

function palette(brand, seed, pick) {
  const r = rng(hash(brand.name) + seed * 7919);
  let g = GROUNDS[Math.floor(r() * GROUNDS.length)];
  if (pick?.ground) g = { dark: GROUNDS[0], light: GROUNDS[3], green: GROUNDS[4], navy: GROUNDS[5], terracotta: GROUNDS[6] }[pick.ground] ?? g;
  let accent = pick?.accent ?? ACCENTS[Math.floor(r() * ACCENTS.length)];
  if (["#1e3a2b", "#c75b39"].includes(g.bg) && !pick?.accent) accent = "#f5b43a";
  return { ...g, accent, r };
}

const dots = (ink, w, h) => `<pattern id="d" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1.6" fill="${ink}" opacity="0.08"/></pattern><rect width="${w}" height="${h}" fill="url(#d)"/>`;
const paint = (mark, p) => mark.replaceAll("INK", p.ink).replaceAll("ACC", p.accent);

function logoSvg(mark, p) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="${p.bg}"/><defs></defs>${dots(p.ink, 512, 512)}${paint(mark, p)}</svg>`;
}

function bannerSvg(mark, p, brand) {
  const name = xml(brand.name);
  const size = brand.name.length > 14 ? 92 : 118;
  const tag = xml((brand.tagline || "").replace(/\.$/, "").slice(0, 60));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500">
<rect width="1500" height="500" fill="${p.bg}"/>${dots(p.ink, 1500, 500)}
<g transform="translate(110 70) scale(0.703)">${paint(mark, p)}</g>
<text x="560" y="${tag ? 255 : 285}" font-family="Inter" font-weight="800" font-size="${size}" fill="${p.ink}" letter-spacing="-3">${name}</text>
${tag ? `<text x="564" y="330" font-family="Inter" font-weight="500" font-size="40" fill="${p.ink}" opacity="0.62">${tag}</text>` : ""}
<rect x="564" y="${tag ? 372 : 330}" width="${40 + brand.symbol.length * 24}" height="54" rx="27" fill="none" stroke="${p.accent}" stroke-width="3"/>
<text x="${584}" y="${tag ? 409 : 367}" font-family="Inter" font-weight="800" font-size="30" fill="${p.accent}">$${xml(brand.symbol)}</text>
</svg>`;
}

const png = (svg, width) => new Resvg(svg, { fitTo: { mode: "width", value: width }, font: FONT }).render().asPng();

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
  const mark = pick?.mark ?? builtInMark(p.r);
  let logo;
  try {
    logo = png(logoSvg(mark, p), 512);
  } catch (e) {
    if (!pick) throw e;
    note = `Claude's logo didn't draw (${e.message}) - used a built-in mark`;
    return makeArtBuiltIn(brand, seed, note);
  }
  const banner = png(bannerSvg(mark, p, brand), 1500);
  return { logo, banner, palette: { bg: p.bg, ink: p.ink, accent: p.accent }, by: pick ? "claude" : "built-in", note };
}

function makeArtBuiltIn(brand, seed, note) {
  const p = palette(brand, seed, null);
  const mark = builtInMark(p.r);
  return { logo: png(logoSvg(mark, p), 512), banner: png(bannerSvg(mark, p, brand), 1500), palette: { bg: p.bg, ink: p.ink, accent: p.accent }, by: "built-in", note };
}
