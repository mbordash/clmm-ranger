import 'dotenv/config';
import { Connection, PublicKey, VersionedTransaction, Transaction, Keypair, ComputeBudgetProgram } from '@solana/web3.js';
import { Raydium, TickUtils, ApiV3PoolInfoConcentratedItem, TxVersion } from '@raydium-io/raydium-sdk-v2';
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import TransportNodeHid from "@ledgerhq/hw-transport-node-hid";
import SolanaApp from "@ledgerhq/hw-app-solana";
import axios from 'axios';
import { lookup } from 'node:dns/promises';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import bs58 from 'bs58';

// ====================== CONFIG ======================
const RPC_URL = process.env.RPC_URL!;
const MINT_A = new PublicKey(process.env.MINT_A ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MINT_B = new PublicKey(process.env.MINT_B ?? 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const POOL_ID = new PublicKey(process.env.POOL_ID!);
const ACTUAL_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS ?? 120_000);
// Minimum wallet SOL (lamports) required to safely start a re-range. Below this
// the loop skips mutating actions so we never get stuck with a half-open
// position after running out of gas mid-cycle. Default 0.035 SOL.
const MIN_SOL_LAMPORTS = Number(process.env.MIN_SOL_LAMPORTS ?? 35_000_000);
const TARGET_WALLET = process.env.WALLET_ADDRESS;   // optional in hot-wallet mode
const LEDGER_PATH = process.env.LEDGER_PATH ?? "44'/501'";
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY; // base58 private key — set to use hot wallet instead of Ledger
const DISABLE_RAYDIUM_TOKEN_LOAD = (process.env.DISABLE_RAYDIUM_TOKEN_LOAD ?? 'true').toLowerCase() !== 'false';

// ── Priority fee / compute budget ─────────────────────────────────────────────
// Applied to every Raydium CLMM tx (open / increase / decrease+close / reclaim).
// Without it these txs ran at the 5000-lamport floor with zero priority, so under
// load they failed to land (the 429s and Custom 6017/6047 in the logs) — leaving
// half-finished re-ranges and orphaned positions whose rent (~0.0055 SOL each) is
// then lost. A small priority fee makes the close/open pipeline land reliably.
//
// Per-tx priority cost ≈ PRIORITY_FEE_MICRO_LAMPORTS × COMPUTE_UNIT_LIMIT ÷ 1e15 SOL.
//   default 50_000 µLamports/CU × 600_000 CU ≈ 0.00003 SOL/tx — cheap insurance.
// Tune via env; set PRIORITY_FEE_MICRO_LAMPORTS=0 to disable entirely.
const COMPUTE_UNIT_LIMIT = Number(process.env.COMPUTE_UNIT_LIMIT ?? 600_000);
const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 50_000);
// Minimum leftover wallet value (in USD) worth re-depositing. Below this, the
// bot stops sweeping so it doesn't spend more in swap + top-up fees than the
// dust is worth. Raised from $5 to reduce deep-iteration fee churn.
const DUST_THRESHOLD_USD = Number(process.env.DUST_THRESHOLD_USD ?? 50);
const DUST_THRESHOLD_RAW = new BN(Math.round(DUST_THRESHOLD_USD * 1_000_000)); // stablecoin 6-decimals
// Minimum wallet imbalance (USD) before firing a Jupiter rebalance swap. Below
// this, the wallet is "close enough" and we skip the swap to save fees.
// Previously hardcoded at $0.10 — far too aggressive for a $15k position.
const REBALANCE_RESIDUAL_USD = Number(process.env.REBALANCE_RESIDUAL_USD ?? 1.0);
const REBALANCE_RESIDUAL_RAW = new BN(Math.round(REBALANCE_RESIDUAL_USD * 1_000_000));
const COMPUTE_BUDGET_CONFIG = PRIORITY_FEE_MICRO_LAMPORTS > 0
    ? { units: COMPUTE_UNIT_LIMIT, microLamports: PRIORITY_FEE_MICRO_LAMPORTS }
    : undefined;

Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

// ====================== SETUP ======================
const connection = new Connection(RPC_URL, 'confirmed');
let raydium: Raydium;
let walletAddress: PublicKey;
let ledgerSigner: any; // aliased to signer below for backward compat

// Tracks when the last "Open Position" TX was confirmed on-chain.
// Even after a confirmed open, the RPC can take 90+ seconds to index the
// new position NFT.  Without this guard, the next mainLoop iteration sees
// myPosition=null and opens a SECOND position, burning SOL on duplicate rent.
let lastConfirmedOpenAt = 0;       // epoch ms — 0 means "never"
const OPEN_GUARD_MS = 5 * 60_000; // 5 minutes — safe margin for any RPC lag

async function getHotWalletSigner(privateKeyB58: string) {
    const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyB58));
    const publicKey = keypair.publicKey;
    console.log(`🔑 Hot wallet mode: ${publicKey.toBase58()}`);
    return {
        publicKey,
        signTransaction: async (tx: Transaction | VersionedTransaction) => {
            if (tx instanceof Transaction) {
                tx.partialSign(keypair);
            } else {
                tx.sign([keypair]);
            }
            return tx;
        }
    };
}

async function getLedgerSigner() {
    const transport = await TransportNodeHid.create();
    const solanaApp = new SolanaApp(transport);
    const { address } = await solanaApp.getAddress(LEDGER_PATH);
    const addrStr = Buffer.isBuffer(address) ? bs58.encode(address) : address;
    if (TARGET_WALLET && addrStr !== TARGET_WALLET) throw new Error("Wallet mismatch");
    const publicKey = new PublicKey(addrStr);
    console.log(`🔐 Ledger mode: ${publicKey.toBase58()}`);
    return {
        publicKey,
        signTransaction: async (tx: Transaction | VersionedTransaction) => {
            console.log("\n📲 Please confirm on Ledger...");
            const message = tx instanceof Transaction ? tx.serializeMessage() : tx.message.serialize();
            const { signature } = await solanaApp.signTransaction(LEDGER_PATH, Buffer.from(message));
            tx.addSignature(publicKey, signature);
            return tx;
        }
    };
}

async function preflightNetworkCheck() {
    const hosts = ['api.jup.ag'];
    if (!DISABLE_RAYDIUM_TOKEN_LOAD) hosts.push('tokens.jup.ag');

    for (const host of hosts) {
        try {
            await lookup(host);
        } catch {
            console.warn(`⚠️ DNS lookup failed for ${host}. Check server DNS/egress if swaps fail.`);
        }
    }
}

async function initRaydium() {
    const signer = WALLET_PRIVATE_KEY
        ? await getHotWalletSigner(WALLET_PRIVATE_KEY)
        : await getLedgerSigner();

    ledgerSigner = signer; // alias so all existing ledgerSigner.signTransaction() calls work unchanged
    walletAddress = signer.publicKey;

    await preflightNetworkCheck();

    // Idempotent ATA creation for USDC and USDT to avoid dynamic rent overhead
    console.log('🔧 Ensuring token accounts exist...');
    const ataInstructions = [
        createAssociatedTokenAccountIdempotentInstruction(walletAddress, getAssociatedTokenAddressSync(MINT_A, walletAddress, true), walletAddress, MINT_A),
        createAssociatedTokenAccountIdempotentInstruction(walletAddress, getAssociatedTokenAddressSync(MINT_B, walletAddress, true), walletAddress, MINT_B)
    ];
    const setupTx = new Transaction().add(...ataInstructions);
    const { blockhash } = await connection.getLatestBlockhash();
    setupTx.recentBlockhash = blockhash;
    setupTx.feePayer = walletAddress;
    try {
        const signedSetup = await signer.signTransaction(setupTx);
        await connection.sendRawTransaction(signedSetup.serialize(), { skipPreflight: true });
        await new Promise(r => setTimeout(r, 1000)); // brief settle
    } catch (e: any) {
        // Idempotent: if ATAs already exist, this is a no-op or error we can ignore
        if (!e.message?.includes('already in use')) console.warn('ATA setup note:', e.message);
    }

    raydium = await Raydium.load({
        connection,
        owner: walletAddress,
        disableLoadToken: DISABLE_RAYDIUM_TOKEN_LOAD,
        signAllTransactions: (async (txs: (Transaction | VersionedTransaction)[]) => {
            const signed = [];
            for (const tx of txs) signed.push(await signer.signTransaction(tx));
            return signed;
        }) as any
    });
    // @ts-ignore
    raydium.clmm.programId = ACTUAL_PROGRAM_ID;
    console.log(`✅ Bot Ready: ${walletAddress.toBase58()} (token preload ${DISABLE_RAYDIUM_TOKEN_LOAD ? 'disabled' : 'enabled'})`);
}

async function getTokenBalance(mint: PublicKey): Promise<BN> {
    try {
        const ata = getAssociatedTokenAddressSync(mint, walletAddress, true);
        const account = await getAccount(connection, ata);
        return new BN(account.amount.toString());
    } catch (e) { return new BN(0); }
}

async function getJupiterSwapTx(inputMint: PublicKey, outputMint: PublicKey, amount: string): Promise<VersionedTransaction | null> {
    try {
        const { data: quoteResponse } = await axios.get(`https://api.jup.ag/swap/v1/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=20`);
        const { data: { swapTransaction } } = await axios.post('https://api.jup.ag/swap/v1/swap', { quoteResponse, userPublicKey: walletAddress.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false, prioritizationFeeLamports: "auto" });
        return VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    } catch (e) { return null; }
}

async function sendAndConfirm(tx: Transaction | VersionedTransaction, label: string) {
    const startBal = await connection.getBalance(walletAddress);
    let blockhash: string;
    let lastValidBlockHeight: number;

    if (tx instanceof Transaction) {
        const res = await connection.getLatestBlockhash();
        if (!tx.recentBlockhash) {
            tx.recentBlockhash = res.blockhash;
            tx.feePayer = walletAddress;
        }
        blockhash = res.blockhash;
        lastValidBlockHeight = res.lastValidBlockHeight;
    } else {
        blockhash = tx.message.recentBlockhash;
        const res = await connection.getLatestBlockhash();
        lastValidBlockHeight = res.lastValidBlockHeight;
    }

    const signedTx = await ledgerSigner.signTransaction(tx);
    const signature = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true });
    console.log(`TX Sent [${label}]: ${signature}`);
    
    const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value.err) throw new Error(`TX Failed: ${JSON.stringify(result.value.err)}`);
    
    const endBal = await connection.getBalance(walletAddress);
    const diff = (startBal - endBal) / 1e9;
    console.log(`💸 [${label}] Net SOL Change: ${diff.toFixed(6)} SOL`);
    return signature;
}

// ====================== CORE ACTIONS ======================

async function safeWithdrawAll(position: any) {
    console.log(`\n🛡️ CONSOLIDATED WITHDRAWAL...`);
    const poolInfoRaw = await raydium.clmm.getPoolInfoFromRpc(position.poolId.toBase58());
    
    if (poolInfoRaw.poolKeys.rewardInfos && poolInfoRaw.poolKeys.rewardInfos.length > 0) {
        // @ts-ignore
        poolInfoRaw.poolInfo.rewardDefaultInfos = poolInfoRaw.poolKeys.rewardInfos.map((r: any) => ({
            mint: r.mint, vault: r.vault, openTime: '0', endTime: '0', emissionsPerSecondX64: '0',
            rewardTotalEmissioned: 0, rewardClaimed: 0, tokenProgramId: r.mint?.programId ?? TOKEN_PROGRAM_ID.toBase58(),
            creator: '', type: 'Standard SPL' as any, perSecond: 0,
        }));
    }

    const nftMintInfo = await connection.getAccountInfo(position.nftMint);
    const nftTokenProgram: PublicKey = nftMintInfo?.owner ?? TOKEN_PROGRAM_ID;
    const sdkNftAta = getAssociatedTokenAddressSync(position.nftMint, walletAddress, false, TOKEN_PROGRAM_ID);
    const correctNftAta = getAssociatedTokenAddressSync(position.nftMint, walletAddress, false, nftTokenProgram);
    const atasDiffer = !correctNftAta.equals(sdkNftAta);

    // SINGLE ATOMIC CALL: Withdraw + Harvest + Burn + Close
    // @ts-ignore
    const { transaction } = await raydium.clmm.decreaseLiquidity({
        poolInfo: poolInfoRaw.poolInfo,
        ownerPosition: position,
        liquidity: position.liquidity,
        amountMinA: new BN(0),
        amountMinB: new BN(0),
        ownerInfo: { 
            useSOLBalance: false, 
            closePosition: true
        },
        computeBudgetConfig: COMPUTE_BUDGET_CONFIG,
        txVersion: TxVersion.LEGACY
    });
    
    const tx = transaction as Transaction;
    if (atasDiffer) {
        const CLMM_PROG = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
        for (const ix of tx.instructions) {
            for (const key of ix.keys) {
                if (key.pubkey.equals(sdkNftAta)) key.pubkey = correctNftAta;
                if (key.pubkey.equals(TOKEN_PROGRAM_ID) && !nftTokenProgram.equals(TOKEN_PROGRAM_ID)) {
                    key.pubkey = nftTokenProgram;
                }
            }
        }
    }

    await sendAndConfirm(tx, "Atomic Withdraw & Full Rent Recovery");
}

async function getRatioMath(poolInfo: ApiV3PoolInfoConcentratedItem, tickLower: number, tickUpper: number) {
    // @ts-ignore
    const sP = new Decimal(poolInfo.sqrtPriceX64.toString());
    const sPa = new Decimal(TickUtils.getTickPrice({ poolInfo, tick: tickLower, baseIn: true }).tickSqrtPriceX64.toString());
    const sPb = new Decimal(TickUtils.getTickPrice({ poolInfo, tick: tickUpper, baseIn: true }).tickSqrtPriceX64.toString());
    const Q64 = new Decimal(2).pow(64);
    const price = new Decimal(poolInfo.price);
    let R: Decimal;
    if (sP.lte(sPa)) R = new Decimal(1e18); 
    else if (sP.gte(sPb)) R = new Decimal(0);
    else R = sPb.sub(sP).mul(Q64).mul(Q64).div(sP.mul(sPb).mul(sP.sub(sPa)));
    return { R, price };
}

async function rebalanceToRatio(poolInfo: ApiV3PoolInfoConcentratedItem, tickLower: number, tickUpper: number) {
    const { R, price } = await getRatioMath(poolInfo, tickLower, tickUpper);
    await raydium.account.fetchWalletTokenAccounts();
    const usdcBal = await getTokenBalance(MINT_A);
    const usdtBal = await getTokenBalance(MINT_B);
    const totalUsdcVal = new Decimal(usdcBal.toString()).add(new Decimal(usdtBal.toString()).div(price));
    const targetUsdt = totalUsdcVal.div(R.add(new Decimal(1).div(price)));
    const targetUsdc = R.mul(targetUsdt);

    console.log(`⚖️ Wallet: USDC ${(usdcBal.toNumber()/1e6).toFixed(2)}, USDT ${(usdtBal.toNumber()/1e6).toFixed(2)}`);
    const diffUsdc = new Decimal(usdcBal.toString()).sub(targetUsdc);
    if (diffUsdc.abs().gt(REBALANCE_RESIDUAL_RAW.toString())) {
        console.log(`🔄 Rebalancing: ${diffUsdc.gt(0) ? "Selling USDC for USDT" : "Selling USDT for USDC"}`);
        const swapTx = diffUsdc.gt(0) ? await getJupiterSwapTx(MINT_A, MINT_B, diffUsdc.toFixed(0)) : await getJupiterSwapTx(MINT_B, MINT_A, new Decimal(usdtBal.toString()).sub(targetUsdt).toFixed(0));
        if (swapTx) { await sendAndConfirm(swapTx, "Jupiter Rebalance Swap"); await new Promise(r => setTimeout(r, 2000)); await raydium.account.fetchWalletTokenAccounts(); }
    }
}

async function depositLiquidity(_poolInfo: ApiV3PoolInfoConcentratedItem, _poolKeys: any, tickLower: number, tickUpper: number, isNew: boolean, position?: any, preFetchedPoolData?: { poolInfo: ApiV3PoolInfoConcentratedItem, poolKeys: any }): Promise<any | null> {
    // Use pre-fetched pool data if caller already has fresh state (e.g. post-withdrawal),
    // otherwise re-fetch to avoid stale sqrtPriceX64 causing 6021 PriceSlippageCheck.
    let poolInfo: ApiV3PoolInfoConcentratedItem;
    let poolKeys: any;
    if (preFetchedPoolData) {
        poolInfo = preFetchedPoolData.poolInfo;
        poolKeys = preFetchedPoolData.poolKeys;
    } else {
        const freshRaw = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
        poolInfo = freshRaw.poolInfo;
        poolKeys = freshRaw.poolKeys;
    }

    await raydium.account.fetchWalletTokenAccounts();
    const usdcBal = await getTokenBalance(MINT_A);
    const usdtBal = await getTokenBalance(MINT_B);
    if (usdcBal.add(usdtBal).lt(new BN(100_000))) return;

    const { R } = await getRatioMath(poolInfo, tickLower, tickUpper);

    // Final safety guard: if RPC lag made mainLoop miss an existing active
    // position, do not mint a second NFT. Switch open -> top-up instead.
    // Use aggressive retries (10 × 2 s = up to 20 s) so slow RPC nodes don't
    // cause a false "no position" result and a duplicate open.
    let effectiveIsNew = isNew;
    let effectivePosition = position;
    if (effectiveIsNew) {
        const active = await getActivePoolPosition(10, 2000);
        if (active) {
            console.warn("⚠️ Active position detected in open path; switching to top-up to avoid duplicate position.");
            effectiveIsNew = false;
            effectivePosition = active;
        }
    }
    if (!effectiveIsNew && !effectivePosition) {
        console.warn("⚠️ No position available for top-up; skipping deposit call.");
        return null;
    }

    // Always use the DOMINANT token (higher target %) as base.
    //   R = USDC/USDT.  R ≥ 1 → USDC dominant → useUsdcAsBase.
    //                   R < 1 → USDT dominant → useUsdtAsBase.
    //
    // Why dominant-as-base avoids 6021:
    //   required_other = base × R_onchain.  "other" is the MINOR token
    //   (small balance), so even a 10% move in R_onchain keeps required_other
    //   well within our minor-token balance.
    //
    //   The old minor-token-as-base approach (e.g. USDC base when R=0.023)
    //   computes required_other = base / R, which is 43× larger. Any tiny
    //   downward drift in R (price drifting toward upper tick, the likely
    //   direction when R is already small) pushes required_other above the
    //   full USDT balance → 6021.
    const useUsdcAsBase = R.gte(1);
    const rawBase  = useUsdcAsBase ? usdcBal : usdtBal;
    const rawOther = useUsdcAsBase ? usdtBal : usdcBal;

    const baseAmount  = rawBase.mul(new BN(95)).div(new BN(100));
    const otherAmount = rawOther; // full balance — never a binding constraint

    console.log(`🚀 ${effectiveIsNew ? "Opening" : "Top-up"} via ${useUsdcAsBase ? "USDC" : "USDT"} (Ratio: ${R.toFixed(4)})`);
    let res;
    if (effectiveIsNew) res = await raydium.clmm.openPositionFromBase({ poolInfo, poolKeys, tickLower, tickUpper, baseAmount, otherAmountMax: otherAmount, base: useUsdcAsBase ? 'MintA' : 'MintB', ownerInfo: { useSOLBalance: false }, withMetadata: 'no-create', computeBudgetConfig: COMPUTE_BUDGET_CONFIG, txVersion: TxVersion.LEGACY });
    // @ts-ignore
    else res = await raydium.clmm.increasePositionFromBase({ poolInfo, ownerPosition: effectivePosition, baseAmount, otherAmountMax: otherAmount, base: useUsdcAsBase ? 'MintA' : 'MintB', ownerInfo: { useSOLBalance: false }, computeBudgetConfig: COMPUTE_BUDGET_CONFIG, txVersion: TxVersion.LEGACY });

    const tx = res.transaction as Transaction;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.feePayer = walletAddress;
    const validSigners = (res.signers || []).filter(s => s instanceof Keypair);
    if (validSigners.length > 0) tx.sign(...validSigners);
    await sendAndConfirm(tx, effectiveIsNew ? "Open Position" : "Increase Liquidity");

    if (effectiveIsNew) {
        // Record the confirmed open immediately.  Even if the RPC takes minutes
        // to index the new NFT, mainLoop will see lastConfirmedOpenAt and refuse
        // to fire a duplicate openPositionFromBase.
        lastConfirmedOpenAt = Date.now();
        console.log("⏳ Waiting for RPC to index new position...");
        await new Promise(r => setTimeout(r, 10_000));
        const newPos = await getActivePoolPosition(10, 2000);
        if (newPos) {
            console.log(`✅ New position confirmed on-chain: ${newPos.nftMint?.toBase58?.() ?? 'ok'}`);
        } else {
            console.warn("⚠️ Could not confirm new position on-chain after 30 s — proceeding cautiously.");
        }
        return newPos;
    }
    return effectivePosition ?? null;
}

/**
 * Repeatedly top-up the active position until wallet dust drops below
 * DUST_THRESHOLD_USD (default $50). Each call to depositLiquidity deposits 95% of the dominant token; this loop
 * runs immediately (no inter-loop wait) until the remainder is negligible.
 * Capped at 2 rounds to prevent burning more in fees than the dust is worth.
 *
 * @param knownPosition - pass the position returned by depositLiquidity to
 *   avoid re-querying when RPC indexing lag would cause a false "not found".
 */
async function sweepDust(poolInfo: ApiV3PoolInfoConcentratedItem, poolKeys: any, tickLower: number, tickUpper: number, knownPosition?: any) {
    const MAX_ROUNDS = 2;
    for (let round = 0; round < MAX_ROUNDS; round++) {
        await new Promise(r => setTimeout(r, 1500)); // brief settle for RPC state
        const usdc = await getTokenBalance(MINT_A);
        const usdt = await getTokenBalance(MINT_B);
        const totalDust = usdc.add(usdt);
        if (totalDust.lte(DUST_THRESHOLD_RAW)) {
            if (round > 0) console.log("✅ Dust cleared.");
            return;
        }
        console.log(`🧹 Sweep round ${round + 1}: $${(totalDust.toNumber() / 1e6).toFixed(2)} remaining`);

        // Re-fetch fresh pool state so R is accurate before each round.
        // Without this, a stale R (e.g. R=27.9 with USDT nearly exhausted) causes
        // the loop to deposit only a tiny sliver per round — USDC bottlenecked by
        // the depleted USDT "other" balance — and never converges.
        const freshRaw = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());

        // Rebalance to current ratio so each deposit can absorb the full 95% of base.
        await rebalanceToRatio(freshRaw.poolInfo, tickLower, tickUpper);
        await new Promise(r => setTimeout(r, 1500));

        // Prefer the caller-supplied position hint (avoids re-query when RPC is slow
        // to index a freshly-opened position).  Fall back to aggressive on-chain poll.
        const pos = knownPosition ?? await getActivePoolPosition(10, 2000);
        if (!pos) { console.log("⚠️ sweepDust: no active position found after extended wait, skipping."); return; }
        // Clear hint after first round so subsequent rounds re-verify on-chain.
        knownPosition = undefined;
        await depositLiquidity(freshRaw.poolInfo, freshRaw.poolKeys, tickLower, tickUpper, false, pos, { poolInfo: freshRaw.poolInfo, poolKeys: freshRaw.poolKeys });
    }
}

async function getActivePoolPosition(maxAttempts = 3, delayMs = 1200): Promise<any | null> {
    let lastPoolMatches: any[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const positions = await raydium.clmm.getOwnerPositionInfo({ programId: ACTUAL_PROGRAM_ID });
        const poolMatches = positions.filter(p => p.poolId.equals(POOL_ID));
        const active = poolMatches.filter(p => !p.liquidity.isZero());
        if (active.length > 0) {
            if (active.length > 1) {
                console.warn(`⚠️ Found ${active.length} active positions for pool; using largest liquidity position.`);
            }
            return active.reduce((best, p) => (p.liquidity.gt(best.liquidity) ? p : best));
        }
        lastPoolMatches = poolMatches;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
    }

    if (lastPoolMatches.length > 0) {
        console.warn(`⚠️ Found ${lastPoolMatches.length} pool position(s), but all have zero liquidity.`);
    }
    return null;
}

/**
 * Reclaim SOL rent locked in EMPTY (zero-liquidity) position NFTs.
 *
 * Why this exists — the "missing recoupment":
 *   getActivePoolPosition() deliberately ignores zero-liquidity positions, so any
 *   NFT left behind when the atomic close half of a re-range fails (RPC 429s,
 *   Custom 6017/6047/6001, or a duplicate-position event — all visible in the
 *   logs) is NEVER closed again by the bot. Each orphan keeps ~0.0055 SOL of rent
 *   (NFT token account + personalPosition PDA) locked forever. Manually on Raydium
 *   you'd just click "Close Position" and get it back; the bot never did.
 *
 * This only ever touches positions whose liquidity is exactly zero, so it cannot
 * affect an active 1-tick position. Safe to run every loop; it sends a tx only
 * when an orphan actually exists.
 */
async function reclaimEmptyPositions(poolInfo: ApiV3PoolInfoConcentratedItem, poolKeys: any) {
    let positions: any[];
    try {
        positions = await raydium.clmm.getOwnerPositionInfo({ programId: ACTUAL_PROGRAM_ID });
    } catch (e: any) {
        console.warn('reclaimEmptyPositions: could not fetch positions:', e.message);
        return;
    }
    const empties = positions.filter(p => p.poolId.equals(POOL_ID) && p.liquidity.isZero());
    if (empties.length === 0) return;

    console.log(`🧯 Reclaiming ${empties.length} empty position NFT(s) holding locked SOL rent...`);
    for (const pos of empties) {
        try {
            // Mirror safeWithdrawAll's NFT token-program handling so the close
            // works whether the position NFT is a legacy SPL or Token-2022 mint.
            const nftMintInfo = await connection.getAccountInfo(pos.nftMint);
            const nftTokenProgram: PublicKey = nftMintInfo?.owner ?? TOKEN_PROGRAM_ID;
            const sdkNftAta = getAssociatedTokenAddressSync(pos.nftMint, walletAddress, false, TOKEN_PROGRAM_ID);
            const correctNftAta = getAssociatedTokenAddressSync(pos.nftMint, walletAddress, false, nftTokenProgram);
            const atasDiffer = !correctNftAta.equals(sdkNftAta);

            // @ts-ignore
            const { transaction } = await raydium.clmm.closePosition({
                poolInfo, poolKeys, ownerPosition: pos, txVersion: TxVersion.LEGACY
            });
            const tx = transaction as Transaction;
            // closePosition() (unlike decreaseLiquidity/openPositionFromBase) does
            // NOT apply computeBudgetConfig itself, so prepend the budget manually
            // to give the reclaim tx the same priority.
            if (COMPUTE_BUDGET_CONFIG) {
                tx.instructions.unshift(
                    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_BUDGET_CONFIG.units }),
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_BUDGET_CONFIG.microLamports })
                );
            }
            if (atasDiffer) {
                for (const ix of tx.instructions) {
                    for (const key of ix.keys) {
                        if (key.pubkey.equals(sdkNftAta)) key.pubkey = correctNftAta;
                        if (key.pubkey.equals(TOKEN_PROGRAM_ID) && !nftTokenProgram.equals(TOKEN_PROGRAM_ID)) {
                            key.pubkey = nftTokenProgram;
                        }
                    }
                }
            }
            const tag = pos.nftMint?.toBase58?.().slice(0, 4) ?? 'pos';
            await sendAndConfirm(tx, `Reclaim empty position ${tag}`);
        } catch (e: any) {
            // A leftover position that still has unclaimed fees can reject a bare
            // close; skip it rather than abort the loop.
            console.warn(`⚠️ Could not reclaim empty position ${pos.nftMint?.toBase58?.() ?? ''}: ${e.message}`);
        }
    }
}

async function mainLoop() {
    try {
        console.log('\n--- Loop ---');
        const poolInfoRaw = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
        const poolInfo = poolInfoRaw.poolInfo;
        // Reclaim SOL from any empty position NFTs left behind by a failed close.
        // No-op (single RPC read) when there are none.
        await reclaimEmptyPositions(poolInfo, poolInfoRaw.poolKeys);
        // ── Low-SOL safety guard ─────────────────────────────────────────────
        // Re-ranging is a multi-tx close+open pipeline; if we run out of gas
        // mid-cycle we can be left with a withdrawn-but-not-reopened position.
        // Reclaim above can only ADD SOL, so we check the balance after it.
        const solBalance = await connection.getBalance(walletAddress);
        if (solBalance < MIN_SOL_LAMPORTS) {
            console.warn(`⛽ Low SOL: ${(solBalance / 1e9).toFixed(4)} SOL < ${(MIN_SOL_LAMPORTS / 1e9).toFixed(4)} SOL minimum — skipping re-range/deposit this loop. Top up the wallet.`);
            return;
        }
        // ─────────────────────────────────────────────────────────────────────
        // Use aggressive retries here so slow RPC nodes don't mistakenly report
        // "no position" after a recent open and trigger a duplicate.
        const myPosition = await getActivePoolPosition(8, 2000);
        // @ts-ignore
        const tickCurrent = poolInfo.tickCurrent ?? 0;
        const tickSpacing = poolInfo.config.tickSpacing;
        const tickLower = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
        const tickUpper = tickLower + tickSpacing;

        if (!myPosition) {
            // ── Duplicate-open guard ─────────────────────────────────────────────
            // If we confirmed an openPositionFromBase TX less than OPEN_GUARD_MS ago
            // but the RPC still hasn't indexed the NFT, DO NOT open a second position.
            // Wait for the next loop iteration; the position will appear once the RPC
            // catches up (observed lag: up to 90 + s on congested nodes).
            const msSinceOpen = Date.now() - lastConfirmedOpenAt;
            if (msSinceOpen < OPEN_GUARD_MS) {
                console.log(`⏳ Open position TX confirmed ${(msSinceOpen / 1000).toFixed(0)}s ago — RPC indexing lag, skipping re-open to prevent duplicate.`);
                return;
            }
            // ────────────────────────────────────────────────────────────────────
            await rebalanceToRatio(poolInfo, tickLower, tickUpper);
            const openedPosition = await depositLiquidity(poolInfo, poolInfoRaw.poolKeys, tickLower, tickUpper, true);
            // Pass the confirmed position directly so sweepDust doesn't need to
            // re-query when the RPC is still slow to index.
            await sweepDust(poolInfo, poolInfoRaw.poolKeys, tickLower, tickUpper, openedPosition ?? undefined);
        } else {
            if (myPosition.tickLower !== tickLower) {
                console.log("🔁 Out of range, re-ranging...");
                // Clear the open-guard timestamp: we are about to close this
                // position and open a fresh one, so the guard must not block it.
                lastConfirmedOpenAt = 0;
                await safeWithdrawAll(myPosition);
                const updated = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
                const updatedInfo = updated.poolInfo;
                // @ts-ignore
                const newTick = updatedInfo.tickCurrent ?? 0;
                const newTickSpacing = updatedInfo.config.tickSpacing;
                const newTickLower = Math.floor(newTick / newTickSpacing) * newTickSpacing;
                const newTickUpper = newTickLower + newTickSpacing;
                await rebalanceToRatio(updatedInfo, newTickLower, newTickUpper);
                const openedPosition = await depositLiquidity(updatedInfo, updated.poolKeys, newTickLower, newTickUpper, true, undefined, { poolInfo: updatedInfo, poolKeys: updated.poolKeys });
                await sweepDust(updatedInfo, updated.poolKeys, newTickLower, newTickUpper, openedPosition ?? undefined);
            } else {
                const usdc = await getTokenBalance(MINT_A);
                const usdt = await getTokenBalance(MINT_B);
                if (usdc.add(usdt).gt(DUST_THRESHOLD_RAW)) {
                    await rebalanceToRatio(poolInfo, tickLower, tickUpper);
                    await sweepDust(poolInfo, poolInfoRaw.poolKeys, tickLower, tickUpper, myPosition);
                } else console.log(`✅ Position Healthy (Dust < $${DUST_THRESHOLD_USD})`);
            }
        }
    } catch (e: any) { console.error('Loop Error:', e.message); }
}

async function startBot() {
    await initRaydium();
    while (true) {
        const loopStart = Date.now();
        await mainLoop();
        const elapsed = Date.now() - loopStart;
        const remaining = Math.max(0, CHECK_INTERVAL_MS - elapsed);
        if (remaining > 0) {
            console.log(`⏱ Next check in ${(remaining / 1000).toFixed(0)}s`);
            await new Promise(r => setTimeout(r, remaining));
        }
    }
}
startBot();
