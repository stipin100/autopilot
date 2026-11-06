// AUTOPILOT - automated Pump.fun launcher. Runs only on your own computer (http://localhost:3480).
// You make the coin's website + X account, add the coin here with a launch time, and AUTOPILOT does the rest:
// funds a fresh wallet for the coin, uploads the image, launches on Pump.fun, posts on X (optional),
// watches outside buyers, and after the check either keeps earning creator fees or marks it a dud.
//
// Keys are created and kept ONLY in the data folder on this computer. Back that folder up.

import { keyStatus, saveKeys } from "./keys.mjs"; // first: keys saved in the app go into process.env before anything reads them
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import BN from "bn.js";
import bs58 from "bs58";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { NATIVE_MINT, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  OnlinePumpSdk, PUMP_SDK, bondingCurvePda, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import { buildSite, updateSiteCA, siteConfig, bannerPath } from "./sitemaker.mjs";
import { SOL_MINT, isPair, pairList, priceInSol, swap } from "./pairs.mjs";
import { createBrain } from "./brain.mjs";
import { checkClash, checkName, makeIdeas } from "./ideas.mjs";
import { aiError, aiReady } from "./ai.mjs";
import { makeArt } from "./art.mjs";
import { planSite, renderSite, templatePlan } from "./sites.mjs";
import { createX, xAppReady } from "./xauth.mjs";

const PORT = Number(process.env.PORT || 3480);
const SIMULATE = process.env.SIMULATE !== "0"; // practice mode until you set SIMULATE=0 in .env
const PINATA_JWT = (process.env.PINATA_JWT || "").trim();
const RPC_URL = (process.env.SOLANA_RPC_URL || "").trim() || "https://api.mainnet-beta.solana.com";
const X_KEYS = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"].map((k) => (process.env[k] || "").trim());
const X_READY = X_KEYS.every(Boolean);

// PUBLIC=1 when running online (Render): password login, encrypted keys, listens on the internet.
const PUBLIC = process.env.PUBLIC === "1";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
if (PUBLIC && APP_PASSWORD.length < 12) {
  console.error("APP_PASSWORD must be set (12+ characters) before AUTOPILOT can run online.");
  process.exit(1);
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const IMAGES = path.join(DATA, "images");
fs.mkdirSync(IMAGES, { recursive: true });

const rpc = new Connection(RPC_URL, "confirmed");
const online = new OnlinePumpSdk(rpc);
const LOOKUP_TABLE = new PublicKey("Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP"); // Pump.fun's shared accounts
const SOL = LAMPORTS_PER_SOL;
const TOKEN_DECIMALS = 6;
const FUND_LEAD_MS = 10 * 60_000; // fresh wallet gets its SOL 10 minutes before launch
const FUND_EXTRA_SOL = 0.03; // on top of the dev buy: launch cost (~0.006), priority fees, sell + claim fees
const FUND_PAIR_EXTRA_SOL = 0.02; // pair coins: 2 swaps + the pair token's account rent
const PRIORITY = { launch: 1_000_000, normal: 200_000 }; // micro-lamports per compute unit
const COIN_RESERVE_LAMPORTS = 3_000_000; // 0.003 SOL stays in each coin wallet so it can keep paying to claim creator fees

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(400 * 2 ** i);
    }
  }
}
class UserError extends Error {}

// ---------- Saved data ----------
// coins.json  = everything about each coin (safe to look at)
// keys.json   = the secret keys of every coin wallet and coin address (NEVER share)
// main-wallet.json = the secret key of your AUTOPILOT main wallet (NEVER share)

const file = (n) => path.join(DATA, n);
const readJson = (n, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file(n), "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (n, v) => {
  fs.writeFileSync(file(n) + ".tmp", JSON.stringify(v, null, 2));
  fs.renameSync(file(n) + ".tmp", file(n));
};

// Online, the wallet key files are locked (AES-256-GCM) with a key made from APP_PASSWORD,
// so a copy of the disk alone can't spend anything. Changing the password = restore a backup.
let cryptKey = null;
if (PUBLIC) {
  let salt = readJson("salt.json", null);
  if (!salt) writeJson("salt.json", (salt = randomBytes(16).toString("hex")));
  cryptKey = scryptSync(APP_PASSWORD, Buffer.from(salt, "hex"), 32);
}
function readSecret(n, fallback) {
  const v = readJson(n, fallback);
  if (!v?.enc) return v; // plain file (on your PC, or just restored)
  try {
    const d = createDecipheriv("aes-256-gcm", cryptKey, Buffer.from(v.iv, "hex"));
    d.setAuthTag(Buffer.from(v.tag, "hex"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data, "base64")), d.final()]).toString("utf8"));
  } catch {
    console.error(`Can't unlock ${n}: APP_PASSWORD is not the one it was locked with.`);
    process.exit(1);
  }
}
function writeSecret(n, v) {
  if (!cryptKey) return writeJson(n, v);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cryptKey, iv);
  const data = Buffer.concat([c.update(JSON.stringify(v), "utf8"), c.final()]);
  writeJson(n, { enc: 1, iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: data.toString("base64") });
}

let mainSecret = readSecret("main-wallet.json", null);
if (!mainSecret) mainSecret = Array.from(Keypair.generate().secretKey);
writeSecret("main-wallet.json", mainSecret); // also locks a plain file restored from a backup
const mainWallet = Keypair.fromSecretKey(Uint8Array.from(mainSecret));
const keys = readSecret("keys.json", {});
writeSecret("keys.json", keys);
const coins = readJson("coins.json", []);
// Autopilot settings (the scheduler) - safe defaults: autopilot off, spending lock on.
const AP_DEFAULTS = {
  autopilot: false, spendLock: true, devBuySol: 0.5, leadMinutes: 3, minGapMinutes: 30, triesPerDay: 2, retryGapMinutes: 240,
  maxDays: 2, maxLaunchesPerDay: 10, windowStart: 0, windowEnd: 24, tzOffset: 0, checkMinutes: 5, minWallets: 15,
  takeProfitX: 2, autoClaimSol: 0.02, autoSweep: false, floatTarget: 1.5, sweepAbove: 0.5,
  paused: false, dailyGoal: 1, ideasPerDay: 0,
};
const settings = { withdrawTo: "", walletNames: {}, ...AP_DEFAULTS, ...readJson("settings.json", {}) };
const brands = readJson("brands.json", []); // coin ideas -> approved queue -> live -> runner / retired
const activity = readJson("activity.json", []); // autopilot's own log
const brain = createBrain(DATA, { apiKey: (process.env.PUMPPORTAL_API_KEY || "").trim(), readCurves });
const xa = createX({ readSecret, writeSecret }); // connected X accounts
const X_LEAD_MS = 30_000; // the launch post goes out this long before the coin launches
// Coin websites: <slug>.SITE_DOMAIN when you point a wildcard domain here, else <this address>/s/<slug>
const SITE_DOMAIN = (process.env.SITE_DOMAIN || "").trim().toLowerCase();

/** Market cap (in SOL) of many Pump.fun coins at once, read from their bonding curves. Graduated = 400. */
async function readCurves(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const part = mints.slice(i, i + 100);
    const infos = await retry(() => rpc.getMultipleAccountsInfo(part.map((m) => bondingCurvePda(new PublicKey(m)))), 3);
    infos.forEach((info, j) => {
      if (!info) return;
      try {
        const c = PUMP_SDK.decodeBondingCurve(info);
        const q = c.quoteMint?.toBase58?.() ?? SOL_MINT;
        if (q !== SOL_MINT && q !== "11111111111111111111111111111111") return; // pair coins aren't priced in SOL
        const mc = c.complete ? 400 : (c.virtualQuoteReserves.toNumber() / 1e9) * (c.tokenTotalSupply.toNumber() / c.virtualTokenReserves.toNumber());
        if (Number.isFinite(mc)) out.set(part[j], +mc.toFixed(1));
      } catch {}
    });
    await sleep(300);
  }
  return out;
}
for (const c of coins) {
  // a website build that was running when AUTOPILOT closed never finished
  if (c.site?.status === "building") c.site = { status: "failed", error: "AUTOPILOT was closed while building - press Rebuild website" };
}

let saveTimer = null;
function save() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeJson("coins.json", coins);
    writeJson("brands.json", brands);
    writeJson("activity.json", activity);
    writeSecret("keys.json", keys);
  }, 300);
}
function apLog(msg) {
  activity.unshift({ t: Date.now(), msg });
  activity.length = Math.min(activity.length, 150);
  console.log(`[autopilot] ${msg}`);
  save();
}
const keypair = (k) => Keypair.fromSecretKey(Uint8Array.from(keys[k]));

function log(c, msg) {
  c.log.unshift({ t: Date.now(), msg });
  c.log.length = Math.min(c.log.length, 60);
  console.log(`[${c.symbol}] ${msg}`);
  save();
}

// ---------- Solana helpers ----------

let chainCache = null;
function chainData() {
  if (chainCache && Date.now() - chainCache.at < 60_000) return chainCache.data;
  const data = Promise.all([
    retry(() => online.fetchGlobal()),
    retry(() => online.fetchFeeConfig()).catch(() => null),
    retry(() => rpc.getAddressLookupTable(LOOKUP_TABLE)).then((r) => r.value).catch(() => null),
  ]).then(([global, feeConfig, alt]) => ({ global, feeConfig, alt }));
  data.catch(() => { chainCache = null; });
  chainCache = { at: Date.now(), data };
  return data;
}

async function buildTx(payer, ixs, units, microLamports) {
  const [{ alt }, { blockhash }] = await Promise.all([chainData(), retry(() => rpc.getLatestBlockhash("confirmed"))]);
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      ...ixs,
    ],
  }).compileToV0Message(alt ? [alt] : []);
  return new VersionedTransaction(message);
}

/** Sends a signed transaction and waits up to ~60s for Solana to confirm it. */
async function sendAndConfirm(tx) {
  const raw = tx.serialize();
  const sig = await retry(() => rpc.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }), 3);
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const { value } = await rpc.getSignatureStatuses([sig]).catch(() => ({ value: [null] }));
    const s = value[0];
    if (s?.err) throw Object.assign(new Error(`failed on chain: ${JSON.stringify(s.err)}`), { sig });
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return sig;
    if (i % 4 === 3) rpc.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}); // re-broadcast
  }
  throw Object.assign(new Error("not confirmed in time (network busy)"), { sig });
}

async function sendIxs(signers, ixs, units, microLamports = PRIORITY.normal) {
  const tx = await buildTx(signers[0].publicKey, ixs, units, microLamports);
  tx.sign(signers);
  return sendAndConfirm(tx);
}

const balanceOf = (pub) => retry(() => rpc.getBalance(new PublicKey(pub), "confirmed"));

async function transferAll(from, to, keepLamports = 0) {
  const bal = await balanceOf(from.publicKey);
  const fee = 5000 + Math.ceil((1000 * PRIORITY.normal) / 1e6);
  if (bal <= fee + keepLamports) return 0;
  const lamports = bal - fee - keepLamports;
  await sendIxs([from], [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(to), lamports })], 1000);
  return lamports / SOL;
}

const tokenPrograms = new Map();
async function tokenProgramOf(mint) {
  if (tokenPrograms.has(mint)) return tokenPrograms.get(mint);
  const info = await retry(() => rpc.getAccountInfo(new PublicKey(mint)));
  if (!info) throw new Error("coin not found on chain");
  tokenPrograms.set(mint, info.owner);
  return info.owner;
}

// ---------- Image + metadata upload (Pinata) ----------

async function pinataUpload(blob, filename) {
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("network", "public");
  const r = await fetch("https://uploads.pinata.cloud/v3/files", { method: "POST", headers: { Authorization: `Bearer ${PINATA_JWT}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.data?.cid) throw new Error(`Pinata upload failed (${r.status})`);
  return `https://ipfs.io/ipfs/${j.data.cid}`;
}

async function uploadMetadata(c) {
  if (SIMULATE && !PINATA_JWT) return "https://example.com/practice-metadata.json";
  if (!PINATA_JWT) throw new UserError("PINATA_JWT is missing in .env");
  const bytes = fs.readFileSync(path.join(IMAGES, c.image));
  const imageUrl = await pinataUpload(new Blob([bytes], { type: c.imageType }), c.image);
  const metadata = {
    name: c.name, symbol: c.symbol, description: c.description, image: imageUrl, showName: true,
    ...(c.twitter && { twitter: c.twitter }), ...(c.telegram && { telegram: c.telegram }), ...(c.website && { website: c.website }),
  };
  return pinataUpload(new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
}

// ---------- Posting on X (optional, needs your own X developer keys) ----------

const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
async function postOnX(text) {
  const [key, secret, token, tokenSecret] = X_KEYS;
  const url = "https://api.x.com/2/tweets";
  const oauth = {
    oauth_consumer_key: key, oauth_nonce: randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: token, oauth_version: "1.0",
  };
  const params = Object.keys(oauth).sort().map((k) => `${pct(k)}=${pct(oauth[k])}`).join("&");
  const base = `POST&${pct(url)}&${pct(params)}`;
  oauth.oauth_signature = createHmac("sha1", `${pct(secret)}&${pct(tokenSecret)}`).update(base).digest("base64");
  const header = "OAuth " + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(", ");
  const r = await fetch(url, { method: "POST", headers: { Authorization: header, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`X said ${r.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return j.data?.id;
}

/** The post that goes out ~30s before launch (no CA yet - that comes in the reply). */
function launchPostText(c) {
  const b = brands.find((x) => x.id === c.brandId);
  const t = b?.launchPost || `${c.name} $${c.symbol}\n\n${(b?.tagline || c.description || "").slice(0, 160)}\n\n${c.website || ""}`;
  return t.replaceAll("{NAME}", c.name).replaceAll("{TICKER}", c.symbol).replaceAll("{WEBSITE}", c.website || "").trim();
}

function postText(c) {
  return (c.xPost || "{NAME} ${TICKER} is live on Pump.fun\n\nCA: {CA}\n\n{WEBSITE}")
    .replaceAll("{NAME}", c.name).replaceAll("{TICKER}", c.symbol).replaceAll("{CA}", c.mint || "")
    .replaceAll("{WEBSITE}", c.website || "").replaceAll("{LINK}", `https://pump.fun/coin/${c.mint}`).trim();
}

// ---------- Practice mode: a pretend bonding curve with pretend traders ----------

function simCurve(c) {
  c.sim ??= { vSol: 30, vTok: 1_073_000_000, devTokens: 0, fees: 0, crowd: 0.3 + Math.random() * 1.2 };
  return c.sim;
}
function simTrade(c, sol) {
  const s = simCurve(c);
  const k = s.vSol * s.vTok;
  const vSol = Math.max(1, s.vSol + sol);
  const tokens = s.vTok - k / vSol;
  s.vSol = vSol;
  s.vTok = k / vSol;
  s.fees += Math.abs(sol) * 0.003;
  return tokens;
}
const fakeAddr = () => Keypair.generate().publicKey.toBase58();
const SIM_BOTS = Array.from({ length: 8 }, fakeAddr); // practice bot group that shows up on many coins

function simTick(c) {
  const s = simCurve(c);
  const mins = (Date.now() - c.launchedAt) / 60_000;
  const chance = s.crowd * Math.max(0.15, 1 - mins / 40);
  const trades = [];
  const slot = Math.floor(Date.now() / 400);
  if (!s.sniped) {
    // practice snipers: 2-4 of the same bot wallets buy in the launch block
    s.sniped = true;
    for (const w of [...SIM_BOTS].sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 3))) trades.push({ wallet: w, sol: +(0.2 + Math.random() * 0.8).toFixed(3), slot });
  }
  if (Math.random() < 0.06 * s.crowd) {
    // a sniper bundle: several wallets buy in the same block
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) trades.push({ wallet: Math.random() < 0.3 ? pickOne(SIM_BOTS) : fakeAddr(), sol: +(0.1 + Math.random() * 0.6).toFixed(3), slot });
  }
  if (Math.random() < chance) {
    const known = c.stats.walletList ?? [];
    const sell = known.length && Math.random() < 0.35;
    trades.push({ wallet: sell ? known[Math.floor(Math.random() * known.length)] : fakeAddr(), sol: +((sell ? -1 : 1) * (0.02 + Math.random() * 0.5)).toFixed(3), slot: slot + 1 });
  }
  for (const t of trades) {
    simTrade(c, t.sol);
    addTrade(c, { ...t, t: Date.now(), sig: "practice" });
  }
}

// ---------- Watching trades ----------

function addTrade(c, t) {
  const st = c.stats;
  st.trades.unshift(t);
  st.trades.length = Math.min(st.trades.length, 40);
  if (t.wallet === c.wallet) return; // our own buys/sells are not "outside"
  // bot radar: who bought, how fast after launch, how much (first 400 wallets per coin)
  st.buyers ??= {};
  if (st.buyers[t.wallet] || (t.sol > 0 && Object.keys(st.buyers).length < 400)) {
    const b = (st.buyers[t.wallet] ??= { first: t.t, slot: t.slot, buy: 0, sell: 0 });
    if (t.sol > 0) b.buy = +(b.buy + t.sol).toFixed(4);
    else b.sell = +(b.sell - t.sol).toFixed(4);
  }
  st.walletList ??= [];
  if (t.sol > 0 && !st.walletList.includes(t.wallet)) st.walletList.push(t.wallet);
  st.outsideWallets = st.walletList.length;
  st.outsideVolume = +(st.outsideVolume + Math.abs(t.sol)).toFixed(4);
  const minute = Math.max(0, Math.floor((t.t - c.launchedAt) / 60_000));
  while (st.volumeByMinute.length <= minute) st.volumeByMinute.push(0);
  st.volumeByMinute[minute] = +(st.volumeByMinute[minute] + Math.abs(t.sol)).toFixed(4);
  // Bundle = 2+ different outside wallets buying in the very same Solana block.
  if (t.sol > 0) {
    st.slotBuys ??= {};
    const list = (st.slotBuys[t.slot] ??= []);
    if (!list.some((x) => x.wallet === t.wallet)) list.push({ wallet: t.wallet, sol: t.sol });
    const slots = Object.keys(st.slotBuys).map(Number).sort((a, b) => a - b);
    while (slots.length > 300) delete st.slotBuys[slots.shift()];
    st.bundles = Object.entries(st.slotBuys).filter(([, l]) => l.length >= 2)
      .map(([slot, l]) => ({ slot: Number(slot), wallets: l.length, sol: +l.reduce((a, x) => a + x.sol, 0).toFixed(3) }));
  }
}

/**
 * Fetches transactions 5 at a time (free RPC plans limit requests per second).
 * Asked for directly because the web3.js client can't read Solana's newer "version 1" transactions.
 */
async function getTransactions(sigs) {
  const out = [];
  for (let i = 0; i < sigs.length; i += 5) {
    const part = sigs.slice(i, i + 5);
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(RPC_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(part.map((s, n) => ({ jsonrpc: "2.0", id: n, method: "getTransaction", params: [s, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }))),
      });
      if (r.status === 429 && attempt < 5) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (!r.ok) throw new Error(`RPC said ${r.status}`);
      const j = await r.json();
      out.push(...j.sort((a, b) => a.id - b.id).map((x) => x.result ?? null));
      break;
    }
    await sleep(200);
  }
  return out;
}

// ---------- Pair coins (quoted in $PUMP, NVDAx, USDC... instead of SOL) ----------
// Everything is still shown in SOL: pair amounts are converted at the live Jupiter price.

const quoteKey = (c) => new PublicKey(c.quote.mint);
async function quoteProgram(c) {
  c.quote.tokenProgram ??= (await online.fetchQuoteTokenProgram(quoteKey(c))).toBase58();
  return new PublicKey(c.quote.tokenProgram);
}
async function quoteBalance(c) {
  const ata = getAssociatedTokenAddressSync(quoteKey(c), new PublicKey(c.wallet), false, await quoteProgram(c));
  return rpc.getTokenAccountBalance(ata).then((r) => new BN(r.value.amount)).catch(() => new BN(0));
}
const quoteUi = (c, raw) => Number(raw.toString()) / 10 ** c.quote.decimals;
const quoteInSol = async (c, raw) => quoteUi(c, raw) * (await priceInSol(c.quote.mint, c.quote.decimals));

/** Swaps everything the coin wallet holds of the pair token back to SOL (dust is left). Returns SOL gained. */
async function pairToSol(c) {
  const bal = await quoteBalance(c);
  if (bal.isZero() || (await quoteInSol(c, bal)) < 0.0005) return 0;
  const before = await balanceOf(c.wallet);
  await swap(keypair(c.id), c.quote.mint, SOL_MINT, bal.toString(), sendAndConfirm);
  return ((await balanceOf(c.wallet)) - before) / SOL;
}

/** Reads every new trade on the coin's bonding curve straight from Solana (no third-party API). */
async function scanTrades(c) {
  const curve = bondingCurvePda(c.mint);
  const sigs = await rpc.getSignaturesForAddress(curve, { until: c.stats.lastSig ?? undefined, limit: 200 });
  const fresh = sigs.filter((s) => !s.err).reverse(); // oldest first
  const pairPrice = isPair(c) && fresh.length ? await priceInSol(c.quote.mint, c.quote.decimals) : 1;
  for (let i = 0; i < fresh.length; i += 25) {
    const chunk = fresh.slice(i, i + 25);
    const txs = await getTransactions(chunk.map((s) => s.signature));
    txs.forEach((tx, j) => {
      if (!tx?.meta) return;
      const keysList = tx.transaction.message.accountKeys.map((k) => k.pubkey);
      const idx = keysList.indexOf(curve.toBase58());
      if (idx < 0) return;
      let sol; // + = someone bought
      if (isPair(c)) {
        // the curve's pair-token balance moves instead of its SOL
        const bal = (list) => Number(list?.find((b) => b.owner === curve.toBase58() && b.mint === c.quote.mint)?.uiTokenAmount.amount ?? 0);
        sol = ((bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances)) / 10 ** c.quote.decimals) * pairPrice;
      } else {
        sol = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / SOL;
      }
      if (Math.abs(sol) < 1e-6 || chunk[j].signature === c.sig) return; // skip the launch itself
      addTrade(c, { wallet: keysList[0], sol: +sol.toFixed(4), slot: tx.slot, t: (tx.blockTime ?? Date.now() / 1000) * 1000, sig: chunk[j].signature });
    });
  }
  if (sigs.length) c.stats.lastSig = sigs[0].signature; // only once every trade above was read
}

/** Dev bag value, claimable creator fees, wallet SOL and estimated profit. */
async function refreshMoney(c) {
  const st = c.stats;
  if (SIMULATE) {
    const s = simCurve(c);
    st.devBagSol = s.devTokens ? +(s.vSol - (s.vSol * s.vTok) / (s.vTok + s.devTokens)).toFixed(4) : 0;
    st.claimable = +(s.fees - st.feesClaimed).toFixed(4);
    st.walletSol = c.simWalletSol ?? 0;
  } else {
    const wallet = new PublicKey(c.wallet);
    const [walletLamports, claimable, bag, leftover] = await Promise.all([
      balanceOf(wallet),
      claimableSol(c, wallet).catch(() => st.claimable),
      devBag(c).catch(() => null),
      isPair(c) ? quoteBalance(c).then((b) => quoteInSol(c, b)).catch(() => 0) : 0, // pair tokens not swapped back yet
    ]);
    st.walletSol = walletLamports / SOL + leftover;
    st.claimable = claimable;
    if (bag) {
      st.devTokens = bag.tokens;
      st.devBagSol = bag.sol;
      st.graduated = bag.graduated;
    }
  }
  if (c.devBuySol > 0 && st.devBagSol > 0) st.peakX = Math.max(st.peakX, +(st.devBagSol / c.devBuySol).toFixed(3));
  st.profit = +(st.walletSol + st.devBagSol + st.claimable + c.withdrawnSol - c.fundedSol).toFixed(4);
}

/** Creator fees waiting to be claimed, in SOL (a pair coin's fees arrive in the pair token). */
async function claimableSol(c, wallet) {
  if (!isPair(c)) return (await online.getCreatorVaultBalanceBothPrograms(wallet)).toNumber() / SOL;
  let sol = 0;
  for (const b of await online.getCreatorVaultQuoteBalances(wallet, [quoteKey(c)])) {
    if (b.total.isZero()) continue;
    if (b.mint.toBase58() === SOL_MINT) sol += b.total.toNumber() / SOL;
    else if (b.mint.toBase58() === c.quote.mint) sol += await quoteInSol(c, b.total);
  }
  return sol;
}

async function devBag(c) {
  const mint = new PublicKey(c.mint);
  const tokenProgram = await tokenProgramOf(c.mint);
  const ata = getAssociatedTokenAddressSync(mint, new PublicKey(c.wallet), false, tokenProgram);
  const [bal, chain, info] = await Promise.all([
    rpc.getTokenAccountBalance(ata).then((r) => new BN(r.value.amount)).catch(() => new BN(0)),
    chainData(),
    rpc.getAccountInfo(bondingCurvePda(mint)),
  ]);
  if (!info || bal.isZero()) return { tokens: 0, sol: 0, graduated: false };
  const curve = PUMP_SDK.decodeBondingCurve(info);
  if (curve.complete) return { tokens: bal.toNumber() / 10 ** TOKEN_DECIMALS, sol: c.stats.devBagSol, graduated: true };
  const out = getSellSolAmountFromTokenAmount({ global: chain.global, feeConfig: chain.feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: bal });
  const sol = isPair(c) ? await quoteInSol(c, out) : out.toNumber() / SOL; // a pair coin sells into the pair token
  return { tokens: bal.toNumber() / 10 ** TOKEN_DECIMALS, sol, graduated: false };
}

// ---------- Actions (buttons + automatic steps) ----------

async function sellDevBag(c) {
  if (SIMULATE) {
    const s = simCurve(c);
    const got = c.stats.devBagSol;
    simTrade(c, -got);
    s.devTokens = 0;
    c.simWalletSol = (c.simWalletSol ?? 0) + got;
    addTrade(c, { wallet: c.wallet, sol: -got, slot: 0, t: Date.now(), sig: "practice" });
    return got;
  }
  const wallet = keypair(c.id);
  const mint = new PublicKey(c.mint);
  const tokenProgram = await tokenProgramOf(c.mint);
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgram);
  const balance = await rpc.getTokenAccountBalance(ata).then((r) => new BN(r.value.amount)).catch(() => new BN(0));
  if (balance.isZero()) throw new UserError("The dev wallet holds no tokens.");
  const before = await balanceOf(wallet.publicKey);
  const [state, chain] = await Promise.all([online.fetchSellState(mint, wallet.publicKey, tokenProgram, isPair(c) ? quoteKey(c) : undefined), chainData()]);
  if (isPair(c)) {
    if (state.bondingCurve.complete) {
      await swap(wallet, c.mint, SOL_MINT, balance.toString(), sendAndConfirm); // graduated: Jupiter routes it straight to SOL
    } else {
      const quoteAmount = getSellSolAmountFromTokenAmount({
        global: chain.global, feeConfig: chain.feeConfig, mintSupply: state.bondingCurve.tokenTotalSupply, bondingCurve: state.bondingCurve, amount: balance,
      });
      const ixs = await PUMP_SDK.sellV2Instructions({
        global: chain.global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve, mint, user: wallet.publicKey,
        amount: balance, quoteAmount, slippage: 30, tokenProgram, quoteTokenProgram: state.quoteTokenProgram,
      });
      ixs.push(createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, [], tokenProgram));
      await sendIxs([wallet], ixs, 260_000);
      await pairToSol(c); // the sale paid out in the pair token: back to SOL
    }
  } else if (state.bondingCurve.complete) {
    await pumpPortalSell(c, wallet);
  } else {
    const solAmount = getSellSolAmountFromTokenAmount({
      global: chain.global, feeConfig: chain.feeConfig, mintSupply: state.bondingCurve.tokenTotalSupply, bondingCurve: state.bondingCurve, amount: balance,
    });
    const ixs = await PUMP_SDK.sellInstructions({
      global: chain.global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve, mint, user: wallet.publicKey,
      amount: balance, solAmount, slippage: 30, tokenProgram, mayhemMode: state.bondingCurve.isMayhemMode, cashback: state.bondingCurve.isCashbackCoin,
    });
    ixs.push(createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, [], tokenProgram)); // gets the ~0.002 SOL rent back
    await sendIxs([wallet], ixs, 160_000);
  }
  return ((await balanceOf(wallet.publicKey)) - before) / SOL;
}

/** Coins that graduated to PumpSwap: PumpPortal builds the sell, it's signed here so the key never leaves. */
async function pumpPortalSell(c, wallet) {
  const r = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: c.wallet, action: "sell", mint: c.mint, amount: "100%", denominatedInSol: "false", slippage: 30, priorityFee: 0.0002, pool: "auto" }),
  });
  if (!r.ok) throw new Error(`PumpPortal sell failed (${r.status})`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
  tx.sign([wallet]);
  return sendAndConfirm(tx);
}

async function claimFees(c) {
  if (SIMULATE) {
    const got = c.stats.claimable;
    c.stats.feesClaimed = +(c.stats.feesClaimed + got).toFixed(4);
    c.simWalletSol = (c.simWalletSol ?? 0) + got;
    return got;
  }
  const wallet = keypair(c.id);
  const before = await balanceOf(wallet.publicKey);
  if (isPair(c)) {
    // fees sit in the pair token: claim every quote, then swap the pair token back to SOL
    const ixs = await online.collectCoinCreatorFeeAllQuotesInstructions(wallet.publicKey, wallet.publicKey, [quoteKey(c)]);
    await sendIxs([wallet], ixs, 300_000);
    await pairToSol(c);
  } else {
    const ixs = await online.collectCoinCreatorFeeInstructions(wallet.publicKey, wallet.publicKey);
    await sendIxs([wallet], ixs, 120_000);
  }
  const got = ((await balanceOf(wallet.publicKey)) - before) / SOL;
  c.stats.feesClaimed = +(c.stats.feesClaimed + Math.max(0, got)).toFixed(4);
  return got;
}

/**
 * Sends the coin wallet's SOL back to the AUTOPILOT main wallet. While the coin is still watched a small reserve
 * stays behind, so the wallet stays open and can keep claiming creator fees. Stopped coins are emptied fully.
 */
async function withdrawCoin(c) {
  const keep = c.stage === "stopped" ? 0 : COIN_RESERVE_LAMPORTS;
  if (SIMULATE) {
    const got = Math.max(0, (c.simWalletSol ?? 0) - keep / SOL);
    c.simWalletSol = (c.simWalletSol ?? 0) - got;
    c.withdrawnSol = +(c.withdrawnSol + got).toFixed(4);
    return got;
  }
  if (isPair(c)) await pairToSol(c).catch((e) => log(c, `Couldn't swap leftover ${c.quote.symbol} to SOL: ${e.message}`));
  const got = await transferAll(keypair(c.id), mainWallet.publicKey, keep);
  c.withdrawnSol = +(c.withdrawnSol + got).toFixed(4);
  return got;
}

async function launch(c) {
  const wallet = keypair(c.id);
  const mintKp = Keypair.generate();
  keys[`${c.id}:mint`] = Array.from(mintKp.secretKey);
  save();
  if (SIMULATE) {
    await sleep(1500);
    c.mint = mintKp.publicKey.toBase58();
    c.sig = "practice";
    const s = simCurve(c);
    s.devTokens = c.devBuySol > 0 ? simTrade(c, c.devBuySol) : 0;
    c.simWalletSol = FUND_EXTRA_SOL - 0.008;
    return;
  }
  c.uri ??= await uploadMetadata(c);
  save();
  const { global, feeConfig } = await chainData();
  const user = wallet.publicKey;
  let ixs;
  let units = c.devBuySol > 0 ? 230_000 : 125_000;
  if (isPair(c)) {
    // paired coin: the dev buy is paid with the pair token bought in the "Buy pair" step
    const quoteMint = quoteKey(c);
    const quoteTokenProgram = await quoteProgram(c);
    const base = { mint: mintKp.publicKey, name: c.name, symbol: c.symbol, uri: c.uri, creator: user, user, mayhemMode: false, quoteMint, quoteTokenProgram };
    const held = c.devBuySol > 0 ? await quoteBalance(c) : new BN(0);
    if (held.isZero()) {
      ixs = [await PUMP_SDK.createV2Instruction(base)];
      units = 250_000;
    } else {
      const quoteAmount = held.muln(97).divn(100); // the buy may cost up to 2% more; keep 3% room
      const quoteControl = await online.fetchQuoteControl();
      const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: quoteAmount, quoteMint, quoteControl });
      ixs = await PUMP_SDK.createV2AndBuyV2Instructions({ global, ...base, amount, quoteAmount, slippage: 2 });
      units = 450_000; // measured ~350k on mainnet for $PUMP / NVDAx pairs
    }
  } else if (c.devBuySol > 0) {
    const solAmount = new BN(Math.round(c.devBuySol * SOL));
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: NATIVE_MINT });
    ixs = await PUMP_SDK.createV2AndBuyInstructions({ global, mint: mintKp.publicKey, name: c.name, symbol: c.symbol, uri: c.uri, creator: user, user, amount, solAmount, mayhemMode: false });
  } else {
    ixs = [await PUMP_SDK.createV2Instruction({ mint: mintKp.publicKey, name: c.name, symbol: c.symbol, uri: c.uri, creator: user, user, mayhemMode: false })];
  }
  const tx = await buildTx(user, ixs, units, PRIORITY.launch);
  const sim = await rpc.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) throw new Error(`launch would fail: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-2).join(" ")}`);
  tx.sign([wallet, mintKp]);
  c.pendingMint = mintKp.publicKey.toBase58(); // if confirming times out we check this before ever trying again
  save();
  c.sig = await sendAndConfirm(tx);
  c.mint = c.pendingMint;
}

// ---------- The autopilot ----------
// Stages: fund -> (pair) -> upload -> launch -> post -> checks -> earning   (or dud / stopped / failed)
// "pair" (Buy pair) only runs for coins paired with a token other than SOL.

const newStats = () => ({
  outsideWallets: 0, outsideVolume: 0, feesClaimed: 0, claimable: 0, devBagSol: 0, devTokens: 0, peakX: 0, profit: 0,
  walletSol: 0, volumeByMinute: [], trades: [], bundles: [], walletList: [], lastSig: null,
});

async function step(c) {
  const now = Date.now();
  switch (c.stage) {
    case "fund": {
      if (now < c.launchAt - FUND_LEAD_MS) return void (c.status = "Scheduled");
      const need = c.devBuySol + FUND_EXTRA_SOL + (isPair(c) ? FUND_PAIR_EXTRA_SOL : 0);
      const next = isPair(c) ? "pair" : "upload";
      if (SIMULATE) {
        c.fundedSol = need;
        log(c, `Practice: fresh wallet funded with ${need.toFixed(3)} SOL`);
        c.stage = next;
        return;
      }
      const have = (await balanceOf(c.wallet)) / SOL;
      if (have >= need - 0.0005) {
        c.fundedSol = Math.max(c.fundedSol, have);
        log(c, `Fresh wallet has ${have.toFixed(3)} SOL - ready`);
        c.stage = next;
        return;
      }
      const missing = need - have + 0.0005;
      const mainBal = (await balanceOf(mainWallet.publicKey)) / SOL;
      if (mainBal < missing + 0.001) {
        c.status = `Waiting for SOL - main wallet needs ${(missing + 0.001 - mainBal).toFixed(3)} more`;
        return;
      }
      await sendIxs([mainWallet], [SystemProgram.transfer({ fromPubkey: mainWallet.publicKey, toPubkey: new PublicKey(c.wallet), lamports: Math.ceil(missing * SOL) })], 1000);
      c.fundedSol += missing;
      log(c, `Sent ${missing.toFixed(3)} SOL from main wallet to the fresh wallet`);
      return;
    }
    case "pair": {
      // Buy pair: swap the dev buy's SOL into the pair token, so the coin can be launched and bought with it.
      if (SIMULATE || c.devBuySol === 0) {
        if (SIMULATE) log(c, `Practice: bought ${c.quote.symbol} with ${c.devBuySol} SOL`);
        c.stage = "upload";
        return;
      }
      let held = await quoteBalance(c);
      if (held.isZero()) {
        // only swap while the wallet holds none, and give a slow swap 90s to land before trying again
        if (now - (c.pairSwapAt ?? 0) < 90_000) return void (c.status = `Waiting for the ${c.quote.symbol} buy to land`);
        c.pairSwapAt = now;
        c.status = `Buying ${c.quote.symbol}...`;
        await swap(keypair(c.id), SOL_MINT, c.quote.mint, Math.round(c.devBuySol * SOL), sendAndConfirm).catch((e) => {
          if (!/not confirmed in time/.test(e.message)) throw e;
        });
        held = await quoteBalance(c);
        if (held.isZero()) return void (c.status = `Waiting for the ${c.quote.symbol} buy to land`);
      }
      log(c, `Bought ${quoteUi(c, held).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${c.quote.symbol} for ${c.devBuySol} SOL`);
      c.stage = "upload";
      return;
    }
    case "upload": {
      // The website link goes into the coin's Pump.fun details, so wait until the site is up.
      if (c.site?.status === "building") return void (c.status = "Waiting for the website to go live");
      // With a connected X account the launch post's link goes into the details too, so upload just before launch instead.
      if (!SIMULATE && !c.xAccountId) c.uri ??= await uploadMetadata(c);
      log(c, c.xAccountId ? "Ready - details upload right after the X post" : "Image + details uploaded");
      c.stage = "launch";
      return;
    }
    case "launch": {
      // Post on X ~30s before launch: the post becomes the coin's X link on pump.fun, then we reply with the CA.
      if (c.xAccountId && !c.xPostTried && now >= c.launchAt - X_LEAD_MS) {
        c.xPostTried = true;
        const handle = xa.find(c.xAccountId)?.handle;
        if (SIMULATE) {
          c.xPostId = "practice";
          log(c, `Practice: would post on X from @${handle ?? "?"}: "${launchPostText(c).split("\n")[0]}…"`);
        } else {
          try {
            const p = await xa.post(c.xAccountId, launchPostText(c));
            Object.assign(c, { xPostId: p.id, twitter: p.url, uri: null, posted: true });
            log(c, `Posted on X from @${handle}: ${p.url}`);
          } catch (e) {
            log(c, `X launch post failed: ${e.message} - launching without it`);
          }
        }
      }
      if (now < c.launchAt) return void (c.status = c.xAccountId && !c.xPostTried ? `Ready - posts on X ${Math.round(X_LEAD_MS / 1000)}s before launch` : "Ready - waiting for launch time");
      c.status = "Launching...";
      try {
        if (c.pendingMint && (await rpc.getAccountInfo(new PublicKey(c.pendingMint)))) {
          c.mint = c.pendingMint; // the last try did land after all - never launch twice
        } else {
          await launch(c);
        }
      } catch (e) {
        c.tries = (c.tries ?? 0) + 1;
        log(c, `Launch try ${c.tries} failed: ${e.message}`);
        if (c.tries >= 3) {
          c.stage = "failed";
          c.status = "Launch failed 3 times - SOL is still in the fresh wallet (Withdraw)";
        }
        return;
      }
      c.launchedAt = Date.now();
      c.stats = newStats();
      log(c, `LAUNCHED - CA ${c.mint}`);
      c.stage = "post";
      return;
    }
    case "post": {
      if (c.site?.status === "live") {
        updateSiteCA(c, IMAGES).then(() => log(c, "Website now shows the CA"), (e) => log(c, `Couldn't put the CA on the website: ${e.message}`));
      }
      if (c.xAccountId && c.xPostId) {
        // reply to our own launch post with the CA
        if (SIMULATE) log(c, "Practice: would reply on X with the CA");
        else {
          try {
            const p = await xa.post(c.xAccountId, postText(c), c.xPostId);
            log(c, `Replied on X with the CA: ${p.url}`);
          } catch (e) {
            log(c, `X CA reply failed: ${e.message} - use "Copy CA post"`);
          }
        }
      } else if (c.xAccountId && !SIMULATE) {
        try {
          const p = await xa.post(c.xAccountId, postText(c));
          c.posted = true;
          log(c, `Posted the CA on X: ${p.url}`);
        } catch (e) {
          log(c, `X post failed: ${e.message} - use "Copy CA post" instead`);
        }
      } else if (X_READY && !SIMULATE) {
        try {
          const id = await postOnX(postText(c));
          c.posted = true;
          log(c, `Posted on X (tweet ${id})`);
        } catch (e) {
          log(c, `X post failed: ${e.message} - use "Copy CA post" instead`);
        }
      } else {
        log(c, SIMULATE ? "Practice: X post skipped" : "X keys not set - use \"Copy CA post\" and post it yourself");
      }
      c.stage = "checks";
      return;
    }
    case "checks":
    case "earning":
    case "dud": {
      const every = c.stage === "checks" ? 4_000 : c.stage === "earning" ? 15_000 : 60_000;
      if (now - (c.lastScan ?? 0) < every) return;
      c.lastScan = now;
      if (SIMULATE) simTick(c);
      else await scanTrades(c);
      await refreshMoney(c);

      // Take profit: dev bag worth N x the dev buy -> sell it all and send the SOL to the main wallet.
      const tp = c.takeProfitX ?? 2;
      if (tp > 0 && !c.soldAt && c.devBuySol > 0 && c.stats.devBagSol >= c.devBuySol * tp) {
        const got = await sellDevBag(c);
        c.soldAt = now;
        log(c, `Hit ${tp}x - sold dev bag for ${got.toFixed(4)} SOL`);
        log(c, `Withdrew ${(await withdrawCoin(c)).toFixed(4)} SOL to main wallet (kept 0.003 so fees can still be claimed)`);
        if (c.stage === "checks") Object.assign(c, { stage: "earning", passed: true });
        await refreshMoney(c);
      }

      if (c.stage === "checks" && now >= c.launchedAt + c.checkMinutes * 60_000) {
        if (c.stats.outsideWallets >= c.minWallets) {
          c.stage = "earning";
          c.passed = true;
          log(c, `Passed the ${c.checkMinutes}-min check: ${c.stats.outsideWallets} outside wallets`);
        } else {
          await markDud(c, `Failed the ${c.checkMinutes}-min check: only ${c.stats.outsideWallets}/${c.minWallets} outside wallets`);
        }
      }
      // Creator fees keep coming as long as people trade, even after a sell or a dud: claim + send to main wallet.
      if (c.stage !== "checks" && c.autoClaimSol > 0 && c.stats.claimable >= c.autoClaimSol) {
        const got = await claimFees(c);
        log(c, `Auto-claimed ${got.toFixed(4)} SOL creator fees`);
        log(c, `Withdrew ${(await withdrawCoin(c)).toFixed(4)} SOL to main wallet`);
        await refreshMoney(c);
      }
      c.status = { checks: "Live - checking", earning: c.soldAt ? "Sold - collecting fees" : "Earning", dud: "Dud" }[c.stage];
      return;
    }
  }
}

async function markDud(c, why) {
  c.stage = "dud";
  log(c, why);
  if (c.autoSellDud && c.stats.devBagSol > 0) {
    try {
      const got = await sellDevBag(c);
      c.soldAt = Date.now();
      log(c, `Auto-sold dev bag for ${got.toFixed(4)} SOL`);
      if (c.stats.claimable > 0.001) log(c, `Claimed ${(await claimFees(c)).toFixed(4)} SOL fees`);
      log(c, `Withdrew ${(await withdrawCoin(c)).toFixed(4)} SOL to main wallet`);
    } catch (e) {
      log(c, `Auto-sell failed: ${e.message} - press "Sell dev bag"`);
    }
    await refreshMoney(c).catch(() => {});
  }
}

let ticking = false;
async function tick() {
  if (ticking || restoring) return;
  ticking = true;
  try {
    // Every coin runs side by side, so one slow launch never delays another coin's launch time.
    await Promise.all(coins.filter((c) => !c.busy && !["stopped", "failed"].includes(c.stage)).map(async (c) => {
      c.busy = true;
      try {
        await step(c);
      } catch (e) {
        c.status = `Problem: ${e.message} (retrying)`;
        console.error(`[${c.symbol}]`, e.message);
      } finally {
        c.busy = false;
        save();
      }
    }));
  } finally {
    ticking = false;
  }
}
setInterval(tick, 2000);

// ---------- Web API ----------

const publicCoin = (c) => {
  const { sim, busy, uri, ...rest } = c;
  const { walletList, slotBuys, lastSig, buyers, ...stats } = c.stats ?? {};
  return { ...rest, stats, postText: c.mint ? postText(c) : "" };
};

let mainBalCache = { at: 0, sol: 0 };
async function mainBalance() {
  if (Date.now() - mainBalCache.at > 10_000) mainBalCache = { at: Date.now(), sol: (await balanceOf(mainWallet.publicKey).catch(() => mainBalCache.sol * SOL)) / SOL };
  return mainBalCache.sol;
}

async function buildSiteFor(c) {
  c.site = { status: "building" };
  save();
  try {
    const url = await buildSite(c, IMAGES, (m) => log(c, m));
    c.website = url;
    c.site = { status: "live", url };
    log(c, `Website live: ${url}`);
  } catch (e) {
    c.site = { status: "failed", error: e.message };
    log(c, `Website failed: ${e.message}`);
  }
  save();
}

async function addCoin(form) {
  const str = (k) => String(form.get(k) ?? "").trim();
  const optUrl = (k) => {
    const v = str(k);
    if (!v) return "";
    if (!/^https?:\/\/\S+$/i.test(v) || v.length > 200) throw new UserError(`The ${k} link must start with https://`);
    return v;
  };
  const c = {
    id: randomBytes(6).toString("hex"),
    name: str("name"), symbol: str("symbol").toUpperCase().replace(/^\$/, ""), description: str("description"),
    website: optUrl("website"), twitter: optUrl("twitter"), telegram: optUrl("telegram"),
    xPost: str("xPost").slice(0, 280),
    devBuySol: Number(str("devBuySol") || 0),
    launchAt: str("launchAt") === "now" ? Date.now() : Number(str("launchAt")),
    checkMinutes: Number(str("checkMinutes") || 5),
    minWallets: Number(str("minWallets") || 15),
    autoSellDud: str("autoSellDud") === "on",
    autoClaimSol: Number(str("autoClaimSol") || 0),
    takeProfitX: Number(str("takeProfitX") || 0),
    makeSite: str("makeSite") === "on",
    sub: str("sub").toLowerCase() || str("symbol").toLowerCase().replace(/^\$/, ""),
    tagline: str("tagline").slice(0, 80),
    story: str("story").slice(0, 600),
    accent: str("accent"),
  };
  if (c.makeSite && !siteConfig.enabled) throw new UserError("The website maker only works on your PC.");
  const quoteMint = str("quote") || SOL_MINT;
  if (quoteMint !== SOL_MINT) {
    const pair = (await pairList(online, RPC_URL)).find((p) => p.mint === quoteMint);
    if (!pair) throw new UserError("Pump.fun doesn't accept that pair token.");
    let decimals = pair.decimals;
    if (!Number.isInteger(decimals)) decimals = (await rpc.getParsedAccountInfo(new PublicKey(quoteMint))).value?.data?.parsed?.info?.decimals;
    if (!Number.isInteger(decimals)) throw new UserError("Couldn't read that pair token - try again.");
    if (!SIMULATE) await priceInSol(quoteMint, decimals).catch(() => { throw new UserError(`No swap route for ${pair.symbol} right now - pick another pair.`); });
    c.quote = { mint: quoteMint, symbol: pair.symbol, decimals };
  }
  if (c.makeSite) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(c.sub)) throw new UserError("Subdomain can only use letters, numbers and dashes.");
    if (coins.some((x) => x.sub === c.sub && x.makeSite)) throw new UserError(`${c.sub}.${siteConfig.domain} is already used by another coin.`);
  }
  const image = form.get("image");
  if (!c.name || c.name.length > 32) throw new UserError("Name must be 1-32 characters.");
  if (!/^[A-Z0-9]{1,10}$/.test(c.symbol)) throw new UserError("Ticker must be 1-10 letters or numbers.");
  if (c.description.length > 1000) throw new UserError("Description must be under 1000 characters.");
  if (!(image instanceof File) || !image.size) throw new UserError("Pick an image for the coin.");
  if (!/^image\/(png|jpeg|gif|webp)$/.test(image.type)) throw new UserError("Image must be PNG, JPG, GIF or WebP.");
  if (image.size > 10 * 1024 * 1024) throw new UserError("Image must be 10MB or smaller.");
  if (!(c.devBuySol >= 0 && c.devBuySol <= 20)) throw new UserError("Dev buy must be between 0 and 20 SOL.");
  if (!Number.isFinite(c.launchAt)) throw new UserError("Pick a launch time.");
  if (!(c.checkMinutes >= 1 && c.checkMinutes <= 120)) throw new UserError("Check time must be 1-120 minutes.");
  if (!(c.minWallets >= 1 && c.minWallets <= 1000)) throw new UserError("Needed wallets must be 1-1000.");
  if (!(c.takeProfitX === 0 || (c.takeProfitX > 1 && c.takeProfitX <= 100))) throw new UserError("Auto-sell must be above 1x (or 0 for off).");
  if (!SIMULATE && !PINATA_JWT) throw new UserError("Add PINATA_JWT to the .env file first (see HOW-TO.txt).");

  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[image.type];
  c.image = `${c.id}.${ext}`;
  c.imageType = image.type;
  fs.writeFileSync(path.join(IMAGES, c.image), Buffer.from(await image.arrayBuffer()));
  return registerCoin(c);
}

/** Gives a new coin its fresh wallet and puts it on the autopilot. */
function registerCoin(c) {
  const wallet = Keypair.generate(); // the fresh wallet: creator of this coin, gets its creator fees
  keys[c.id] = Array.from(wallet.secretKey);
  Object.assign(c, {
    wallet: wallet.publicKey.toBase58(), number: coins.length + 1, createdAt: Date.now(),
    stage: "fund", status: "Scheduled", fundedSol: 0, withdrawnSol: 0, posted: false, mint: null, stats: newStats(), log: [],
  });
  coins.unshift(c);
  log(c, `Added - launch ${c.launchAt <= Date.now() ? "now" : "at " + new Date(c.launchAt).toLocaleString()}`);
  if (c.makeSite) buildSiteFor(c); // runs in the background (about a minute)
  return publicCoin(c);
}

// ---------- Brands: ideas -> approved queue -> live -> runner / retired ----------

function ideaContext() {
  return {
    safe: brain.safeWords(60), hot: brain.hotWords(6, 60),
    usedNames: new Set([...brands.map((b) => b.name.toLowerCase()), ...coins.map((c) => c.name.toLowerCase())]),
    usedTickers: new Set([...brands.map((b) => b.symbol), ...coins.map((c) => c.symbol)]),
    seen: brain.nameSeen,
  };
}

const clashQueue = [];
let clashBusy = false;
async function runClashChecks() {
  if (clashBusy) return;
  clashBusy = true;
  try {
    while (clashQueue.length) {
      const b = brands.find((x) => x.id === clashQueue.shift());
      if (!b) continue;
      b.clash = { pending: true };
      b.clash = await checkClash(b);
      save();
      await sleep(1200); // DexScreener allows ~60 searches a minute
    }
  } finally {
    clashBusy = false;
  }
}
function queueClash(b) {
  b.clash = { pending: true };
  clashQueue.push(b.id);
  runClashChecks();
}

function newBrand(fields, source) {
  const b = {
    id: randomBytes(5).toString("hex"), status: "idea", source, createdAt: Date.now(), tries: [],
    website: "", twitter: "", telegram: "", order: 0, ...fields,
  };
  brands.unshift(b);
  queueClash(b);
  return b;
}

function generateIdeas(count, source) {
  const ctx = ideaContext();
  if (!ctx.safe.length && !ctx.hot.length) throw new UserError("The brain hasn't learned any market words yet - leave AUTOPILOT running for an hour or two, then try again.");
  const made = makeIdeas(count, source, ctx).map(({ check, ...idea }) => newBrand({ ...idea, check }, "brain"));
  if (!made.length) throw new UserError("No new names passed the checks right now - try again later or switch the source.");
  save();
  return made.length;
}

function brandTries(b) {
  return b.tries.map((t) => ({ ...t, coin: coins.find((c) => c.id === t.coinId) }));
}

/** Moves a brand along after each try: runner if a try took off, retired after its last try, else waits for the retry. */
function updateBrand(b) {
  if (!["approved", "live"].includes(b.status)) return;
  const tries = brandTries(b);
  if (!tries.length) return void (b.status = "approved");
  if (tries.some((t) => t.coin?.passed)) {
    b.status = "runner";
    return apLog(`${b.name} is a runner - no more retries needed`);
  }
  const last = tries[tries.length - 1].coin;
  if (last && ["fund", "pair", "upload", "launch", "post", "checks"].includes(last.stage)) return void (b.status = "live");
  const max = settings.triesPerDay * settings.maxDays;
  const ageDays = (Date.now() - tries[0].at) / 86400_000;
  if (tries.length >= max || ageDays >= settings.maxDays) {
    b.status = "retired";
    return apLog(`${b.name} retired after ${tries.length} ${tries.length === 1 ? "try" : "tries"}`);
  }
  const lastEnd = last?.launchedAt ?? tries[tries.length - 1].at;
  let next = lastEnd + settings.retryGapMinutes * 60_000;
  const today = tries.filter((t) => Date.now() - t.at < 86400_000);
  if (today.length >= settings.triesPerDay) next = Math.max(next, today[0].at + 86400_000);
  b.status = "approved";
  b.nextTryAt = next;
}

const PRE_LAUNCH = ["fund", "pair", "upload", "launch"];
let apStatus = "Autopilot is off";
let lastSweep = 0;

function localHour() {
  return new Date(Date.now() - settings.tzOffset * 60_000).getUTCHours();
}
function inWindow() {
  const { windowStart: a, windowEnd: b } = settings;
  const h = localHour();
  if (a === b || (a === 0 && b === 24)) return true;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/** The next brand to launch: a retry that is due first, then new brands in queue order. */
function nextBrand() {
  const now = Date.now();
  // ready = has a logo and its website isn't still being written
  const ready = brands.filter((b) => b.status === "approved" && b.image && (b.plan || b.website) && b.prep?.art !== "working" && b.prep?.site !== "working"
    && (b.notBefore ?? 0) <= now); // a coin you gave a set time waits for it
  const retries = ready.filter((b) => b.tries.length && (b.nextTryAt ?? 0) <= now).sort((a, b) => a.nextTryAt - b.nextTryAt);
  if (retries.length) return retries[0];
  return ready.filter((b) => !b.tries.length).sort((a, b) => a.order - b.order || a.approvedAt - b.approvedAt)[0];
}

function launchBrand(b) {
  const s = settings;
  const c = {
    id: randomBytes(6).toString("hex"), brandId: b.id, tryNo: b.tries.length + 1, auto: true,
    name: b.name, symbol: b.symbol, description: b.description ?? "", website: b.website || (b.plan ? siteUrl(b) : ""), twitter: b.twitter, telegram: b.telegram,
    xAccountId: brandX(b)?.id ?? null,
    xPost: b.xPost ?? "", devBuySol: s.devBuySol, launchAt: Date.now() + s.leadMinutes * 60_000, checkMinutes: s.checkMinutes,
    minWallets: s.minWallets, autoSellDud: true, autoClaimSol: s.autoClaimSol, takeProfitX: s.takeProfitX, makeSite: false,
    image: b.image, imageType: b.imageType,
  };
  registerCoin(c);
  b.tries.push({ coinId: c.id, at: Date.now() });
  b.status = "live";
  apLog(`Started try ${c.tryNo} of ${b.name} $${b.symbol} - launches in ${s.leadMinutes} min with ${s.devBuySol} SOL dev buy${c.xAccountId ? ` · posts from @${brandX(b).handle}` : ""}`);
}

// ---------- Logo, banner + website for every approved brand (made by themselves) ----------

function slugOf(b) {
  if (b.slug) return b.slug;
  let s = b.symbol.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30) || b.id;
  if (brands.some((x) => x !== b && x.slug === s)) s = `${s}-${b.id.slice(0, 4)}`;
  return (b.slug = s);
}
function baseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.trim().replace(/\/$/, "");
  return PUBLIC ? `https://${settings.lastHost || "localhost"}` : `http://localhost:${PORT}`;
}
function siteUrl(b) {
  return SITE_DOMAIN ? `https://${slugOf(b)}.${SITE_DOMAIN}` : `${baseUrl()}/s/${slugOf(b)}`;
}
/** Which X account posts for this brand: its own pick, else your default account. */
function brandX(b) {
  const id = b.xAccountId && b.xAccountId !== "auto" ? b.xAccountId : b.xAccountId === "none" ? null : settings.defaultX;
  return id ? xa.find(id) ?? null : null;
}

let prepBusy = false;
/** One job at a time: logo + banner first (needed to launch), then the website plan. */
async function prepTick() {
  if (prepBusy || restoring) return;
  const b = brands.find((x) => ["approved", "live"].includes(x.status) && ((!x.image && !x.prep?.artFailed) || (!x.plan && !x.prep?.siteFailed && !x.website)));
  if (!b) return;
  prepBusy = true;
  b.prep ??= {};
  try {
    if (!b.image) {
      b.prep.art = "working";
      save();
      try {
        const a = await makeArt(b, b.prep.artSeed ?? 0);
        const stamp = Date.now().toString(36);
        b.image = `b-${b.id}-${stamp}.png`;
        b.imageType = "image/png";
        b.banner = `b-${b.id}-${stamp}-banner.png`;
        b.palette = a.palette;
        fs.writeFileSync(path.join(IMAGES, b.image), a.logo);
        fs.writeFileSync(path.join(IMAGES, b.banner), a.banner);
        b.prep.art = a.by;
        apLog(`${b.name}: logo + banner made (${a.by === "claude" ? "by Claude" : "built-in design"})${a.note ? ` - ${a.note}` : ""}`);
      } catch (e) {
        Object.assign(b.prep, { art: "failed", artFailed: aiError(e) });
        apLog(`${b.name}: logo failed - ${aiError(e)}`);
      }
    } else if (!b.plan) {
      b.prep.site = "working";
      save();
      try {
        b.plan = await planSite(b);
        b.prep.site = b.plan.by;
        apLog(`${b.name}: website ready at ${siteUrl(b)} (${b.plan.by === "claude" ? "written by Claude" : "template text - add a Claude key for custom writing"})`);
      } catch (e) {
        b.plan = templatePlan(b); // never leave a coin without a site
        Object.assign(b.prep, { site: "template", siteNote: aiError(e) });
        apLog(`${b.name}: Claude couldn't write the site (${aiError(e)}) - used the template`);
      }
    }
  } finally {
    prepBusy = false;
    save();
  }
}
setInterval(() => prepTick().catch((e) => console.error("[prep]", e)), 3000);

/** The coin's page, with the CA of its latest launched try. */
function sitePage(b) {
  const tries = b.tries.map((t) => coins.find((c) => c.id === t.coinId)).filter((c) => c?.mint);
  const last = tries[tries.length - 1];
  const x = brandX(b);
  const url = siteUrl(b);
  const asset = (f) => (SITE_DOMAIN ? `${url}/${f}` : `${url}/${f}`);
  return renderSite({
    plan: b.plan ?? templatePlan(b), brand: { ...b, x }, ca: last?.mint ?? "", siteUrl: url,
    xUrl: b.twitter || (x ? `https://x.com/${x.handle}` : ""), logo: asset("logo.png"), banner: asset(b.banner ? "banner.png" : "logo.png"),
  });
}

/** Serves /s/<slug>/... or <slug>.SITE_DOMAIN/... - public, no login. Returns true if it answered. */
function serveSite(req, res, url) {
  let slug = null, rest = "";
  const host = String(req.headers.host || "").toLowerCase().split(":")[0];
  if (SITE_DOMAIN && host.endsWith(`.${SITE_DOMAIN}`)) {
    slug = host.slice(0, -SITE_DOMAIN.length - 1);
    rest = url.pathname.replace(/^\/+/, "");
  } else {
    const m = /^\/s\/([a-z0-9-]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!m) return false;
    if (m[2] === undefined) { res.writeHead(301, { Location: `/s/${m[1]}/` }); res.end(); return true; }
    [slug, rest] = [m[1], m[2]];
  }
  const b = brands.find((x) => x.slug === slug && !["rejected", "idea"].includes(x.status));
  if (!b || req.method !== "GET") { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return true; }
  if (rest === "logo.png" || rest === "banner.png") {
    const f = rest === "logo.png" ? b.image : b.banner;
    if (!f || !fs.existsSync(path.join(IMAGES, f))) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { "Content-Type": rest === "logo.png" ? b.imageType || "image/png" : "image/png", "Cache-Control": "max-age=300" });
    fs.createReadStream(path.join(IMAGES, f)).pipe(res);
    return true;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "max-age=30" });
  res.end(sitePage(b));
  return true;
}

async function autopilotTick() {
  for (const b of brands) updateBrand(b);
  // a failed autopilot launch: stop it and bring its SOL back to the float
  for (const c of coins) {
    if (!c.auto || c.stage !== "failed" || c.busy) continue;
    c.stage = "stopped";
    c.busy = true;
    try {
      const got = await withdrawCoin(c);
      log(c, `Autopilot brought ${got.toFixed(4)} SOL back to the main wallet`);
    } catch (e) {
      c.stage = "failed";
      log(c, `Couldn't bring SOL back yet: ${e.message}`);
    } finally {
      c.busy = false;
    }
  }
  await profitSweep().catch((e) => apLog(`Profit sweep failed: ${e.message}`));

  const s = settings;
  const now = Date.now();
  autoIdeas();
  if (!s.autopilot) return void (apStatus = "Autopilot is off");
  if (s.paused) return void (apStatus = "Paused - nothing new goes out");
  if (s.spendLock) return void (apStatus = "Spending lock is on - nothing new gets funded");
  if (coins.some((c) => c.auto && PRE_LAUNCH.includes(c.stage))) return void (apStatus = "A launch is getting ready");
  if (!inWindow()) return void (apStatus = `Outside launch hours (${s.windowStart}:00-${s.windowEnd}:00 your time)`);
  const auto = coins.filter((c) => c.auto);
  if (auto.filter((c) => now - c.createdAt < 86400_000).length >= s.maxLaunchesPerDay) return void (apStatus = `Daily cap reached (${s.maxLaunchesPerDay} launches in 24h)`);
  const last = Math.max(0, ...auto.map((c) => c.createdAt));
  if (now - last < s.minGapMinutes * 60_000) return void (apStatus = `Next launch allowed in ${Math.ceil((last + s.minGapMinutes * 60_000 - now) / 60_000)} min (gap between launches)`);
  const b = nextBrand();
  if (!b) {
    const waiting = brands.filter((x) => x.status === "approved" && x.image && x.nextTryAt > now).sort((x, y) => x.nextTryAt - y.nextTryAt)[0];
    return void (apStatus = waiting ? `Next retry: ${waiting.name} in ${Math.ceil((waiting.nextTryAt - now) / 60_000)} min` : "Queue is empty - approve some ideas");
  }
  if (!SIMULATE) {
    if (!PINATA_JWT) return void (apStatus = "PINATA_JWT is missing - launches can't upload");
    const need = s.devBuySol + FUND_EXTRA_SOL + 0.002;
    const have = await mainBalance();
    if (have < need) return void (apStatus = `Float too low: ${b.name} needs ${need.toFixed(3)} SOL, main wallet has ${have.toFixed(3)}`);
  }
  apStatus = `Launching ${b.name}`;
  launchBrand(b);
  save();
}

/**
 * Tidy up: brings leftover SOL from finished coins (duds, stopped, failed, sold) back to the main wallet.
 * Coins still live or getting ready are left alone. Each wallet keeps its 0.003 SOL fee reserve unless stopped.
 */
async function tidyUp() {
  let sol = 0, wallets = 0;
  for (const c of coins) {
    const done = ["dud", "stopped", "failed"].includes(c.stage) || (c.stage === "earning" && c.soldAt);
    const keep = c.stage === "stopped" ? 0 : COIN_RESERVE_LAMPORTS / SOL; // the fee-claim reserve stays
    if (!done || c.busy || (c.stats?.walletSol ?? 0) < keep + 0.0005) continue;
    c.busy = true;
    try {
      const got = await withdrawCoin(c);
      if (got > 0.0001) { sol += got; wallets++; log(c, `Tidy up: ${got.toFixed(4)} SOL back to the main wallet`); }
    } catch (e) {
      log(c, `Tidy up skipped: ${e.message}`);
    } finally {
      c.busy = false;
    }
  }
  mainBalCache.at = 0;
  save();
  apLog(wallets ? `Tidy up: collected ${sol.toFixed(4)} SOL from ${wallets} finished coin${wallets > 1 ? "s" : ""}` : "Tidy up: nothing to collect");
  return { sol: +sol.toFixed(4), wallets };
}

// ---------- System health (Accounts → Connections) ----------
let healthCache = { at: 0, data: null };
async function health() {
  if (Date.now() - healthCache.at < 30_000 && healthCache.data) return healthCache.data;
  const time = async (fn) => {
    const t = Date.now();
    try { await fn(); return { ok: true, ms: Date.now() - t }; } catch (e) { return { ok: false, ms: Date.now() - t, error: e.message.slice(0, 80) }; }
  };
  const [rpcT, jupT, pumpT, pinT] = await Promise.all([
    time(() => rpc.getSlot()),
    time(() => priceInSol("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6)),
    time(() => chainData()),
    PINATA_JWT ? time(async () => {
      const r = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: { Authorization: `Bearer ${PINATA_JWT}` } });
      if (!r.ok) throw new Error(`Pinata said ${r.status}`);
    }) : { ok: false, error: "PINATA_JWT missing" },
  ]);
  const need = settings.devBuySol + FUND_EXTRA_SOL + 0.002;
  const bal = SIMULATE ? 0 : await mainBalance();
  const data = {
    services: [
      { name: "Claude (ideas, logos, sites)", ok: aiReady(), note: aiReady() ? "connected" : "add the Claude key (Keys tab)" },
      { name: "X app (posting)", ok: xAppReady(), note: xAppReady() ? `${xa.list().length} account${xa.list().length === 1 ? "" : "s"} connected` : "add the X app keys (Keys tab)" },
      { name: "Brain feed (PumpPortal)", ok: brain.summary().status.connected, note: brain.summary().status.trades ? "live + trade data" : brain.summary().status.connected ? "live · add the PumpPortal key for trade data" : "reconnecting" },
      { name: "Pinata (coin details)", ok: pinT.ok, note: pinT.ok ? "working" : pinT.error },
      { name: "Coin websites", ok: true, note: SITE_DOMAIN ? `<coin>.${SITE_DOMAIN}` : `${baseUrl()}/s/<coin>` },
      { name: "Own Solana RPC", ok: !!process.env.SOLANA_RPC_URL, note: process.env.SOLANA_RPC_URL ? "set" : "using the free public one" },
    ],
    system: [
      { name: "Solana RPC", ok: rpcT.ok, note: rpcT.ok ? `${rpcT.ms} ms` : rpcT.error },
      { name: "Jupiter swaps", ok: jupT.ok, note: jupT.ok ? `${jupT.ms} ms` : jupT.error },
      { name: "Pump program", ok: pumpT.ok, note: pumpT.ok ? "reachable" : pumpT.error },
      { name: "Runway", ok: SIMULATE || bal >= need, warn: !SIMULATE && bal >= need && bal < need * 3, note: SIMULATE ? "practice mode" : `${Math.floor(bal / need)} launch${Math.floor(bal / need) === 1 ? "" : "es"} from ${bal.toFixed(2)} SOL` },
      { name: "Profit wallet", ok: !!settings.withdrawTo, note: settings.withdrawTo ? "set" : "not set (Wallets)" },
      { name: "Launching", ok: settings.autopilot && !settings.paused && !settings.spendLock, warn: true, note: !settings.autopilot ? "autopilot off" : settings.paused ? "paused" : settings.spendLock ? "spending locked" : "on" },
      { name: "Login code", ok: !PUBLIC || totp.enabled, warn: true, note: totp.enabled ? "on" : "off (More → Security)" },
    ],
  };
  healthCache = { at: Date.now(), data };
  return data;
}

/** "New ideas a day": spreads that many brain ideas over the day (they wait in Ideas for your yes / no). */
function autoIdeas() {
  const n = settings.ideasPerDay;
  if (!n) return;
  const day = dayKey(Date.now());
  const made = settings.ideasMade?.day === day ? settings.ideasMade.count : 0;
  if (made >= n || Date.now() - (settings.ideasMade?.at ?? 0) < (86400_000 / n) * 0.9) return;
  let ok = true;
  try {
    generateIdeas(1, "both");
  } catch {
    ok = false; // the brain has no words yet - try again at the next slot
  }
  settings.ideasMade = { day, count: made + (ok ? 1 : 0), at: Date.now() };
  writeJson("settings.json", settings);
  if (ok) apLog("Made a new coin idea (Ideas per day)");
}

/** Optional: when the main wallet (the float) grows past target + extra, the extra goes to your Phantom. */
async function profitSweep() {
  const s = settings;
  if (!s.autoSweep || SIMULATE || !s.withdrawTo || Date.now() - lastSweep < 10 * 60_000) return;
  if (coins.some((c) => PRE_LAUNCH.includes(c.stage))) return;
  const bal = await mainBalance();
  if (bal < s.floatTarget + s.sweepAbove) return;
  lastSweep = Date.now();
  const lamports = Math.floor((bal - s.floatTarget) * SOL);
  await sendIxs([mainWallet], [SystemProgram.transfer({ fromPubkey: mainWallet.publicKey, toPubkey: new PublicKey(s.withdrawTo), lamports })], 1000);
  mainBalCache.at = 0;
  apLog(`Profit sweep: sent ${(lamports / SOL).toFixed(4)} SOL to your Phantom (float kept at ${s.floatTarget} SOL)`);
}

let apTicking = false;
setInterval(async () => {
  if (apTicking || restoring) return;
  apTicking = true;
  try {
    await autopilotTick();
  } catch (e) {
    apStatus = `Problem: ${e.message}`;
    console.error("[autopilot]", e);
  } finally {
    apTicking = false;
  }
}, 10_000);

function saveAutopilot(body) {
  const num = (k, lo, hi) => {
    if (body[k] === undefined) return;
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new UserError(`${k} must be between ${lo} and ${hi}.`);
    settings[k] = v;
  };
  num("devBuySol", 0, 20); num("leadMinutes", 1, 120); num("minGapMinutes", 0, 1440); num("triesPerDay", 1, 24);
  num("retryGapMinutes", 0, 2880); num("maxDays", 1, 30); num("maxLaunchesPerDay", 1, 100); num("windowStart", 0, 24);
  num("windowEnd", 0, 24); num("tzOffset", -900, 900); num("checkMinutes", 1, 120); num("minWallets", 1, 1000);
  num("takeProfitX", 0, 100); num("autoClaimSol", 0, 10); num("floatTarget", 0, 1000); num("sweepAbove", 0.01, 1000);
  num("dailyGoal", 0, 10000); num("ideasPerDay", 0, 48);
  if (settings.takeProfitX > 0 && settings.takeProfitX <= 1) throw new UserError("Auto-sell must be above 1x (or 0 for off).");
  for (const k of ["autopilot", "spendLock", "autoSweep", "paused"]) if (body[k] !== undefined) settings[k] = !!body[k];
  if (settings.autoSweep && !settings.withdrawTo) throw new UserError("Save your Phantom address first (Wallet tab), then turn on the profit sweep.");
  writeJson("settings.json", settings);
  apLog(`Settings changed: ${Object.keys(body).filter((k) => k !== "tzOffset").join(", ")}`);
}

async function brandAction(body) {
  if (body.action === "new") {
    const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
    const symbol = String(body.symbol ?? "").trim().toUpperCase().replace(/^\$/, "");
    if (!name || name.length > 32) throw new UserError("Name must be 1-32 characters.");
    if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new UserError("Ticker must be 1-10 letters or numbers.");
    const b = newBrand({
      name, symbol, description: String(body.description ?? "").slice(0, 1000), tagline: "", word: "", why: "added by you",
      xPost: `${name} $${symbol} is live\n\nCA: {CA}\n\n{WEBSITE}`, check: checkName({ name, symbol }, ideaContext()),
    }, "you");
    save();
    return { id: b.id };
  }
  const b = brands.find((x) => x.id === body.id);
  if (!b) throw new UserError("Brand not found.");
  switch (body.action) {
    case "reject": b.status = "rejected"; break;
    case "restore": if (b.status !== "rejected") throw new UserError("Only rejected ideas can come back."); b.status = "idea"; break;
    case "recheck": b.check = checkName(b, { ...ideaContext(), usedNames: new Set(), usedTickers: new Set() }); queueClash(b); break;
    case "retire": b.status = "retired"; apLog(`${b.name} retired by you`); break;
    case "remakeArt":
      if (b.status === "live") throw new UserError("Wait until this try ends.");
      b.prep = { ...b.prep, artSeed: (b.prep?.artSeed ?? 0) + 1 };
      delete b.prep.artFailed;
      b.image = null; b.banner = null;
      break;
    case "remakeSite":
      b.plan = null;
      if (b.prep) delete b.prep.siteFailed;
      break;
    case "launchNow": {
      // Schedule "Now": start this coin right away, skipping the gap (still obeys the spending lock)
      if (b.status !== "approved") throw new UserError("Only booked coins can go out now.");
      if (!b.image || (!b.plan && !b.website)) throw new UserError("Its logo or website is still being made - try again in a minute.");
      if (settings.spendLock) throw new UserError("The spending lock is on - turn it off in More first.");
      if (coins.some((c) => c.auto && PRE_LAUNCH.includes(c.stage))) throw new UserError("Another coin is getting ready - wait until it's live.");
      delete b.notBefore;
      launchBrand(b);
      break;
    }
    case "setTime": {
      const at = Number(body.at);
      if (!Number.isFinite(at) || at < Date.now() - 60_000 || at > Date.now() + 30 * 86400_000) throw new UserError("Pick a time in the next 30 days.");
      b.notBefore = at;
      apLog(`${b.name} set to go out at ${new Date(at - settings.tzOffset * 60_000).toISOString().slice(11, 16)}`);
      break;
    }
    case "clearTime": delete b.notBefore; break;
    case "requeue":
      if (!["retired", "runner"].includes(b.status)) throw new UserError("Only retired brands can go back in the queue.");
      Object.assign(b, { status: "approved", tries: [], nextTryAt: 0 }); break;
    case "up": case "down": {
      const q = brands.filter((x) => x.status === "approved" && !x.tries.length).sort((x, y) => x.order - y.order);
      q.forEach((x, i) => (x.order = i));
      const i = q.indexOf(b), j = body.action === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= q.length) break;
      [q[i].order, q[j].order] = [q[j].order, q[i].order];
      break;
    }
    case "delete":
      if (!["idea", "rejected"].includes(b.status)) throw new UserError("Only ideas can be deleted - retire it instead.");
      brands.splice(brands.indexOf(b), 1);
      break;
    default: throw new UserError("Unknown action.");
  }
  save();
  return { ok: true };
}

/** Approve (or edit) a brand: logo + links + text. It then joins the launch queue. */
async function approveBrand(form) {
  const b = brands.find((x) => x.id === String(form.get("id")));
  if (!b) throw new UserError("Brand not found.");
  if (!["idea", "approved", "rejected"].includes(b.status)) throw new UserError("This brand is already launching - wait for its try to end.");
  const str = (k) => String(form.get(k) ?? "").trim();
  const optUrl = (k) => {
    const v = str(k);
    if (v && (!/^https?:\/\/\S+$/i.test(v) || v.length > 200)) throw new UserError(`The ${k} link must start with https://`);
    return v;
  };
  const name = str("name") || b.name, symbol = (str("symbol") || b.symbol).toUpperCase().replace(/^\$/, "");
  if (name.length > 32) throw new UserError("Name must be 1-32 characters.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new UserError("Ticker must be 1-10 letters or numbers.");
  const image = form.get("image");
  if (image instanceof File && image.size) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(image.type)) throw new UserError("Image must be PNG, JPG, GIF or WebP.");
    if (image.size > 10 * 1024 * 1024) throw new UserError("Image must be 10MB or smaller.");
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[image.type];
    b.image = `b-${b.id}-${Date.now().toString(36)}.${ext}`; // new name each time, so old tries keep their picture
    b.imageType = image.type;
    fs.writeFileSync(path.join(IMAGES, b.image), Buffer.from(await image.arrayBuffer()));
  }
  // no logo uploaded = AUTOPILOT makes logo + banner + website by itself (prepTick)
  if (name !== b.name || symbol !== b.symbol) queueClash(b);
  const xId = str("xAccountId") || "auto";
  if (!["auto", "none"].includes(xId) && !xa.find(xId)) throw new UserError("That X account isn't connected.");
  const direction = str("siteDirection").slice(0, 400);
  if (direction !== (b.siteDirection ?? "") && b.plan) b.plan = null; // new direction = rewrite the site
  Object.assign(b, {
    name, symbol, description: str("description").slice(0, 1000) || b.description, xPost: str("xPost").slice(0, 280) || b.xPost,
    launchPost: str("launchPost").slice(0, 280), siteDirection: direction, xAccountId: xId,
    website: optUrl("website"), twitter: optUrl("twitter"), telegram: optUrl("telegram"),
  });
  slugOf(b);
  if (b.prep) { delete b.prep.artFailed; delete b.prep.siteFailed; }
  if (b.status !== "approved") {
    b.status = "approved";
    b.approvedAt = Date.now();
    b.order = Math.max(0, ...brands.filter((x) => x.status === "approved").map((x) => x.order + 1));
    apLog(`${b.name} $${b.symbol} approved - joined the launch queue`);
  }
  save();
  return { ok: true };
}

// ---------- Results + bot radar ----------

const dayKey = (t) => new Date(t - settings.tzOffset * 60_000).toISOString().slice(0, 10);

function resultRows() {
  return coins.filter((c) => c.mint).map((c) => {
    const st = c.stats;
    return {
      id: c.id, brandId: c.brandId ?? "", name: c.name, symbol: c.symbol, try: c.tryNo ?? 1, auto: !!c.auto, launchedAt: c.launchedAt,
      mint: c.mint, pair: isPair(c) ? c.quote.symbol : "SOL", devBuy: c.devBuySol, funded: +c.fundedSol.toFixed(4),
      wallets: st.outsideWallets, volume: st.outsideVolume, fees: +(st.feesClaimed + st.claimable).toFixed(4), unclaimed: st.claimable,
      devBag: st.devBagSol, peakX: st.peakX, profit: st.profit, bundles: st.bundles.length, stage: c.stage, hit: !!c.passed,
    };
  }).sort((a, b) => b.launchedAt - a.launchedAt);
}

function results() {
  const rows = resultRows();
  const days = [];
  for (let i = 13; i >= 0; i--) days.push({ day: dayKey(Date.now() - i * 86400_000), profit: 0, fees: 0, volume: 0, launches: 0 });
  for (const r of rows) {
    const d = days.find((x) => x.day === dayKey(r.launchedAt));
    if (!d) continue;
    d.profit += r.profit; d.fees += r.fees; d.volume += r.volume; d.launches++;
  }
  for (const d of days) for (const k of ["profit", "fees", "volume"]) d[k] = +d[k].toFixed(4);
  const group = (keyFn, labelFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      const g = m.get(k) ?? { key: k, label: labelFn(r), launches: 0, hits: 0, profit: 0, fees: 0, best: -Infinity };
      g.launches++; if (r.hit) g.hits++; g.profit += r.profit; g.fees += r.fees; g.best = Math.max(g.best, r.profit);
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, profit: +g.profit.toFixed(4), fees: +g.fees.toFixed(4), perLaunch: +(g.profit / g.launches).toFixed(4), best: +g.best.toFixed(4) }))
      .sort((a, b) => b.profit - a.profit);
  };
  const total = rows.reduce((a, r) => ({ profit: a.profit + r.profit, fees: a.fees + r.fees, hits: a.hits + (r.hit ? 1 : 0) }), { profit: 0, fees: 0, hits: 0 });
  return {
    rows, days,
    total: { launches: rows.length, hits: total.hits, profit: +total.profit.toFixed(4), fees: +total.fees.toFixed(4), unclaimed: +rows.reduce((a, r) => a + r.unclaimed, 0).toFixed(4) },
    byBrand: group((r) => r.brandId || r.name, (r) => `${r.name} $${r.symbol}`),
    byPair: group((r) => `${r.pair}|${r.devBuy}`, (r) => `${r.pair} · ${r.devBuy} SOL dev buy`),
    unclaimed: rows.filter((r) => r.unclaimed > 0.0005).sort((a, b) => b.unclaimed - a.unclaimed).slice(0, 20),
  };
}

function resultsCsv() {
  const cols = ["launchedAt", "name", "symbol", "try", "mint", "pair", "devBuy", "funded", "wallets", "volume", "fees", "devBag", "peakX", "profit", "hit", "stage"];
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  return [cols.join(","), ...resultRows().map((r) => cols.map((k) => cell(k === "launchedAt" ? new Date(r[k]).toISOString() : r[k])).join(","))].join("\n");
}

/** Every outside wallet that bought our coins: how often, how fast, in bundles, and whether the brain knows it as a bot. */
function radar() {
  const m = new Map();
  for (const c of coins) {
    const buyers = c.stats?.buyers;
    if (!c.mint || !buyers) continue;
    const bundled = new Set();
    for (const list of Object.values(c.stats.slotBuys ?? {})) if (list.length >= 2) list.forEach((x) => bundled.add(x.wallet));
    for (const [w, b] of Object.entries(buyers)) {
      const r = m.get(w) ?? { wallet: w, coins: 0, bought: 0, sold: 0, fastest: Infinity, bundles: 0, last: 0, names: [] };
      r.coins++; r.bought += b.buy; r.sold += b.sell; r.last = Math.max(r.last, b.first);
      r.fastest = Math.min(r.fastest, Math.max(0, Math.round((b.first - c.launchedAt) / 1000)));
      if (bundled.has(w)) r.bundles++;
      if (r.names.length < 4) r.names.push(c.symbol);
      m.set(w, r);
    }
  }
  const list = [...m.values()].map((r) => {
    const labels = [];
    if (r.fastest <= 3) labels.push("Block-0 sniper");
    if (r.bundles >= 2) labels.push(`Bundler · ${r.bundles} coins`);
    if (r.coins >= 2) labels.push("Repeat trader");
    if (brain.isBot(r.wallet)) labels.push("Market bot");
    return { ...r, bought: +r.bought.toFixed(3), sold: +r.sold.toFixed(3), fastest: Number.isFinite(r.fastest) ? r.fastest : null, labels, label: settings.walletNames[r.wallet] ?? "" };
  }).sort((a, b) => b.coins - a.coins || b.bought - a.bought);
  return { wallets: list.slice(0, 150), total: list.length, repeat: list.filter((r) => r.coins >= 2).length, snipers: list.filter((r) => r.fastest !== null && r.fastest <= 3).length, marketBots: brain.botWallets(30) };
}

async function coinAction(c, action) {
  const live = !!c.mint;
  const guard = async (fn) => {
    if (c.busy) throw new UserError("Busy with another step - try again in a few seconds.");
    c.busy = true;
    try {
      const out = await fn();
      if (c.mint) await refreshMoney(c).catch(() => {});
      return out;
    } finally {
      c.busy = false;
      save();
    }
  };
  switch (action) {
    case "launchNow":
      if (live) throw new UserError("Already launched.");
      c.launchAt = Date.now();
      if (c.stage === "stopped" || c.stage === "failed") Object.assign(c, { stage: "fund", tries: 0 });
      log(c, "Launch moved to now");
      return;
    case "stop":
      c.stage = "stopped";
      c.status = live ? "Stopped watching" : "Stopped before launch - SOL stays in the fresh wallet";
      log(c, "Stopped");
      return;
    case "resume":
      if (!live) throw new UserError("Use \"Launch now\" instead.");
      c.stage = c.launchedAt + c.checkMinutes * 60_000 > Date.now() ? "checks" : "earning";
      log(c, "Watching again");
      return;
    case "posted":
      c.posted = true;
      log(c, "Marked as posted on X");
      return;
    case "dud":
      if (!live) throw new UserError("Not launched yet.");
      return guard(() => markDud(c, "Marked as dud by you"));
    case "sell":
      if (!live) throw new UserError("Not launched yet.");
      return guard(async () => {
        log(c, `Sold dev bag for ${(await sellDevBag(c)).toFixed(4)} SOL`);
        c.soldAt = Date.now();
      });
    case "claim":
      if (!live) throw new UserError("Not launched yet.");
      if (!SIMULATE) c.stats.claimable = await online.getCreatorVaultBalanceBothPrograms(new PublicKey(c.wallet)).then((b) => b.toNumber() / SOL).catch(() => c.stats.claimable);
      if (c.stats.claimable < 0.0001) throw new UserError("No creator fees to claim yet - they come from other people trading the coin.");
      return guard(async () => log(c, `Claimed ${(await claimFees(c)).toFixed(4)} SOL creator fees`));
    case "withdraw":
      return guard(async () => {
        const got = await withdrawCoin(c);
        if (got <= 0) throw new UserError(c.stage === "stopped" ? "The coin wallet is empty." : "Nothing to withdraw - 0.003 SOL stays so fees can still be claimed. Press Stop first to empty it fully.");
        log(c, `Withdrew ${got.toFixed(4)} SOL to main wallet`);
      });
    case "remove":
      if (live && c.stage !== "stopped" && c.stage !== "dud") throw new UserError("Stop it first.");
      if (!SIMULATE && (await balanceOf(c.wallet)) > 10_000) throw new UserError("The fresh wallet still has SOL - press Withdraw first.");
      coins.splice(coins.indexOf(c), 1); // keys.json keeps its keys, just in case
      save();
      return;
    case "rebuildSite":
      if (!c.makeSite) throw new UserError("This coin has no website.");
      if (c.site?.status === "building") throw new UserError("Already building.");
      buildSiteFor(c);
      return;
    case "exportKey":
      return { key: bs58.encode(Uint8Array.from(keys[c.id])) };
  }
  throw new UserError("Unknown action.");
}

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// ---------- Login (online only) ----------
// One password (APP_PASSWORD). A signed cookie keeps you logged in for 30 days. 5 wrong tries = 15 minute lock.

const SESSION_KEY = PUBLIC ? scryptSync(APP_PASSWORD, "autopilot-session", 32) : null;
const SESSION_MS = 30 * 24 * 3600_000;
const failedLogins = new Map(); // ip -> { n, until }
const sign = (v) => createHmac("sha256", SESSION_KEY).update(v).digest();
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

// The cookie carries the session generation: "Log out all devices" bumps it, so every older cookie stops working.
function loggedIn(req) {
  if (!PUBLIC) return true;
  const m = /(?:^|;\s*)ap=(\d+)\.(\d+)\.([0-9a-f]{64})/.exec(req.headers.cookie || "");
  if (!m || Number(m[1]) < Date.now() || Number(m[2]) !== (settings.sessionVer ?? 0)) return false;
  return timingSafeEqual(sign(`${m[1]}.${m[2]}`), Buffer.from(m[3], "hex"));
}

// ---------- 6-digit login code (TOTP, works with Google Authenticator / Authy) ----------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32encode = (buf) => {
  let bits = 0, val = 0, out = "";
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? out + B32[(val << (5 - bits)) & 31] : out;
};
const b32decode = (s) => {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    val = (val << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};
function totpAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", b32decode(secret)).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
let totp = readSecret("totp.json", null) ?? { enabled: false };
/** Accepts the code for now, 30s before or 30s after (phone clocks drift), and never the same code twice. */
function totpOk(secret, code, remember) {
  code = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 30_000);
  for (const ctr of [now - 1, now, now + 1]) {
    if (totpAt(secret, ctr) !== code) continue;
    if (remember) {
      if (ctr <= (totp.lastCtr ?? -1)) return false;
      totp.lastCtr = ctr;
      writeSecret("totp.json", totp);
    }
    return true;
  }
  return false;
}
function failLogin(req) {
  const ip = clientIp(req);
  const f = failedLogins.get(ip) ?? { n: 0, until: 0 };
  if (++f.n >= 5) Object.assign(f, { n: 0, until: Date.now() + 15 * 60_000 });
  failedLogins.set(ip, f);
}

/** Checks the password with the same 5-tries lockout as the login page. */
async function checkPassword(req, password) {
  const ip = clientIp(req);
  const f = failedLogins.get(ip) ?? { n: 0, until: 0 };
  if (f.until > Date.now()) throw new UserError(`Too many wrong tries. Wait ${Math.ceil((f.until - Date.now()) / 60_000)} minutes.`);
  const hash = (s) => createHmac("sha256", "autopilot-pw").update(String(s)).digest();
  if (!timingSafeEqual(hash(password), hash(APP_PASSWORD))) {
    if (++f.n >= 5) Object.assign(f, { n: 0, until: Date.now() + 15 * 60_000 });
    failedLogins.set(ip, f);
    await sleep(800);
    throw new UserError("Wrong password.");
  }
  failedLogins.delete(ip);
}

async function login(req, res, password, code) {
  await checkPassword(req, password);
  if (totp.enabled) {
    if (!code) return json(res, 400, { error: "Enter the 6-digit code from your authenticator app.", needCode: true });
    if (!totpOk(totp.secret, code, true)) {
      failLogin(req);
      await sleep(800);
      return json(res, 400, { error: "That code didn't match - use the newest one in the app.", needCode: true });
    }
  }
  const exp = String(Date.now() + SESSION_MS);
  const v = `${exp}.${settings.sessionVer ?? 0}`;
  res.setHeader("Set-Cookie", `ap=${v}.${sign(v).toString("hex")}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
  json(res, 200, { ok: true });
}

const APP_FILES = {
  "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
};
const APP_TAGS = `<link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="icon" href="/icon-512.png"><link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="AUTOPILOT">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="theme-color" content="#0b0f17">`;

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>AUTOPILOT</title>${APP_TAGS}<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f17;color:#e8ecf3;font:15px system-ui,sans-serif}
form{width:min(340px,calc(100vw - 32px));background:#121825;border:1px solid #1f2737;border-radius:18px;padding:26px}
h1{margin:0 0 18px;font-size:22px}h1 span{color:#d5f26c}
input{width:100%;box-sizing:border-box;background:#0e1420;color:#e8ecf3;border:1px solid #2a3242;border-radius:10px;padding:12px;font-size:16px}
button{width:100%;margin-top:12px;background:#d5f26c;color:#11160a;border:0;border-radius:10px;padding:12px;font-weight:700;font-size:15px}
p{color:#f06b6b;min-height:20px;margin:10px 0 0;font-size:13px}</style></head><body>
<form id="f"><h1>AUTO<span>PILOT</span></h1><input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password">
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" style="margin-top:10px;display:none;letter-spacing:6px;text-align:center"><button>Log in</button><p id="e"></p></form>
<script>const $=(i)=>document.getElementById(i);$("f").onsubmit=async(ev)=>{ev.preventDefault();const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:$("pw").value,code:$("code").value})});
if(r.ok)return void(location.href="/");const j=await r.json().catch(()=>({}));$("e").textContent=j.error||"Wrong password.";if(j.needCode){$("code").style.display="block";$("code").focus();}}</script></body></html>`;

// ---------- Backup / restore (moving AUTOPILOT between your PC and the online server) ----------

function backup() {
  const images = {};
  for (const f of [...coins, ...brands].flatMap((c) => [c.image, c.banner])) {
    if (!f || images[f]) continue;
    const p = path.join(IMAGES, f);
    if (fs.existsSync(p)) images[f] = fs.readFileSync(p).toString("base64");
  }
  return { autopilotBackup: 1, at: new Date().toISOString(), mainSecret, keys, coins: coins.map(({ busy, ...c }) => c), settings, images, brands, activity };
}

let restoring = false;
async function restore(b) {
  if (b?.autopilotBackup !== 1 || !Array.isArray(b.mainSecret) || b.mainSecret.length !== 64) throw new UserError("That isn't an AUTOPILOT backup file.");
  if (coins.length) throw new UserError("This AUTOPILOT already has coins - restore only works on a fresh one.");
  if ((await balanceOf(mainWallet.publicKey)) > 0.001 * SOL) throw new UserError("This AUTOPILOT's main wallet has SOL in it - withdraw it first.");
  restoring = true; // stop the autopilot and saving while files are swapped
  clearTimeout(saveTimer);
  for (const [name, b64] of Object.entries(b.images ?? {})) fs.writeFileSync(path.join(IMAGES, path.basename(name)), Buffer.from(b64, "base64"));
  writeSecret("main-wallet.json", b.mainSecret);
  writeSecret("keys.json", b.keys ?? {});
  writeJson("coins.json", b.coins ?? []);
  writeJson("settings.json", b.settings ?? {});
  writeJson("brands.json", b.brands ?? []);
  writeJson("activity.json", b.activity ?? []);
  console.log("Backup restored - restarting.");
  setTimeout(() => process.exit(0), 800); // Render starts it again with the restored wallets
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (PUBLIC) res.setHeader("X-Frame-Options", "DENY");
  try {
    // App icon + manifest are public (the phone fetches them when you add AUTOPILOT to the home screen)
    if (req.method === "GET" && APP_FILES[url.pathname]) {
      const [name, type] = APP_FILES[url.pathname];
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "max-age=86400" });
      return fs.createReadStream(path.join(ROOT, "public", name)).pipe(res);
    }
    // Coin websites are public
    if (serveSite(req, res, url)) return;
    // X sends you back here after logging in (no AUTOPILOT cookie arrives on that hop; the one-time state proves it's yours)
    if (req.method === "GET" && url.pathname === "/api/x/callback") {
      let msg;
      try {
        if (url.searchParams.get("error")) throw new Error(`X said: ${url.searchParams.get("error")}`);
        const a = await xa.callback(String(url.searchParams.get("state")), String(url.searchParams.get("code")));
        if (!settings.defaultX) { settings.defaultX = a.id; writeJson("settings.json", settings); }
        apLog(`X account @${a.handle} connected`);
        msg = `@${a.handle} connected`;
      } catch (e) {
        msg = e.message;
      }
      res.writeHead(302, { Location: `/?x=${encodeURIComponent(msg)}#settings` });
      return res.end();
    }
    if (PUBLIC && !loggedIn(req)) {
      if (req.method === "GET" && url.pathname === "/login") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(LOGIN_PAGE);
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        const body = await new Request(url, { method: "POST", headers: req.headers, body: req, duplex: "half" }).json().catch(() => ({}));
        return await login(req, res, body.password, body.code);
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        res.writeHead(302, { Location: "/login" });
        return res.end();
      }
      return json(res, 401, { error: "Log in first." });
    }
    if (req.method === "GET" && url.pathname === "/login") {
      res.writeHead(302, { Location: "/" });
      return res.end();
    }
    // remember the address you use, so coin sites + the X callback point to it
    const host = String(req.headers.host || "").toLowerCase();
    if (PUBLIC && host && settings.lastHost !== host) { settings.lastHost = host; writeJson("settings.json", settings); }
    if (req.method === "GET" && url.pathname === "/api/x/connect") {
      let to;
      try { to = xa.connectUrl(`${baseUrl()}/api/x/callback`); } catch (e) { to = `/?x=${encodeURIComponent(e.message)}#settings`; }
      res.writeHead(302, { Location: to });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/api/backup") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="autopilot-backup-${new Date().toISOString().slice(0, 10)}.json"` });
      return res.end(JSON.stringify(backup()));
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(ROOT, "public", "index.html")).pipe(res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/img/")) {
      const name = path.basename(url.pathname);
      const c = coins.find((x) => x.image === name) ?? brands.find((x) => x.image === name);
      if (!c) return json(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": c.imageType, "Cache-Control": "max-age=86400" });
      return fs.createReadStream(path.join(IMAGES, name)).pipe(res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/banner/")) {
      const c = coins.find((x) => x.id === path.basename(url.pathname));
      if (!c?.makeSite || !fs.existsSync(bannerPath(c))) return json(res, 404, { error: "No banner yet" });
      res.writeHead(200, { "Content-Type": "image/png", "Content-Disposition": `attachment; filename="${c.sub}-banner.png"` });
      return fs.createReadStream(bannerPath(c)).pipe(res);
    }
    if (req.method === "GET" && url.pathname === "/api/pairs") {
      return json(res, 200, (await pairList(online, RPC_URL)).map(({ mint, symbol }) => ({ mint, symbol })));
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, {
        simulate: SIMULATE, pinata: !!PINATA_JWT, x: X_READY, customRpc: !!process.env.SOLANA_RPC_URL, site: siteConfig, public: PUBLIC, totp: !!totp.enabled,
        main: { address: mainWallet.publicKey.toBase58(), sol: SIMULATE ? 0 : await mainBalance() },
        withdrawTo: settings.withdrawTo, now: Date.now(), coins: coins.map(publicCoin),
        ap: { ...Object.fromEntries(Object.keys(AP_DEFAULTS).map((k) => [k, settings[k]])), status: apStatus, activity: activity.slice(0, 40) },
        brands: brands.filter((b) => b.status !== "rejected" || Date.now() - b.createdAt < 3 * 86400_000)
          .map(({ plan, ...b }) => ({ ...b, hasSite: !!plan, siteBy: plan?.by, siteUrl: plan ? siteUrl(b) : "", xHandle: brandX(b)?.handle ?? "" })),
        makers: {
          claude: aiReady(), xApp: xAppReady(), xAccounts: xa.list(), defaultX: settings.defaultX ?? "",
          xCallback: `${baseUrl()}/api/x/callback`, siteDomain: SITE_DOMAIN, siteBase: SITE_DOMAIN ? `https://<coin>.${SITE_DOMAIN}` : `${baseUrl()}/s/<coin>`,
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/brain") {
      return json(res, 200, { ...brain.summary(), safe: brain.safeWords(40), hot: brain.hotWords(6, 40) });
    }
    if (req.method === "GET" && url.pathname === "/api/results") return json(res, 200, results());
    if (req.method === "GET" && url.pathname === "/api/results.csv") {
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="autopilot-results-${new Date().toISOString().slice(0, 10)}.csv"` });
      return res.end(resultsCsv());
    }
    if (req.method === "GET" && url.pathname === "/api/radar") return json(res, 200, radar());
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, await health());
    if (req.method === "GET" && url.pathname === "/api/keys") return json(res, 200, { keys: keyStatus(), canRestart: PUBLIC });

    if (req.method === "POST") {
      // Only this page may press buttons, so other websites can't drive your launcher.
      const origin = req.headers.origin;
      const allowed = PUBLIC ? [`https://${req.headers.host}`] : [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`];
      if (origin && !allowed.includes(origin)) return json(res, 403, { error: "Not allowed." });
      if (restoring) throw new UserError("Restarting with the restored backup - reload in a few seconds.");
      const request = new Request(url, { method: "POST", headers: req.headers, body: req, duplex: "half" });
      if (url.pathname === "/api/coins") return json(res, 200, await addCoin(await request.formData()));
      if (url.pathname === "/api/brand-approve") return json(res, 200, await approveBrand(await request.formData()));
      const body = await request.json().catch(() => ({}));
      if (url.pathname === "/api/logout" || url.pathname === "/api/logout-all") {
        if (url.pathname === "/api/logout-all") {
          settings.sessionVer = (settings.sessionVer ?? 0) + 1; // every cookie from before stops working
          writeJson("settings.json", settings);
          apLog("Logged out every device");
        }
        res.setHeader("Set-Cookie", "ap=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/2fa") {
        // setup: make a new secret (not on yet) · enable: prove the app shows the right code · disable: password + code
        if (body.action === "setup") {
          if (totp.enabled) throw new UserError("The login code is already on.");
          totp = { enabled: false, pending: b32encode(randomBytes(20)) };
          writeSecret("totp.json", totp);
          return json(res, 200, { secret: totp.pending, uri: `otpauth://totp/AUTOPILOT?secret=${totp.pending}&issuer=AUTOPILOT&digits=6&period=30` });
        }
        if (body.action === "enable") {
          if (!totp.pending || !totpOk(totp.pending, body.code, false)) throw new UserError("That code didn't match - check the app and try the newest code.");
          totp = { enabled: true, secret: totp.pending };
          writeSecret("totp.json", totp);
          apLog("6-digit login code turned on");
          return json(res, 200, { ok: true });
        }
        if (body.action === "disable") {
          if (!totp.enabled) return json(res, 200, { ok: true });
          if (PUBLIC) await checkPassword(req, body.password);
          if (!totpOk(totp.secret, body.code, true)) throw new UserError("That code didn't match.");
          totp = { enabled: false };
          writeSecret("totp.json", totp);
          apLog("6-digit login code turned off");
          return json(res, 200, { ok: true });
        }
        throw new UserError("Unknown action.");
      }
      if (url.pathname === "/api/export-main") {
        if (PUBLIC) await checkPassword(req, body.password); // asked again even when logged in
        return json(res, 200, { key: bs58.encode(mainWallet.secretKey) });
      }
      if (url.pathname === "/api/restore") {
        await restore(body);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/action") {
        const c = coins.find((x) => x.id === body.id);
        if (!c) throw new UserError("Coin not found.");
        return json(res, 200, (await coinAction(c, body.action)) ?? { ok: true });
      }
      if (url.pathname === "/api/settings") {
        const to = String(body.withdrawTo ?? "").trim();
        if (to) new PublicKey(to); // throws on a bad address
        settings.withdrawTo = to;
        writeJson("settings.json", settings);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/autopilot") {
        saveAutopilot(body);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/ideas") {
        const count = Math.min(20, Math.max(1, Number(body.count) || 6));
        return json(res, 200, { made: generateIdeas(count, ["safe", "hot"].includes(body.source) ? body.source : "both") });
      }
      if (url.pathname === "/api/brand") return json(res, 200, await brandAction(body));
      if (url.pathname === "/api/x-account") {
        const id = String(body.id ?? "");
        if (!xa.find(id)) throw new UserError("That X account isn't connected.");
        if (body.action === "default") settings.defaultX = id;
        else if (body.action === "remove") {
          xa.remove(id);
          if (settings.defaultX === id) settings.defaultX = xa.list()[0]?.id ?? "";
        } else throw new UserError("Unknown action.");
        writeJson("settings.json", settings);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/wallet-name") {
        const w = String(body.wallet ?? "");
        new PublicKey(w);
        const label = String(body.label ?? "").trim().slice(0, 40);
        if (label) settings.walletNames[w] = label;
        else delete settings.walletNames[w];
        writeJson("settings.json", settings);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/withdraw-main") {
        if (SIMULATE) throw new UserError("Practice mode - nothing real to withdraw.");
        if (!settings.withdrawTo) throw new UserError("Save your Phantom address first.");
        let sent;
        if (body.amount !== undefined && body.amount !== "") {
          const amount = Number(body.amount);
          const bal = (await balanceOf(mainWallet.publicKey)) / SOL;
          if (!(amount > 0)) throw new UserError("Type how much SOL to send.");
          if (amount > bal - 0.0002) throw new UserError(`Only ${Math.max(0, bal - 0.0002).toFixed(4)} SOL can go now.`);
          await sendIxs([mainWallet], [SystemProgram.transfer({ fromPubkey: mainWallet.publicKey, toPubkey: new PublicKey(settings.withdrawTo), lamports: Math.floor(amount * SOL) })], 1000);
          sent = amount;
        } else {
          sent = await transferAll(mainWallet, settings.withdrawTo);
        }
        mainBalCache.at = 0;
        apLog(`Withdrew ${sent.toFixed(4)} SOL to your wallet`);
        return json(res, 200, { sent });
      }
      if (url.pathname === "/api/keys") {
        // keys are read once at startup, so AUTOPILOT restarts itself to use new ones (~30s online)
        if (coins.some((c) => c.busy)) throw new UserError("A launch step is running right now - try again in a minute.");
        let changed;
        try { changed = saveKeys(body.values); } catch (e) { throw new UserError(e.message); }
        if (!changed.length) return json(res, 200, { changed, restarting: false });
        apLog(`Keys updated: ${changed.join(", ")}`);
        save();
        if (PUBLIC) {
          restoring = true; // stop launching + saving while it restarts
          setTimeout(() => {
            writeJson("coins.json", coins); writeJson("brands.json", brands); writeJson("activity.json", activity); writeSecret("keys.json", keys);
            process.exit(0); // Render starts it again with the new keys
          }, 1000);
        }
        return json(res, 200, { changed, restarting: PUBLIC });
      }
      if (url.pathname === "/api/tidy" || url.pathname === "/api/emergency") {
        if (url.pathname === "/api/emergency") {
          Object.assign(settings, { autopilot: false, paused: true, spendLock: true });
          writeJson("settings.json", settings);
          apLog("EMERGENCY STOP: autopilot off, paused, spending locked - collecting SOL");
        }
        return json(res, 200, await tidyUp());
      }
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    if (e instanceof UserError || /Invalid public key|Non-base58/i.test(e.message)) return json(res, 400, { error: e instanceof UserError ? e.message : "That address isn't a valid Solana address." });
    console.error(e);
    json(res, 500, { error: `Something went wrong: ${e.message}` });
  }
});

brain.start(); // market study runs all the time (read-only)
if (PUBLIC) {
  server.listen(PORT, "0.0.0.0", () => {
    chainData().catch(() => {});
    console.log(`AUTOPILOT online on port ${PORT} - ${SIMULATE ? "PRACTICE" : "LIVE"} mode, password login on`);
  });
} else {
  http.createServer(server.listeners("request")[0]).on("error", () => {}).listen(PORT, "::1");
}
if (!PUBLIC) server.listen(PORT, "127.0.0.1", () => {
  chainData().catch(() => {});
  console.log(`\n  AUTOPILOT is running:  http://localhost:${PORT}`);
  console.log(SIMULATE ? "  PRACTICE MODE - nothing real is sent. Set SIMULATE=0 in .env to go live.\n" : "  LIVE MODE - real SOL, real launches.\n");
  console.log("  KEEP THIS WINDOW OPEN. Closing it stops all launches and checks.\n");
  if (process.env.OPEN_BROWSER === "1" && process.platform === "win32") spawn("cmd", ["/c", "start", "", `http://localhost:${PORT}`], { detached: true, stdio: "ignore" }).unref();
});
