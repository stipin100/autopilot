// IDEA MAKER - writes coin ideas from the brain's safe words + hot words (no AI needed),
// then checks each name: carries a market word, sounds like real tech/money, not banned, not used before,
// and no coin with the same name or ticker already trades on DexScreener.

const PRODUCTS = [
  ["Pad", "a launchpad", "launches coins"], ["Agent", "an AI agent", "works while you sleep"], ["Desk", "a trading desk", "trades for you"],
  ["Pay", "a payments app", "sends money in one tap"], ["Vault", "a savings vault", "stacks your SOL"], ["Fund", "a community fund", "invests together"],
  ["Bridge", "a bridge", "moves money across chains"], ["Inbox", "a smart inbox", "sorts your DMs"], ["Escrow", "an escrow service", "keeps deals safe"],
  ["Card", "a crypto card", "lets you spend anywhere"], ["Bank", "an onchain bank", "banks without the bank"], ["Wallet", "a wallet", "holds your coins"],
  ["Labs", "a builder lab", "ships new tools every week"], ["Swap", "a swap app", "finds the best price"], ["Cash", "a cash app", "sends cash to anyone"],
  ["Index", "an index fund", "holds a basket of winners"], ["Pilot", "an autopilot", "runs itself"], ["Hub", "a hub", "connects everything"],
  ["Pass", "a members pass", "unlocks perks"], ["Chain", "a chain", "settles in a second"], ["Credit", "a credit line", "lends against your bags"],
  ["Payroll", "a payroll app", "pays teams onchain"], ["Invoice", "an invoicing app", "gets you paid"], ["Budget", "a budget app", "plans your spending"],
];
const BANNED = ["game", "games", "pet", "pets", "toy", "toys", "tracker", "tracks", "scanner", "terminal", "rug", "scam", "casino", "porn", "nazi", "hitler", "kill", "penis"];
const HOOKS = ["built for the trenches", "the one people actually use", "simple enough for anyone", "running on autopilot", "made for degens", "one tap, done"];

const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** Ticker: the words squashed together, max 10 letters. */
export function tickerFor(name) {
  const t = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (t.length <= 10) return t;
  const parts = name.toUpperCase().split(/\s+/).map((p) => p.replace(/[^A-Z0-9]/g, ""));
  return (parts[0].length <= 10 ? parts[0] : t).slice(0, 10);
}

/** Name check: returns { ok, notes[] }. */
export function checkName({ name, symbol }, ctx) {
  const notes = [];
  let ok = true;
  const lower = name.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const safe = new Set(ctx.safe.map((w) => w.word));
  const hot = new Set(ctx.hot.map((w) => w.word));
  const market = tokens.filter((t) => safe.has(t) || hot.has(t));
  if (market.length) notes.push(`carries ${market.map((t) => (safe.has(t) ? `safe word "${t}"` : `hot word "${t}"`)).join(", ")}`);
  else { ok = false; notes.push("no safe or hot word in the name"); }
  const banned = tokens.filter((t) => BANNED.includes(t));
  if (banned.length) { ok = false; notes.push(`banned word: ${banned.join(", ")}`); }
  if (!PRODUCTS.some(([p]) => tokens.includes(p.toLowerCase()))) notes.push("no tech/money product word (ok, but weaker)");
  if (name.length > 32) { ok = false; notes.push("name longer than 32"); }
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) { ok = false; notes.push("ticker must be 1-10 letters/numbers"); }
  if (ctx.usedNames.has(lower) || ctx.usedTickers.has(symbol)) { ok = false; notes.push("already used by one of your coins"); }
  if (ctx.seen(name)) { ok = false; notes.push("someone launched this exact name in the last 7 days"); }
  return { ok, notes };
}

/** DexScreener lookup: Solana coins with the same name or ticker. */
export async function checkClash({ name, symbol }) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(8000) });
    const r2 = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(8000) });
    const pairs = [...((await r.json().catch(() => ({}))).pairs ?? []), ...((await r2.json().catch(() => ({}))).pairs ?? [])];
    const same = new Map();
    for (const p of pairs) {
      if (p.chainId !== "solana") continue;
      const b = p.baseToken ?? {};
      if (String(b.name).toLowerCase() === name.toLowerCase() || String(b.symbol).toUpperCase() === symbol) {
        same.set(b.address, { name: b.name, symbol: b.symbol, address: b.address, mcap: p.marketCap ?? p.fdv ?? 0, url: p.url });
      }
    }
    const list = [...same.values()].sort((a, b) => b.mcap - a.mcap).slice(0, 5);
    // a clash only matters if the other coin is worth something
    const big = list.filter((x) => x.mcap >= 20_000);
    return { ok: big.length === 0, list, at: Date.now() };
  } catch (e) {
    return { ok: null, list: [], at: Date.now(), error: "DexScreener didn't answer" };
  }
}

/**
 * Makes `count` fresh ideas. source: "both" | "safe" | "hot".
 * ctx = { safe, hot, usedNames:Set, usedTickers:Set, seen(name) }
 */
export function makeIdeas(count, source, ctx) {
  let pool = [];
  if (source !== "hot") pool.push(...ctx.safe.slice(0, 25).map((w) => ({ word: w.word, kind: "safe", why: `bought ${w.lift}x more than normal over ${w.days} days (${w.hits} hits, ${w.last6} in the last 6h)` })));
  if (source !== "safe") pool.push(...ctx.hot.slice(0, 25).map((w) => ({ word: w.word, kind: "hot", why: `${w.hits} coins took off or got bot buys${w.runners ? ` (${w.runners} ran)` : ""} in the last 6h (${w.names.join(", ")})` })));
  pool = pool.filter((p) => !BANNED.includes(p.word) && /^[a-z]+$/.test(p.word));
  const out = [];
  const taken = new Set();
  for (let guard = 0; out.length < count && pool.length && guard < count * 40; guard++) {
    const p = pick(pool);
    const [prod, what, verb] = pick(PRODUCTS);
    if (prod.toLowerCase() === p.word) continue; // no "Agent Agent"
    const name = Math.random() < 0.8 ? `${cap(p.word)} ${prod}` : `${prod} ${cap(p.word)}`;
    const symbol = tickerFor(name);
    if (symbol !== name.toUpperCase().replace(/[^A-Z0-9]/g, "")) continue; // whole name must fit the 10-letter ticker
    if (taken.has(name.toLowerCase()) || taken.has(symbol)) continue;
    const check = checkName({ name, symbol }, ctx);
    if (!check.ok) continue;
    taken.add(name.toLowerCase());
    taken.add(symbol);
    const hook = pick(HOOKS);
    out.push({
      name, symbol, word: p.word, wordKind: p.kind, why: p.why,
      tagline: `${what} that ${verb}. ${hook}.`,
      description: `${name} is ${what} that ${verb} - ${hook}. $${symbol} on Pump.fun.`,
      xPost: `${name} $${symbol} is live\n\n${cap(what)} that ${verb}. ${cap(hook)}.\n\nCA: {CA}\n\n{WEBSITE}`,
      check,
    });
  }
  return out;
}
