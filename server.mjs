// AUTOPILOT - automated Pump.fun launcher. Runs only on your own computer (http://localhost:3480).
// You make the coin's website + X account, add the coin here with a launch time, and AUTOPILOT does the rest:
// funds a fresh wallet for the coin, uploads the image, launches on Pump.fun, posts on X (optional),
// watches outside buyers, and after the check either keeps earning creator fees or marks it a dud.
//
// Keys are created and kept ONLY in the data folder on this computer. Back that folder up.

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
const PRIORITY = { launch: 1_000_000, normal: 200_000 }; // micro-lamports per compute unit
const COIN_RESERVE_LAMPORTS = 3_000_000; // 0.003 SOL stays in each coin wallet so it can keep paying to claim creator fees

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const settings = { withdrawTo: "", ...readJson("settings.json", {}) };
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
    writeSecret("keys.json", keys);
  }, 300);
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

function simTick(c) {
  const s = simCurve(c);
  const mins = (Date.now() - c.launchedAt) / 60_000;
  const chance = s.crowd * Math.max(0.15, 1 - mins / 40);
  const trades = [];
  const slot = Math.floor(Date.now() / 400);
  if (Math.random() < 0.06 * s.crowd) {
    // a sniper bundle: several wallets buy in the same block
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) trades.push({ wallet: fakeAddr(), sol: +(0.1 + Math.random() * 0.6).toFixed(3), slot });
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

/** Reads every new trade on the coin's bonding curve straight from Solana (no third-party API). */
async function scanTrades(c) {
  const curve = bondingCurvePda(c.mint);
  const sigs = await rpc.getSignaturesForAddress(curve, { until: c.stats.lastSig ?? undefined, limit: 200 });
  const fresh = sigs.filter((s) => !s.err).reverse(); // oldest first
  for (let i = 0; i < fresh.length; i += 25) {
    const chunk = fresh.slice(i, i + 25);
    const txs = await getTransactions(chunk.map((s) => s.signature));
    txs.forEach((tx, j) => {
      if (!tx?.meta) return;
      const keysList = tx.transaction.message.accountKeys.map((k) => k.pubkey);
      const idx = keysList.indexOf(curve.toBase58());
      if (idx < 0) return;
      const sol = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / SOL; // + = someone bought
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
    const [walletLamports, claimable, bag] = await Promise.all([
      balanceOf(wallet),
      online.getCreatorVaultBalanceBothPrograms(wallet).then((b) => b.toNumber() / SOL).catch(() => st.claimable),
      devBag(c).catch(() => null),
    ]);
    st.walletSol = walletLamports / SOL;
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
  const sol = getSellSolAmountFromTokenAmount({ global: chain.global, feeConfig: chain.feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: bal });
  return { tokens: bal.toNumber() / 10 ** TOKEN_DECIMALS, sol: sol.toNumber() / SOL, graduated: false };
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
  const [state, chain] = await Promise.all([online.fetchSellState(mint, wallet.publicKey, tokenProgram), chainData()]);
  if (state.bondingCurve.complete) {
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
  const ixs = await online.collectCoinCreatorFeeInstructions(wallet.publicKey, wallet.publicKey);
  await sendIxs([wallet], ixs, 120_000);
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
  if (c.devBuySol > 0) {
    const solAmount = new BN(Math.round(c.devBuySol * SOL));
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: NATIVE_MINT });
    ixs = await PUMP_SDK.createV2AndBuyInstructions({ global, mint: mintKp.publicKey, name: c.name, symbol: c.symbol, uri: c.uri, creator: user, user, amount, solAmount, mayhemMode: false });
  } else {
    ixs = [await PUMP_SDK.createV2Instruction({ mint: mintKp.publicKey, name: c.name, symbol: c.symbol, uri: c.uri, creator: user, user, mayhemMode: false })];
  }
  const tx = await buildTx(user, ixs, c.devBuySol > 0 ? 230_000 : 125_000, PRIORITY.launch);
  const sim = await rpc.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) throw new Error(`launch would fail: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-2).join(" ")}`);
  tx.sign([wallet, mintKp]);
  c.pendingMint = mintKp.publicKey.toBase58(); // if confirming times out we check this before ever trying again
  save();
  c.sig = await sendAndConfirm(tx);
  c.mint = c.pendingMint;
}

// ---------- The autopilot ----------
// Stages: fund -> upload -> launch -> post -> checks -> earning   (or dud / stopped / failed)

const newStats = () => ({
  outsideWallets: 0, outsideVolume: 0, feesClaimed: 0, claimable: 0, devBagSol: 0, devTokens: 0, peakX: 0, profit: 0,
  walletSol: 0, volumeByMinute: [], trades: [], bundles: [], walletList: [], lastSig: null,
});

async function step(c) {
  const now = Date.now();
  switch (c.stage) {
    case "fund": {
      if (now < c.launchAt - FUND_LEAD_MS) return void (c.status = "Scheduled");
      const need = c.devBuySol + FUND_EXTRA_SOL;
      if (SIMULATE) {
        c.fundedSol = need;
        log(c, `Practice: fresh wallet funded with ${need.toFixed(3)} SOL`);
        c.stage = "upload";
        return;
      }
      const have = (await balanceOf(c.wallet)) / SOL;
      if (have >= need - 0.0005) {
        c.fundedSol = Math.max(c.fundedSol, have);
        log(c, `Fresh wallet has ${have.toFixed(3)} SOL - ready`);
        c.stage = "upload";
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
    case "upload": {
      // The website link goes into the coin's Pump.fun details, so wait until the site is up.
      if (c.site?.status === "building") return void (c.status = "Waiting for the website to go live");
      if (!SIMULATE) c.uri ??= await uploadMetadata(c);
      log(c, "Image + details uploaded");
      c.stage = "launch";
      return;
    }
    case "launch": {
      if (now < c.launchAt) return void (c.status = "Ready - waiting for launch time");
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
      if (X_READY && !SIMULATE) {
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
        if (c.stage === "checks") c.stage = "earning";
        await refreshMoney(c);
      }

      if (c.stage === "checks" && now >= c.launchedAt + c.checkMinutes * 60_000) {
        if (c.stats.outsideWallets >= c.minWallets) {
          c.stage = "earning";
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
  const { walletList, slotBuys, lastSig, ...stats } = c.stats ?? {};
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

function loggedIn(req) {
  if (!PUBLIC) return true;
  const m = /(?:^|;\s*)ap=(\d+)\.([0-9a-f]{64})/.exec(req.headers.cookie || "");
  if (!m || Number(m[1]) < Date.now()) return false;
  return timingSafeEqual(sign(m[1]), Buffer.from(m[2], "hex"));
}

async function login(req, res, password) {
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
  const exp = String(Date.now() + SESSION_MS);
  res.setHeader("Set-Cookie", `ap=${exp}.${sign(exp).toString("hex")}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
  json(res, 200, { ok: true });
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AUTOPILOT</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f17;color:#e8ecf3;font:15px system-ui,sans-serif}
form{width:min(340px,calc(100vw - 32px));background:#121825;border:1px solid #1f2737;border-radius:18px;padding:26px}
h1{margin:0 0 18px;font-size:22px}h1 span{color:#d5f26c}
input{width:100%;box-sizing:border-box;background:#0e1420;color:#e8ecf3;border:1px solid #2a3242;border-radius:10px;padding:12px;font-size:16px}
button{width:100%;margin-top:12px;background:#d5f26c;color:#11160a;border:0;border-radius:10px;padding:12px;font-weight:700;font-size:15px}
p{color:#f06b6b;min-height:20px;margin:10px 0 0;font-size:13px}</style></head><body>
<form id="f"><h1>AUTO<span>PILOT</span></h1><input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password"><button>Log in</button><p id="e"></p></form>
<script>document.getElementById("f").onsubmit=async(ev)=>{ev.preventDefault();const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("pw").value})});
if(r.ok)location.href="/";else document.getElementById("e").textContent=(await r.json().catch(()=>({}))).error||"Wrong password."}</script></body></html>`;

// ---------- Backup / restore (moving AUTOPILOT between your PC and the online server) ----------

function backup() {
  const images = {};
  for (const c of coins) {
    const p = path.join(IMAGES, c.image);
    if (fs.existsSync(p)) images[c.image] = fs.readFileSync(p).toString("base64");
  }
  return { autopilotBackup: 1, at: new Date().toISOString(), mainSecret, keys, coins: coins.map(({ busy, ...c }) => c), settings, images };
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
  console.log("Backup restored - restarting.");
  setTimeout(() => process.exit(0), 800); // Render starts it again with the restored wallets
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (PUBLIC) res.setHeader("X-Frame-Options", "DENY");
  try {
    if (PUBLIC && !loggedIn(req)) {
      if (req.method === "GET" && url.pathname === "/login") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(LOGIN_PAGE);
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        const body = await new Request(url, { method: "POST", headers: req.headers, body: req, duplex: "half" }).json().catch(() => ({}));
        return await login(req, res, body.password);
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
      const c = coins.find((x) => x.image === name);
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
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, {
        simulate: SIMULATE, pinata: !!PINATA_JWT, x: X_READY, customRpc: !!process.env.SOLANA_RPC_URL, site: siteConfig, public: PUBLIC,
        main: { address: mainWallet.publicKey.toBase58(), sol: SIMULATE ? 0 : await mainBalance() },
        withdrawTo: settings.withdrawTo, now: Date.now(), coins: coins.map(publicCoin),
      });
    }

    if (req.method === "POST") {
      // Only this page may press buttons, so other websites can't drive your launcher.
      const origin = req.headers.origin;
      const allowed = PUBLIC ? [`https://${req.headers.host}`] : [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`];
      if (origin && !allowed.includes(origin)) return json(res, 403, { error: "Not allowed." });
      if (restoring) throw new UserError("Restarting with the restored backup - reload in a few seconds.");
      const request = new Request(url, { method: "POST", headers: req.headers, body: req, duplex: "half" });
      if (url.pathname === "/api/coins") return json(res, 200, await addCoin(await request.formData()));
      const body = await request.json().catch(() => ({}));
      if (url.pathname === "/api/logout") {
        res.setHeader("Set-Cookie", "ap=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
        return json(res, 200, { ok: true });
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
      if (url.pathname === "/api/withdraw-main") {
        if (SIMULATE) throw new UserError("Practice mode - nothing real to withdraw.");
        if (!settings.withdrawTo) throw new UserError("Save your Phantom address first.");
        const sent = await transferAll(mainWallet, settings.withdrawTo);
        mainBalCache.at = 0;
        return json(res, 200, { sent });
      }
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    if (e instanceof UserError || /Invalid public key|Non-base58/i.test(e.message)) return json(res, 400, { error: e instanceof UserError ? e.message : "That address isn't a valid Solana address." });
    console.error(e);
    json(res, 500, { error: `Something went wrong: ${e.message}` });
  }
});

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
