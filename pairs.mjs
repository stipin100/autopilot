// Pairs: launching a coin that trades against another token ($PUMP, NVDAx, USDC...) instead of SOL.
// - the list of pair tokens Pump.fun allows (with names)
// - prices in SOL, and SOL <-> pair swaps through Jupiter (signed here, the key never leaves)

import { PublicKey, VersionedTransaction } from "@solana/web3.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP = "https://lite-api.jup.ag/swap/v1";

// Shown first in the picker; everything else follows alphabetically.
const POPULAR = ["PUMP", "USDC", "NVDAx", "TSLAx", "AAPLx", "SPYx", "Bonk", "$WIF", "Fartcoin", "TRUMP", "WETH", "WBTC"];

let listCache = null;
/** Every pair token Pump.fun currently accepts: [{ mint, symbol, decimals }], SOL first. */
export async function pairList(online, rpcUrl) {
  if (listCache && Date.now() - listCache.at < 3600_000) return listCache.list;
  const supported = await online.fetchSupportedQuoteMints();
  const ids = supported.map((q) => q.mint.toBase58());
  const meta = {};
  // names + decimals in one call (Helius DAS); without it the picker shows short addresses
  for (let i = 0; i < ids.length; i += 1000) {
    const r = await fetch(rpcUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAssetBatch", params: { ids: ids.slice(i, i + 1000) } }),
    }).then((r) => r.json()).catch(() => ({}));
    for (const a of r.result ?? []) {
      if (a) meta[a.id] = { symbol: (a.content?.metadata?.symbol || a.token_info?.symbol || "").trim(), decimals: a.token_info?.decimals };
    }
  }
  const list = ids.map((mint) => ({ mint, symbol: mint === SOL_MINT ? "SOL" : meta[mint]?.symbol || `${mint.slice(0, 4)}…${mint.slice(-4)}`, decimals: mint === SOL_MINT ? 9 : meta[mint]?.decimals }));
  const rank = (s) => (s === "SOL" ? -1 : POPULAR.includes(s) ? POPULAR.indexOf(s) : 100);
  list.sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
  listCache = { at: Date.now(), list };
  return list;
}

async function jupQuote(inputMint, outputMint, amount, slippageBps = 150) {
  const u = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const q = await fetch(u).then((r) => r.json());
  if (!q?.outAmount) throw new Error(`no swap route ${inputMint.slice(0, 4)} -> ${outputMint.slice(0, 4)}: ${q?.error || "unknown"}`);
  return q;
}

const priceCache = new Map(); // mint -> { at, sol }
/** How many SOL one whole pair token is worth (cached 60s). */
export async function priceInSol(mint, decimals) {
  if (mint === SOL_MINT) return 1;
  const c = priceCache.get(mint);
  if (c && Date.now() - c.at < 60_000) return c.sol;
  const q = await jupQuote(SOL_MINT, mint, 100_000_000); // 0.1 SOL
  const sol = 0.1 / (Number(q.outAmount) / 10 ** decimals);
  priceCache.set(mint, { at: Date.now(), sol });
  return sol;
}

/** Swaps `amount` raw units of inputMint into outputMint from `wallet`. Returns the signature. */
export async function swap(wallet, inputMint, outputMint, amount, sendAndConfirm) {
  const quoteResponse = await jupQuote(inputMint, outputMint, String(amount));
  const r = await fetch(`${JUP}/swap`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 300_000, priorityLevel: "high" } },
    }),
  }).then((r) => r.json());
  if (!r?.swapTransaction) throw new Error(`Jupiter swap failed: ${r?.error || "no transaction"}`);
  const tx = VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, "base64"));
  tx.sign([wallet]);
  return sendAndConfirm(tx);
}

export const isPair = (c) => !!c.quote && c.quote.mint !== SOL_MINT;
export const toKey = (m) => new PublicKey(m);
