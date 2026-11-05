// THE BRAIN - market study. Watches every new Pump.fun coin (free PumpPortal feed) and learns:
//  - bot wallets: wallets that buy in the first seconds of many different coins (snipers / bundler groups)
//  - bot picks:   coins that 2+ bot wallets bought in their first minute
//  - runners:     coins whose market cap took off in their first 10 minutes
//  - safe words:  words bot groups buy more often than normal over 7 days
//  - hot words:   words in coins the bots bought / that ran in the last 6 hours
// Market caps come from reading each coin's bonding curve on Solana (batched, cheap).
// Bot wallets need trade data, which PumpPortal only gives with an API key (PUMPPORTAL_API_KEY, funded with 0.02 SOL).
// Read-only: it never sends anything to Solana.

import fs from "node:fs";
import path from "node:path";

const FEED = "wss://pumpportal.fun/api/data";
const WATCH_MS = 10 * 60_000; // follow each new coin's trades for 10 minutes
const EARLY_MS = 4_000; // a buy this soon after creation = sniper speed
const PICK_MS = 60_000; // bot buys inside the first minute make a coin a "bot pick"
const KEEP_MS = 7 * 24 * 3600_000;
const RUNNER_MC_SOL = 70; // starts around 28 SOL; 70+ inside 10 minutes = it ran
const BOT_MIN_COINS = 4; // early buyer on 4+ different coins in 24h = bot wallet

const STOP = new Set(("the and for you are not but all any can her his its our out one two who get has had was were will with this that from your have just they them what when than then into over also only some more most such very much many like make made coin token sol pump fun meme memes official real new inu ai").split(" "));

/** Splits a coin name/ticker into words: "BabyDogeCEO" -> baby, doge, ceo. */
export function words(name, symbol = "") {
  const out = new Set();
  for (const part of `${name} ${symbol}`.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length >= 3 && part.length <= 15 && !STOP.has(part) && !/^\d+$/.test(part)) out.add(part);
  }
  return [...out];
}

export function createBrain(dataDir, { apiKey = "", readCurves } = {}) {
  const FILE = path.join(dataDir, "brain.json");
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
  const coins = saved.coins ?? []; // { m, n, s, t, w:[words], buyers, vol, peak, botBuys, pick, runner }
  const early = new Map(saved.early ?? []); // wallet -> [{ m, t }] early buys (last 24h)
  const heat = saved.heat ?? []; // [{ t, coins, vol }] every 5 minutes
  const live = new Map(); // mint -> watching record
  const status = { connected: false, since: 0, lastMsg: 0, error: "", trades: !!apiKey };
  let ws = null;
  let bucket = { t: Math.floor(Date.now() / 300_000) * 300_000, coins: 0, vol: 0 };

  const isBot = (w) => (early.get(w)?.length ?? 0) >= BOT_MIN_COINS;

  function send(o) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(o));
  }

  function onCreate(m) {
    if (!m.mint || live.has(m.mint)) return;
    const rec = { m: m.mint, n: String(m.name ?? "").slice(0, 40), s: String(m.symbol ?? "").slice(0, 12), t: Date.now(), dev: m.traderPublicKey, buyers: new Set(), vol: 0, peak: Number(m.marketCapSol) || 0, botBuys: new Set(), early: new Set() };
    live.set(m.mint, rec);
    bucket.coins++;
    if (status.trades) send({ method: "subscribeTokenTrade", keys: [m.mint] });
  }

  function onTrade(m) {
    const rec = live.get(m.mint);
    if (!rec) return;
    const sol = Number(m.solAmount) || 0;
    rec.vol += sol;
    bucket.vol += sol;
    rec.peak = Math.max(rec.peak, Number(m.marketCapSol) || 0);
    const w = m.traderPublicKey;
    if (m.txType !== "buy" || !w || w === rec.dev) return;
    rec.buyers.add(w);
    const age = Date.now() - rec.t;
    if (age <= EARLY_MS && !rec.early.has(w)) {
      rec.early.add(w);
      const list = early.get(w) ?? [];
      list.push({ m: rec.m, t: Date.now() });
      early.set(w, list);
    }
    if (age <= PICK_MS && isBot(w)) rec.botBuys.add(w);
  }

  function finish(rec) {
    live.delete(rec.m);
    if (status.trades) send({ method: "unsubscribeTokenTrade", keys: [rec.m] });
    coins.push({
      m: rec.m, n: rec.n, s: rec.s, t: rec.t, w: words(rec.n, rec.s), buyers: rec.buyers.size, vol: +rec.vol.toFixed(2), peak: +rec.peak.toFixed(1),
      botBuys: rec.botBuys.size, pick: rec.botBuys.size >= 2, runner: rec.peak >= RUNNER_MC_SOL,
    });
  }

  let reading = false;
  /** Reads market caps from Solana at 3 and 10 minutes old (100 coins per call). */
  async function readCaps(now) {
    if (!readCurves || reading) return;
    const due = [...live.values()].filter((r) => (now - r.t > 3 * 60_000 && !r.read3) || now - r.t > WATCH_MS);
    if (!due.length) return;
    reading = true;
    try {
      const caps = await readCurves(due.map((r) => r.m));
      for (const r of due) {
        const mc = caps.get(r.m);
        if (mc !== undefined) r.peak = Math.max(r.peak, mc);
        r.read3 = true;
        if (now - r.t > WATCH_MS) r.done = true;
      }
    } catch (e) {
      status.error = `market cap read failed: ${e.message}`;
      for (const r of due) if (now - r.t > WATCH_MS + 5 * 60_000) r.done = true; // give up on it
    } finally {
      reading = false;
    }
  }

  async function housekeeping() {
    const now = Date.now();
    await readCaps(now);
    for (const rec of live.values()) if (rec.done || (!readCurves && now - rec.t > WATCH_MS)) finish(rec);
    while (coins.length && now - coins[0].t > KEEP_MS) coins.shift();
    for (const [w, list] of early) {
      const keep = list.filter((x) => now - x.t < 24 * 3600_000);
      if (keep.length) early.set(w, keep);
      else early.delete(w);
    }
    const b = Math.floor(now / 300_000) * 300_000;
    if (b !== bucket.t) {
      heat.push({ t: bucket.t, coins: bucket.coins, vol: +bucket.vol.toFixed(1) });
      while (heat.length > 2016) heat.shift(); // 7 days of 5-minute buckets
      bucket = { t: b, coins: 0, vol: 0 };
    }
  }

  function save() {
    try {
      fs.writeFileSync(FILE + ".tmp", JSON.stringify({ coins, early: [...early], heat }));
      fs.renameSync(FILE + ".tmp", FILE);
    } catch (e) {
      console.error("brain save failed:", e.message);
    }
  }

  function connect() {
    if (typeof WebSocket === "undefined") return void (status.error = "This Node.js has no WebSocket (needs Node 22+)");
    try {
      ws = new WebSocket(apiKey ? `${FEED}?api-key=${encodeURIComponent(apiKey)}` : FEED);
    } catch (e) {
      status.error = e.message;
      return void setTimeout(connect, 15_000);
    }
    ws.onopen = () => {
      Object.assign(status, { connected: true, since: Date.now(), error: "" });
      send({ method: "subscribeNewToken" });
      if (live.size && status.trades) send({ method: "subscribeTokenTrade", keys: [...live.keys()] });
    };
    ws.onmessage = (ev) => {
      status.lastMsg = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (/only available when connecting with an API key/i.test(m.message ?? "")) {
        status.trades = false; // key missing or empty: keep going on market caps alone
        status.error = "Trade data off - PumpPortal key missing or not funded";
      }
      if (m.txType === "create") onCreate(m);
      else if (m.txType === "buy" || m.txType === "sell") onTrade(m);
    };
    ws.onerror = () => { status.error = "feed error - reconnecting"; };
    ws.onclose = () => {
      status.connected = false;
      setTimeout(connect, 10_000);
    };
  }

  // ---------- What the brain has learned ----------

  function wordTable(sinceMs) {
    const now = Date.now();
    const table = new Map();
    let all = 0, picks = 0;
    for (const c of coins) {
      if (now - c.t > sinceMs) continue;
      all++;
      const hit = c.pick || c.runner;
      if (hit) picks++;
      for (const w of c.w) {
        const r = table.get(w) ?? { word: w, coins: 0, hits: 0, last12: 0, last6: 0, days: new Map(), names: new Set() };
        r.coins++;
        if (hit) {
          r.hits++;
          if (now - c.t < 12 * 3600_000) r.last12++;
          if (now - c.t < 6 * 3600_000) r.last6++;
          r.names.add(c.n.toLowerCase());
        }
        const day = Math.floor(c.t / 86400_000);
        const d = r.days.get(day) ?? [0, 0];
        d[0]++;
        if (hit) d[1]++;
        r.days.set(day, d);
        table.set(w, r);
      }
    }
    return { table, all, picks, rate: all ? picks / all : 0 };
  }

  /** Words the bot groups buy above the normal rate over 7 days. */
  function safeWords(limit = 40) {
    const { table, rate } = wordTable(KEEP_MS);
    if (!rate) return [];
    return [...table.values()]
      .filter((r) => r.coins >= 5 && r.hits >= 3 && r.names.size >= 2)
      .map((r) => {
        const lift = (r.hits / r.coins) / rate;
        const daysBeaten = [...r.days.values()].filter(([n, h]) => n && h / n > rate).length;
        return { word: r.word, coins: r.coins, hits: r.hits, hitRate: +(r.hits / r.coins).toFixed(3), lift: +lift.toFixed(2), last12: r.last12, last6: r.last6, daysBeaten, days: r.days.size, names: r.names.size };
      })
      .filter((r) => r.lift >= 1.4)
      .sort((a, b) => b.lift * Math.log2(1 + b.hits) - a.lift * Math.log2(1 + a.hits))
      .slice(0, limit);
  }

  /** Exact words from coins the bots bought (or that ran) in the last few hours. */
  function hotWords(hours = 6, limit = 40) {
    const now = Date.now();
    const count = new Map();
    for (let i = coins.length - 1; i >= 0 && now - coins[i].t < hours * 3600_000; i--) {
      const c = coins[i];
      if (!c.pick && !c.runner) continue;
      for (const w of c.w) {
        const r = count.get(w) ?? { word: w, hits: 0, runners: 0, last: 0, names: new Set() };
        r.hits++;
        if (c.runner) r.runners++;
        r.last = Math.max(r.last, c.t);
        r.names.add(c.n);
        count.set(w, r);
      }
    }
    return [...count.values()].sort((a, b) => b.hits + b.runners - (a.hits + a.runners) || b.last - a.last).slice(0, limit)
      .map((r) => ({ word: r.word, hits: r.hits, runners: r.runners, last: r.last, names: [...r.names].slice(0, 3) }));
  }

  function summary() {
    const now = Date.now();
    const day = coins.filter((c) => now - c.t < 24 * 3600_000);
    const recent = coins.slice(-40).reverse().map((c) => ({ ...c, w: undefined }));
    const watching = [...live.values()].sort((a, b) => b.t - a.t).slice(0, 15).map((r) => ({ m: r.m, n: r.n, s: r.s, t: r.t, buyers: r.buyers.size, vol: +r.vol.toFixed(2), peak: +r.peak.toFixed(1), botBuys: r.botBuys.size }));
    let bots = 0;
    for (const list of early.values()) if (list.length >= BOT_MIN_COINS) bots++;
    return {
      status: { ...status, watching: live.size },
      day: { coins: day.length, picks: day.filter((c) => c.pick).length, runners: day.filter((c) => c.runner).length, bots },
      week: { coins: coins.length, days: coins.length ? +((now - coins[0].t) / 86400_000).toFixed(1) : 0 },
      heat: heat.slice(-288),
      recent, watching,
    };
  }

  /** Top bot wallets (for the bot radar), most active first. */
  function botWallets(limit = 50) {
    return [...early.entries()].filter(([, l]) => l.length >= BOT_MIN_COINS)
      .map(([wallet, l]) => ({ wallet, coins: new Set(l.map((x) => x.m)).size, last: Math.max(...l.map((x) => x.t)) }))
      .sort((a, b) => b.coins - a.coins).slice(0, limit);
  }

  /** Was this exact name launched by anyone in the last 7 days? */
  const nameSeen = (name) => {
    const n = name.trim().toLowerCase();
    return coins.some((c) => c.n.toLowerCase() === n) || [...live.values()].some((r) => r.n.toLowerCase() === n);
  };

  function start() {
    connect();
    setInterval(() => housekeeping().catch((e) => console.error("brain:", e.message)), 15_000);
    setInterval(save, 60_000);
  }

  return { start, save, safeWords, hotWords, summary, botWallets, isBot, nameSeen };
}
