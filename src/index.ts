import 'dotenv/config';
import { Connection, PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js';
import { Raydium, TickUtils, ApiV3PoolInfoConcentratedItem, TxVersion } from '@raydium-io/raydium-sdk-v2';
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import TransportNodeHid from "@ledgerhq/hw-transport-node-hid";
import SolanaApp from "@ledgerhq/hw-app-solana";
import axios from 'axios';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import bs58 from 'bs58';

// ====================== CONFIG ======================
const RPC_URL = process.env.RPC_URL!;
const MINT_A = new PublicKey(process.env.MINT_A ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MINT_B = new PublicKey(process.env.MINT_B ?? 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const POOL_ID = new PublicKey(process.env.POOL_ID!);
const ACTUAL_PROGRAM_ID = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');

const REBALANCE_RESIDUAL_USD = Number(process.env.REBALANCE_RESIDUAL_USD ?? '1.0');
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS ?? '60000');
const TARGET_WALLET = process.env.WALLET_ADDRESS!;
const LEDGER_PATH = process.env.LEDGER_PATH ?? "44'/501'";
const MIN_SOL_LAMPORTS = Number(process.env.MIN_SOL_LAMPORTS ?? '35000000');

// Increase Decimal.js precision to handle large Q64 numbers (sqrtPriceX64 ~ 2^64 ≈ 1.8e19)
// Multiplied 3× that's ~5.8e57 — needs >58 digits; use 80 for safety.
Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

// ====================== SETUP ======================
const connection = new Connection(RPC_URL, 'confirmed');
let raydium: Raydium;
let walletAddress: PublicKey;
let ledgerSigner: any;

async function getLedgerSigner() {
    const transport = await TransportNodeHid.create();
    const solanaApp = new SolanaApp(transport);
    const foundPath = LEDGER_PATH;
    const { address } = await solanaApp.getAddress(foundPath);
    const addrStr = Buffer.isBuffer(address) ? bs58.encode(address) : address;
    if (addrStr !== TARGET_WALLET) throw new Error(`Path ${foundPath} returned ${addrStr}, not ${TARGET_WALLET}.`);
    const publicKey = new PublicKey(addrStr);
    const signTx = async (tx: any) => {
        console.log("\n📲 Please confirm on Ledger...");
        const message = tx instanceof Transaction ? tx.serializeMessage() : tx.message.serialize();
        const { signature } = await solanaApp.signTransaction(foundPath, Buffer.from(message));
        tx.addSignature(publicKey, signature);
        return tx;
    };
    return { publicKey, signTransaction: signTx, signAllTransactions: async (txs: any[]) => {
        const signed = [];
        for (const tx of txs) signed.push(await signTx(tx));
        return signed;
    }};
}

async function initRaydium() {
    try {
        ledgerSigner = await getLedgerSigner();
        walletAddress = ledgerSigner.publicKey;
        raydium = await Raydium.load({ connection, owner: walletAddress, signAllTransactions: ledgerSigner.signAllTransactions });
        // @ts-ignore
        raydium.clmm.programId = ACTUAL_PROGRAM_ID;
        await raydium.account.fetchWalletTokenAccounts();
        console.log(`✅ Bot Ready: ${walletAddress.toBase58()}`);
    } catch (e: any) { console.error("Init Error:", e.message); process.exit(1); }
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
        const { data: quoteResponse } = await axios.get(
            `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=50`
        );
        const { data: { swapTransaction } } = await axios.post('https://api.jup.ag/swap/v1/swap', {
            quoteResponse, userPublicKey: walletAddress.toString(), wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto'
        });
        return VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    } catch (error) { console.error('Jupiter swap API error:', error); return null; }
}

async function sendAndConfirm(tx: Transaction | VersionedTransaction) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    if (tx instanceof Transaction) { tx.recentBlockhash = blockhash; tx.feePayer = walletAddress; }
    const signedTx = await ledgerSigner.signTransaction(tx);
    const signature = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true });
    console.log(`TX Sent: ${signature}. Verifying...`);
    const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
    console.log(`✅ Confirmed: ${signature}`);
    return signature;
}

// ====================== CORE ACTIONS ======================

async function safeWithdrawAll(position: any) {
    console.log(`\n🛡️ WITHDRAWING POSITION...`);

    // Detect the actual token program for the position NFT mint
    const nftMintInfo = await connection.getAccountInfo(position.nftMint);
    const nftTokenProgram: PublicKey = nftMintInfo?.owner ?? TOKEN_PROGRAM_ID;
    const correctNftAta = getAssociatedTokenAddressSync(position.nftMint, walletAddress, false, nftTokenProgram);
    const sdkNftAta     = getAssociatedTokenAddressSync(position.nftMint, walletAddress, false, TOKEN_PROGRAM_ID);
    const atasDiffer    = !correctNftAta.equals(sdkNftAta);
    if (atasDiffer) {
        console.log(`🔧 NFT token program: ${nftTokenProgram.toBase58()} (patching ATA)`);
        console.log(`   SDK ATA:     ${sdkNftAta.toBase58()}`);
        console.log(`   Correct ATA: ${correctNftAta.toBase58()}`);
    }

    const poolInfoRaw = await raydium.clmm.getPoolInfoFromRpc(position.poolId.toBase58());

    // The SDK's clmmComputeInfoToApiInfo() hardcodes rewardDefaultInfos:[] which causes
    // InvalidRewardInputAccountNumber (6035) on-chain. Populate it from poolKeys.rewardInfos.
    if (poolInfoRaw.poolKeys.rewardInfos && poolInfoRaw.poolKeys.rewardInfos.length > 0) {
        // @ts-ignore – SDK type mismatch; we only need mint+vault for reward account derivation
        poolInfoRaw.poolInfo.rewardDefaultInfos = poolInfoRaw.poolKeys.rewardInfos.map((r: any) => ({
            mint: r.mint,
            vault: r.vault,
            // minimal fields the SDK needs to build rewardAccounts
            openTime: '0', endTime: '0', emissionsPerSecondX64: '0',
            rewardTotalEmissioned: 0, rewardClaimed: 0,
            tokenProgramId: r.mint?.programId ?? TOKEN_PROGRAM_ID.toBase58(),
            creator: '',
            type: 'Standard SPL' as any,
            perSecond: 0,
        }));
        console.log(`🎁 Populated ${poolInfoRaw.poolInfo.rewardDefaultInfos.length} reward(s) from poolKeys`);
    }

    // ── Step 1: Decrease liquidity to zero (collect all tokens + fees) ──────
    // @ts-ignore
    const { transaction: decreaseTx } = await raydium.clmm.decreaseLiquidity({
        poolInfo: poolInfoRaw.poolInfo,
        ownerPosition: position,
        ownerInfo: { useSOLBalance: false, closePosition: false },
        liquidity: position.liquidity,
        amountMinA: new BN(0),
        amountMinB: new BN(0),
        txVersion: TxVersion.LEGACY
    });

    // Patch positionNftAccount (key index 1) in every CLMM instruction if needed
    if (atasDiffer) {
        const CLMM_PROG = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
        for (const ix of (decreaseTx as Transaction).instructions) {
            if (ix.programId.equals(CLMM_PROG)) {
                for (const key of ix.keys) {
                    if (key.pubkey.equals(sdkNftAta)) key.pubkey = correctNftAta;
                }
            }
        }
    }

    console.log("📤 Sending decrease-liquidity tx...");
    await sendAndConfirm(decreaseTx as Transaction);
    await new Promise(r => setTimeout(r, 3000));

    // ── Step 2: Close the position (burn NFT, reclaim rent) ─────────────────
    // @ts-ignore
    const { transaction: closeTx } = await raydium.clmm.closePosition({
        poolInfo: poolInfoRaw.poolInfo,
        ownerPosition: position,
        txVersion: TxVersion.LEGACY
    });

    // Patch the close tx: replace wrong ATA AND wrong token program (SDK hardcodes TOKEN_PROGRAM_ID)
    if (atasDiffer) {
        const CLMM_PROG = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
        for (const ix of (closeTx as Transaction).instructions) {
            if (ix.programId.equals(CLMM_PROG)) {
                for (const key of ix.keys) {
                    if (key.pubkey.equals(sdkNftAta)) key.pubkey = correctNftAta;
                    // SDK hardcodes TOKEN_PROGRAM_ID in closePositionInstruction keys;
                    // replace it with the actual token program that owns the NFT ATA.
                    if (key.pubkey.equals(TOKEN_PROGRAM_ID)) key.pubkey = nftTokenProgram;
                }
            }
        }
    }

    console.log("📤 Sending close-position tx...");
    await sendAndConfirm(closeTx as Transaction);

    const sol = await connection.getBalance(walletAddress);
    console.log(`✅ Position Closed. SOL balance: ${(sol / 1e9).toFixed(4)}`);
}

/**
 * Compute the ideal USDC/USDT split for a CLMM position using the standard
 * concentrated-liquidity ratio formula, then iteratively swap via Jupiter
 * until the residual imbalance is under REBALANCE_RESIDUAL_USD.
 */
async function rebalanceAndDeposit(
    poolInfo: ApiV3PoolInfoConcentratedItem,
    poolKeys: any                          // ← now receives poolKeys directly
) {
    try {
        // ── SOL rent guard ──────────────────────────────────────────────────
        // Opening a CLMM position requires rent for: NFT mint account, NFT token
        // account, metadata account, personal position PDA, protocol position PDA,
        // plus tx fees.  Total ≈ 0.025 SOL.  Keep a 0.035 SOL minimum to be safe.
        const MIN_SOL_LAMPORTS = 35_000_000; // 0.035 SOL
        const solBal = await connection.getBalance(walletAddress);
        if (solBal < MIN_SOL_LAMPORTS) {
            const needed = MIN_SOL_LAMPORTS - solBal + 5_000_000; // extra 0.005 buffer
            const usdcNeeded = Math.ceil(needed / 6.5).toString(); // rough SOL price estimate; overshoot is fine
            console.log(`⚠️ Low SOL for rent: ${(solBal/1e9).toFixed(4)} SOL, need ~${(MIN_SOL_LAMPORTS/1e9).toFixed(4)}. Swapping ~${(Number(usdcNeeded)/1e6).toFixed(2)} USDC → SOL...`);
            const swapTx = await getJupiterSwapTx(MINT_A, new PublicKey('So11111111111111111111111111111111111111112'), usdcNeeded);
            if (swapTx) { await sendAndConfirm(swapTx); await new Promise(r => setTimeout(r, 2000)); }
        }

        // ── Compute target ticks centered on current tick ───────────────────
        // @ts-ignore
        const tickCurrent: number = poolInfo.tickCurrent ?? 0;
        const tickSpacing: number = poolInfo.config.tickSpacing;

        // Tightest possible range: 1 tick wide, containing the current tick.
        // CLMM convention: position is in range when tickLower <= tickCurrent < tickUpper.
        // So we set tickLower = roundedTick, tickUpper = roundedTick + tickSpacing.
        const roundedTick = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
        const tickLower = roundedTick;
        const tickUpper = roundedTick + tickSpacing;

        const lowerPrice = TickUtils.getTickPrice({ poolInfo, tick: tickLower, baseIn: true }).price;
        const upperPrice = TickUtils.getTickPrice({ poolInfo, tick: tickUpper, baseIn: true }).price;
        console.log(`\n🎯 New range: tick [${tickLower}, ${tickUpper}]  price [${lowerPrice.toFixed(15)}, ${upperPrice.toFixed(15)}]`);

        // ── Iterative swap loop until residual < $1 ─────────────────────────
        // @ts-ignore
        const sqrtPriceX64: BN = poolInfo.sqrtPriceX64;
        const Q64 = new Decimal(2).pow(64);
        const sP  = new Decimal(sqrtPriceX64.toString());
        const sPa = new Decimal(TickUtils.getTickPrice({ poolInfo, tick: tickLower, baseIn: true }).tickSqrtPriceX64.toString());
        const sPb = new Decimal(TickUtils.getTickPrice({ poolInfo, tick: tickUpper, baseIn: true }).tickSqrtPriceX64.toString());

        console.log(`   sqrtPriceX64: sP=${sP.toFixed(0)}, sPa=${sPa.toFixed(0)}, sPb=${sPb.toFixed(0)}`);
        console.log(`   sP > sPa? ${sP.gt(sPa)}, sP < sPb? ${sP.lt(sPb)} (should both be true if inside range)`);

        let iteration = 0;
        const MAX_ITER = 6;

        while (iteration < MAX_ITER) {
            iteration++;
            let usdcBal = await getTokenBalance(MINT_A);
            let usdtBal = await getTokenBalance(MINT_B);

            const usdcRaw = new Decimal(usdcBal.toString());
            const usdtRaw = new Decimal(usdtBal.toString());
            const price   = new Decimal(poolInfo.price);   // USDT per USDC

            const totalUsdcVal = usdcRaw.add(usdtRaw.div(price));

            let tUsdc: Decimal, tUsdt: Decimal;
            if (sP.lte(sPa)) {
                // Price is below range → 100 % token A (USDC)
                tUsdc = totalUsdcVal;
                tUsdt = new Decimal(0);
            } else if (sP.gte(sPb)) {
                // Price is above range → 100 % token B (USDT)
                tUsdc = new Decimal(0);
                tUsdt = totalUsdcVal.mul(price);
            } else {
                // Price is inside range → standard CLMM ratio
                // amountA (USDC) ∝ (sPb - sP) / (sP * sPb)   [in Q64 space]
                // amountB (USDT) ∝ (sP - sPa) / Q64
                // R = amountA / amountB = Q64^2 * (sPb - sP) / (sP * sPb * (sP - sPa))
                const R = sPb.sub(sP).mul(Q64).mul(Q64).div(sP.mul(sPb).mul(sP.sub(sPa)));
                console.log(`   R (USDC/USDT ratio) = ${R.toFixed(6)}, price = ${price.toFixed(6)}`);
                tUsdt = totalUsdcVal.div(R.add(new Decimal(1).div(price)));
                tUsdc = R.mul(tUsdt);
            }

            const diffUsdc = usdcRaw.sub(tUsdc);   // positive → need to sell USDC, negative → need to buy USDC
            const residualUsd = diffUsdc.abs().div(1e6);

            console.log(`\n⚖️  Iter ${iteration}: USDC=${usdcRaw.div(1e6).toFixed(4)}, USDT=${usdtRaw.div(1e6).toFixed(4)}`);
            console.log(`   Target USDC=${tUsdc.div(1e6).toFixed(4)}, Target USDT=${tUsdt.div(1e6).toFixed(4)}`);
            console.log(`   Residual imbalance: $${residualUsd.toFixed(4)}`);

            if (residualUsd.lte(REBALANCE_RESIDUAL_USD)) {
                console.log("✅ Residual under $1 — balance achieved.");
                break;
            }

            // Swap the exact imbalance amount
            let swapTx: VersionedTransaction | null = null;
            if (diffUsdc.gt(0)) {
                // Have too much USDC → sell USDC for USDT
                const swapAmt = diffUsdc.toFixed(0);
                console.log(`🔄 Selling ${new Decimal(swapAmt).div(1e6).toFixed(4)} USDC → USDT`);
                swapTx = await getJupiterSwapTx(MINT_A, MINT_B, swapAmt);
            } else {
                // Have too much USDT → sell USDT for USDC
                const usdtDiff = usdtRaw.sub(tUsdt);
                const swapAmt = usdtDiff.toFixed(0);
                console.log(`🔄 Selling ${new Decimal(swapAmt).div(1e6).toFixed(4)} USDT → USDC`);
                swapTx = await getJupiterSwapTx(MINT_B, MINT_A, swapAmt);
            }

            if (!swapTx) { console.error("❌ Jupiter returned no swap tx — aborting rebalance."); return; }
            await sendAndConfirm(swapTx);
            // Brief pause for RPC state to settle
            await new Promise(r => setTimeout(r, 3000));
        }

        // ── Deposit everything ──────────────────────────────────────────────
        let usdcBal = await getTokenBalance(MINT_A);
        let usdtBal = await getTokenBalance(MINT_B);

        if (usdcBal.isZero() && usdtBal.isZero()) {
            console.error("❌ No tokens to deposit."); return;
        }

        // Use whichever token is larger as the "base" for openPositionFromBase.
        // Pass the full balance of the other token as otherAmountMax so the SDK
        // uses as much as possible without leaving dust.
        // Hold back a fixed buffer from baseAmount so the SDK's computed
        // otherAmount doesn't exceed our wallet balance due to micro price moves.
        // $0.50 was too tight in practice (PriceSlippageCheck 6021 with ~$0.26 overshoot);
        // use $2.00 to give comfortable headroom on stablecoin pairs.
        const useUsdtAsBase = usdtBal.gt(usdcBal);
        const rawBase  = useUsdtAsBase ? usdtBal : usdcBal;
        const BUFFER = new BN(2_000_000); // $2.00 in 6-decimal raw units
        const baseAmount = rawBase.sub(BUFFER);
        const otherMax   = useUsdtAsBase ? usdcBal : usdtBal;

        console.log(`\n🚀 Depositing: base=${baseAmount.toNumber()/1e6} ${useUsdtAsBase ? 'USDT' : 'USDC'}, otherMax=${otherMax.toNumber()/1e6} ${useUsdtAsBase ? 'USDC' : 'USDT'}`);

        // Refresh the SDK's cached token account list so it finds the correct ATAs
        // (after swaps, the old snapshot may be stale or missing newly-created accounts).
        await raydium.account.fetchWalletTokenAccounts();

        // ⚠️  Use TxVersion.LEGACY — Ledger hardware wallets do not support signing
        //     versioned (V0) transactions via the standard signTransaction path.
        // We also need `signers` — the SDK generates an ephemeral NFT mint keypair
        // that must sign the transaction alongside the Ledger wallet signature.
        const { transaction: depositTx, signers: depositSigners } = await raydium.clmm.openPositionFromBase({
            poolInfo,
            poolKeys,          // pass directly — avoids an extra API round-trip
            tickLower,
            tickUpper,
            baseAmount,
            otherAmountMax: otherMax,
            base: useUsdtAsBase ? 'MintB' : 'MintA',
            ownerInfo: { useSOLBalance: false },
            txVersion: TxVersion.LEGACY
        });

        console.log("📤 Sending open-position tx...");

        // Build the transaction manually so we can apply both signers in the right order:
        //   1. SDK-internal keypairs (NFT mint keypair) sign first via tx.sign()
        //   2. Ledger wallet signs via addSignature — serializeMessage() is unaffected by prior sigs
        const tx = depositTx as Transaction;
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = walletAddress;

        // Step 1: sign with the ephemeral NFT mint keypair (and any other SDK keypairs)
        if (depositSigners && depositSigners.length > 0) {
            tx.sign(...depositSigners);
        }

        // Log instruction summary for debugging
        console.log(`📋 Deposit tx has ${tx.instructions.length} instructions:`);
        for (let i = 0; i < tx.instructions.length; i++) {
            const ix = tx.instructions[i];
            console.log(`   [${i}] program=${ix.programId.toBase58().slice(0, 12)}... keys=${ix.keys.length} data=${ix.data.length}b`);
        }

        // Simulate before sending to get a clearer error if it would fail
        try {
            const simResult = await connection.simulateTransaction(tx);
            if (simResult.value.err) {
                console.error("⚠️ Simulation failed:", JSON.stringify(simResult.value.err));
                console.error("   Logs:", simResult.value.logs?.join('\n   '));
                console.error("❌ Aborting deposit — simulation failed.");
                return;
            } else {
                console.log("✅ Simulation passed");
            }
        } catch (simErr: any) {
            console.error("⚠️ Simulation error:", simErr.message);
            console.error("❌ Aborting deposit — simulation error.");
            return;
        }

        // Step 2: sign with Ledger (appends wallet signature via addSignature)
        const signedDepositTx = await ledgerSigner.signTransaction(tx);
        const txId = await connection.sendRawTransaction(signedDepositTx.serialize(), { skipPreflight: true });
        console.log(`TX Sent: ${txId}. Verifying...`);
        const result = await connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight }, 'confirmed');
        if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
        console.log(`✅ Position opened: ${txId}`);

        const dustUsdc = await getTokenBalance(MINT_A);
        const dustUsdt = await getTokenBalance(MINT_B);
        console.log(`💰 Remaining dust: ${dustUsdc.toNumber()/1e6} USDC, ${dustUsdt.toNumber()/1e6} USDT`);

        // ── Dust sweep: top up with any leftover balance ────────────────────
        // The $2 open-buffer typically leaves ~$2–3 of dust. Now that the position
        // exists we can sweep it cheaply via increasePositionFromBase (no NFT rent).
        const dustValue = new Decimal(dustUsdc.toString()).add(new Decimal(dustUsdt.toString())).div(1e6);
        if (dustValue.gt(1)) {
            console.log(`💵 Auto-sweeping $${dustValue.toFixed(2)} of post-open dust...`);
            await new Promise(r => setTimeout(r, 2000));
            const freshPositions = await raydium.clmm.getOwnerPositionInfo({ programId: ACTUAL_PROGRAM_ID });
            const newPosition = freshPositions.find(p => p.poolId.equals(new PublicKey(poolInfo.id)) &&
                p.tickLower === tickLower && p.tickUpper === tickUpper);
            if (newPosition) {
                await topUpPosition(newPosition, poolInfo, poolKeys);
            } else {
                console.log("⚠️ Could not find newly opened position for dust sweep — skipping.");
            }
        }

    } catch (err: any) { console.error('Deposit Error:', err); }
}

/**
 * Top up an existing position with undeposited dust by rebalancing and calling increaseLiquidity.
 * Much cheaper than re-ranging (no NFT burn/mint, no position PDA recreation).
 */
async function topUpPosition(
    position: any,
    poolInfo: ApiV3PoolInfoConcentratedItem,
    poolKeys: any
) {
    try {
        const tickLower = position.tickLower;
        const tickUpper = position.tickUpper;

        console.log(`\n💰 TOPPING UP POSITION...`);
        console.log(`   Using existing range: tick [${tickLower}, ${tickUpper}]`);

        // ── Rebalance dust to match position's tick range ratio ──────────────
        // @ts-ignore
        const sqrtPriceX64: BN = poolInfo.sqrtPriceX64;
        const Q64 = new Decimal(2).pow(64);
        const sP  = new Decimal(sqrtPriceX64.toString());
        const sPa = new Decimal(TickUtils.getTickPrice({ poolInfo, tick: tickLower, baseIn: true }).tickSqrtPriceX64.toString());
        const sPb = new Decimal(TickUtils.getTickPrice({ poolInfo, tick: tickUpper, baseIn: true }).tickSqrtPriceX64.toString());
        const price = new Decimal(poolInfo.price);

        let iteration = 0;
        const MAX_ITER = 6;

        while (iteration < MAX_ITER) {
            iteration++;
            let usdcBal = await getTokenBalance(MINT_A);
            let usdtBal = await getTokenBalance(MINT_B);

            const usdcRaw = new Decimal(usdcBal.toString());
            const usdtRaw = new Decimal(usdtBal.toString());
            const totalUsdcVal = usdcRaw.add(usdtRaw.div(price));

            let tUsdc: Decimal, tUsdt: Decimal;
            if (sP.lte(sPa)) {
                tUsdc = totalUsdcVal;
                tUsdt = new Decimal(0);
            } else if (sP.gte(sPb)) {
                tUsdc = new Decimal(0);
                tUsdt = totalUsdcVal.mul(price);
            } else {
                const R = sPb.sub(sP).mul(Q64).mul(Q64).div(sP.mul(sPb).mul(sP.sub(sPa)));
                tUsdt = totalUsdcVal.div(R.add(new Decimal(1).div(price)));
                tUsdc = R.mul(tUsdt);
            }

            const diffUsdc = usdcRaw.sub(tUsdc);
            const residualUsd = diffUsdc.abs().div(1e6);

            console.log(`\n⚖️  Iter ${iteration}: USDC=${usdcRaw.div(1e6).toFixed(4)}, USDT=${usdtRaw.div(1e6).toFixed(4)}`);
            console.log(`   Target USDC=${tUsdc.div(1e6).toFixed(4)}, Target USDT=${tUsdt.div(1e6).toFixed(4)}`);
            console.log(`   Residual: $${residualUsd.toFixed(4)}`);

            if (residualUsd.lte(REBALANCE_RESIDUAL_USD)) {
                console.log("✅ Residual under $1 — balance achieved.");
                break;
            }

            let swapTx: VersionedTransaction | null = null;
            if (diffUsdc.gt(0)) {
                const swapAmt = diffUsdc.toFixed(0);
                console.log(`🔄 Selling ${new Decimal(swapAmt).div(1e6).toFixed(4)} USDC → USDT`);
                swapTx = await getJupiterSwapTx(MINT_A, MINT_B, swapAmt);
            } else {
                const usdtDiff = usdtRaw.sub(tUsdt);
                const swapAmt = usdtDiff.toFixed(0);
                console.log(`🔄 Selling ${new Decimal(swapAmt).div(1e6).toFixed(4)} USDT → USDC`);
                swapTx = await getJupiterSwapTx(MINT_B, MINT_A, swapAmt);
            }

            if (!swapTx) { console.error("❌ Jupiter returned no swap tx — aborting top-up rebalance."); return; }
            await sendAndConfirm(swapTx);
            await new Promise(r => setTimeout(r, 3000));
        }

        // ── Increase liquidity ──────────────────────────────────────────────
        let usdcBal = await getTokenBalance(MINT_A);
        let usdtBal = await getTokenBalance(MINT_B);

        if (usdcBal.isZero() && usdtBal.isZero()) {
            console.log("   No tokens after rebalance.");
            return;
        }

        await raydium.account.fetchWalletTokenAccounts();

        const useUsdtAsBase = usdtBal.gt(usdcBal);
        const rawBase = useUsdtAsBase ? usdtBal : usdcBal;
        const BUFFER = new BN(250_000); // $0.25 — tight buffer; no NFT rent risk on increase
        const baseAmount = rawBase.sub(BUFFER);
        const otherMax = useUsdtAsBase ? usdcBal : usdtBal;

        console.log(`\n📤 Increasing liquidity: base=${baseAmount.toNumber()/1e6} ${useUsdtAsBase ? 'USDT' : 'USDC'}, otherMax=${otherMax.toNumber()/1e6} ${useUsdtAsBase ? 'USDC' : 'USDT'}`);

        // @ts-ignore
        const { transaction: increaseTx, signers: increaseSigners } = await raydium.clmm.increasePositionFromBase({
            poolInfo,
            ownerPosition: position,
            baseAmount,
            otherAmountMax: otherMax,
            base: useUsdtAsBase ? 'MintB' : 'MintA',
            ownerInfo: { useSOLBalance: false },
            txVersion: TxVersion.LEGACY
        });

        const tx = increaseTx as Transaction;
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = walletAddress;

        if (increaseSigners && increaseSigners.length > 0) {
            tx.sign(...increaseSigners);
        }

        console.log(`📋 Increase-liquidity tx has ${tx.instructions.length} instructions`);

        // Simulate before sending
        try {
            const simResult = await connection.simulateTransaction(tx);
            if (simResult.value.err) {
                console.error("⚠️ Simulation failed:", JSON.stringify(simResult.value.err));
                console.error("   Logs:", simResult.value.logs?.join('\n   '));
                console.error("❌ Aborting top-up — simulation failed.");
                return;
            } else {
                console.log("✅ Simulation passed");
            }
        } catch (simErr: any) {
            console.error("⚠️ Simulation error:", simErr.message);
            console.error("❌ Aborting top-up — simulation error.");
            return;
        }

        const signedTx = await ledgerSigner.signTransaction(tx);
        const txId = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true });
        console.log(`TX Sent: ${txId}. Verifying...`);
        const result = await connection.confirmTransaction({ signature: txId, blockhash, lastValidBlockHeight }, 'confirmed');
        if (result.value.err) throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
        console.log(`✅ Liquidity increased: ${txId}`);

        const dustUsdc = await getTokenBalance(MINT_A);
        const dustUsdt = await getTokenBalance(MINT_B);
        console.log(`💰 Remaining dust: ${dustUsdc.toNumber()/1e6} USDC, ${dustUsdt.toNumber()/1e6} USDT`);

    } catch (err: any) { console.error('Top-up Error:', err); }
}

async function mainLoop() {
    try {
        console.log('\n--- Loop ---');
        const poolInfoRaw = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
        const poolInfo = poolInfoRaw.poolInfo;
        const poolKeys = poolInfoRaw.poolKeys;  // ← capture poolKeys here
        // @ts-ignore
        const tickCurrent: number = poolInfo.tickCurrent ?? 0;
        const tickSpacing: number = poolInfo.config.tickSpacing;

        const positions = await raydium.clmm.getOwnerPositionInfo({ programId: ACTUAL_PROGRAM_ID });
        const myPosition = positions.find(p => p.poolId.equals(POOL_ID));

        if (!myPosition || myPosition.liquidity.isZero()) {
            // No active position — deposit if we have funds
            const totalBal = (await getTokenBalance(MINT_A)).add(await getTokenBalance(MINT_B));
            if (totalBal.gt(new BN(5_000_000))) {
                console.log("📭 No active position. Opening new one...");
                await rebalanceAndDeposit(poolInfo, poolKeys);
            } else {
                console.log("📭 No active position and insufficient funds.");
            }
        } else {
            const posLower = myPosition.tickLower;
            const posUpper = myPosition.tickUpper;
            const lowerPrice = TickUtils.getTickPrice({ poolInfo, tick: posLower, baseIn: true }).price;
            const upperPrice = TickUtils.getTickPrice({ poolInfo, tick: posUpper, baseIn: true }).price;

            // Compute what the ideal centered range would be right now
            const roundedTick = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
            const idealLower  = roundedTick;
            const idealUpper  = roundedTick + tickSpacing;

            const isOutOfRange = tickCurrent < posLower || tickCurrent >= posUpper;
            const isStale      = posLower !== idealLower || posUpper !== idealUpper;

            console.log(`📊 Pool tick: ${tickCurrent}  |  Position: [${posLower}, ${posUpper}]  price [${lowerPrice.toFixed(6)}, ${upperPrice.toFixed(6)}]`);
            console.log(`   Ideal range: [${idealLower}, ${idealUpper}]  |  Out-of-range: ${isOutOfRange}  |  Stale: ${isStale}`);

            if (isOutOfRange || isStale) {
                console.log("🔁 Re-ranging position...");
                await safeWithdrawAll(myPosition);
                // Re-fetch pool state after withdrawal so tick/price/sqrtPriceX64 are fresh
                const updated = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
                await rebalanceAndDeposit(updated.poolInfo, updated.poolKeys);
            } else {
                // Check if there's undeposited dust to top up
                const usdcDust = await getTokenBalance(MINT_A);
                const usdtDust = await getTokenBalance(MINT_B);
                const dustValue = new Decimal(usdcDust.toString()).add(new Decimal(usdtDust.toString()).div(1e6));

                if (dustValue.gt(5)) {
                    console.log(`💵 Found $${dustValue.toFixed(2)} undeposited — topping up position...`);
                    await topUpPosition(myPosition, poolInfo, poolKeys);
                } else {
                    console.log("✅ Position is in range and centered. No action needed.");
                }
            }
        }
    } catch (err: any) { console.error('Loop Error:', err.message); }
}

async function startBot() {
    await initRaydium();
    await mainLoop();
    console.log("\n✅ Done. Exiting.");
    process.exit(0);
}
startBot();
