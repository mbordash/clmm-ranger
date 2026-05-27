import 'dotenv/config';
import { Connection, PublicKey, VersionedTransaction, Transaction, Keypair } from '@solana/web3.js';
import { Raydium, TickUtils, ApiV3PoolInfoConcentratedItem, TxVersion } from '@raydium-io/raydium-sdk-v2';
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
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

const CHECK_INTERVAL_MS = 120_000; 
const TARGET_WALLET = process.env.WALLET_ADDRESS!;
const LEDGER_PATH = process.env.LEDGER_PATH ?? "44'/501'";

Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

// ====================== SETUP ======================
const connection = new Connection(RPC_URL, 'confirmed');
let raydium: Raydium;
let walletAddress: PublicKey;
let ledgerSigner: any;

async function getLedgerSigner() {
    const transport = await TransportNodeHid.create();
    const solanaApp = new SolanaApp(transport);
    const { address } = await solanaApp.getAddress(LEDGER_PATH);
    const addrStr = Buffer.isBuffer(address) ? bs58.encode(address) : address;
    if (addrStr !== TARGET_WALLET) throw new Error("Wallet mismatch");
    const publicKey = new PublicKey(addrStr);
    return {
        publicKey,
        signTransaction: async (tx: any) => {
            console.log("\n📲 Please confirm on Ledger...");
            const message = tx instanceof Transaction ? tx.serializeMessage() : tx.message.serialize();
            const { signature } = await solanaApp.signTransaction(LEDGER_PATH, Buffer.from(message));
            tx.addSignature(publicKey, signature);
            return tx;
        }
    };
}

async function initRaydium() {
    ledgerSigner = await getLedgerSigner();
    walletAddress = ledgerSigner.publicKey;
    raydium = await Raydium.load({ connection, owner: walletAddress, signAllTransactions: async (txs) => {
        const signed = [];
        for (const tx of txs) signed.push(await ledgerSigner.signTransaction(tx));
        return signed;
    }});
    // @ts-ignore
    raydium.clmm.programId = ACTUAL_PROGRAM_ID;
    console.log(`✅ Bot Ready: ${walletAddress.toBase58()}`);
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
        const { data: { swapTransaction } } = await axios.post('https://api.jup.ag/swap/v1/swap', { quoteResponse, userPublicKey: walletAddress.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false, prioritizationFeeLamports: 50000 });
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
    if (diffUsdc.abs().gt(100_000)) { 
        console.log(`🔄 Rebalancing: ${diffUsdc.gt(0) ? "Selling USDC for USDT" : "Selling USDT for USDC"}`);
        const swapTx = diffUsdc.gt(0) ? await getJupiterSwapTx(MINT_A, MINT_B, diffUsdc.toFixed(0)) : await getJupiterSwapTx(MINT_B, MINT_A, new Decimal(usdtBal.toString()).sub(targetUsdt).toFixed(0));
        if (swapTx) { await sendAndConfirm(swapTx, "Jupiter Rebalance Swap"); await new Promise(r => setTimeout(r, 2000)); await raydium.account.fetchWalletTokenAccounts(); }
    }
}

async function depositLiquidity(_poolInfo: ApiV3PoolInfoConcentratedItem, _poolKeys: any, tickLower: number, tickUpper: number, isNew: boolean, position?: any) {
    // Always re-fetch pool state immediately before building the deposit tx.
    // The poolInfo passed in may be stale (fetched at loop start, before Ledger
    // confirmations for swaps). A stale sqrtPriceX64 produces a wrong R which
    // causes 6021 PriceSlippageCheck when the on-chain price has since drifted.
    const freshRaw  = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
    const poolInfo  = freshRaw.poolInfo;
    const poolKeys  = freshRaw.poolKeys;

    await raydium.account.fetchWalletTokenAccounts();
    const usdcBal = await getTokenBalance(MINT_A);
    const usdtBal = await getTokenBalance(MINT_B);
    if (usdcBal.add(usdtBal).lt(new BN(100_000))) return;

    const { R } = await getRatioMath(poolInfo, tickLower, tickUpper);

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

    console.log(`🚀 ${isNew ? "Opening" : "Top-up"} via ${useUsdcAsBase ? "USDC" : "USDT"} (Ratio: ${R.toFixed(4)})`);
    let res;
    if (isNew) res = await raydium.clmm.openPositionFromBase({ poolInfo, poolKeys, tickLower, tickUpper, baseAmount, otherAmountMax: otherAmount, base: useUsdcAsBase ? 'MintA' : 'MintB', ownerInfo: { useSOLBalance: false }, withMetadata: 'no-create', txVersion: TxVersion.LEGACY });
    // @ts-ignore
    else res = await raydium.clmm.increasePositionFromBase({ poolInfo, ownerPosition: position, baseAmount, otherAmountMax: otherAmount, base: useUsdcAsBase ? 'MintA' : 'MintB', ownerInfo: { useSOLBalance: false }, txVersion: TxVersion.LEGACY });

    const tx = res.transaction as Transaction;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.feePayer = walletAddress;
    const validSigners = (res.signers || []).filter(s => s instanceof Keypair);
    if (validSigners.length > 0) tx.sign(...validSigners);
    await sendAndConfirm(tx, isNew ? "Open Position" : "Increase Liquidity");
}

/**
 * Repeatedly top-up the active position until wallet dust drops below $1.
 * Each call to depositLiquidity deposits 90% of the dominant token; this loop
 * runs immediately (no inter-loop wait) until the remainder is negligible.
 */
async function sweepDust(poolInfo: ApiV3PoolInfoConcentratedItem, poolKeys: any, tickLower: number, tickUpper: number) {
    const MAX_ROUNDS = 6;
    for (let round = 0; round < MAX_ROUNDS; round++) {
        await new Promise(r => setTimeout(r, 1500)); // brief settle for RPC state
        const usdc = await getTokenBalance(MINT_A);
        const usdt = await getTokenBalance(MINT_B);
        if (usdc.add(usdt).lte(new BN(1_000_000))) {
            if (round > 0) console.log("✅ Dust cleared.");
            return;
        }
        // Find the current position (needed for increasePositionFromBase)
        const positions = await raydium.clmm.getOwnerPositionInfo({ programId: ACTUAL_PROGRAM_ID });
        const pos = positions.find(p => p.poolId.equals(POOL_ID) && !p.liquidity.isZero());
        if (!pos) { console.log("⚠️ sweepDust: no active position found, skipping."); return; }
        console.log(`🧹 Sweep round ${round + 1}: $${(usdc.toNumber() + usdt.toNumber()) / 1e6} remaining`);
        await depositLiquidity(poolInfo, poolKeys, tickLower, tickUpper, false, pos);
    }
}

async function mainLoop() {
    try {
        console.log('\n--- Loop ---');
        const poolInfoRaw = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
        const poolInfo = poolInfoRaw.poolInfo;
        const positions = await raydium.clmm.getOwnerPositionInfo({ programId: ACTUAL_PROGRAM_ID });
        const myPosition = positions.find(p => p.poolId.equals(POOL_ID));
        // @ts-ignore
        const tickCurrent = poolInfo.tickCurrent ?? 0;
        const tickSpacing = poolInfo.config.tickSpacing;
        const tickLower = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
        const tickUpper = tickLower + tickSpacing;

        if (!myPosition || myPosition.liquidity.isZero()) {
            await rebalanceToRatio(poolInfo, tickLower, tickUpper);
            await depositLiquidity(poolInfo, poolInfoRaw.poolKeys, tickLower, tickUpper, true);
            // Sweep remaining dust immediately (no loop wait)
            await sweepDust(poolInfo, poolInfoRaw.poolKeys, tickLower, tickUpper);
        } else {
            if (myPosition.tickLower !== tickLower) {
                console.log("🔁 Out of range, re-ranging...");
                await safeWithdrawAll(myPosition);
                const updated = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
                const updatedInfo = updated.poolInfo;
                // @ts-ignore
                const newTick = updatedInfo.tickCurrent ?? 0;
                const newTickSpacing = updatedInfo.config.tickSpacing;
                const newTickLower = Math.floor(newTick / newTickSpacing) * newTickSpacing;
                const newTickUpper = newTickLower + newTickSpacing;
                await rebalanceToRatio(updatedInfo, newTickLower, newTickUpper);
                await depositLiquidity(updatedInfo, updated.poolKeys, newTickLower, newTickUpper, true);
                await sweepDust(updatedInfo, updated.poolKeys, newTickLower, newTickUpper);
            } else {
                const usdc = await getTokenBalance(MINT_A);
                const usdt = await getTokenBalance(MINT_B);
                if (usdc.add(usdt).gt(new BN(1_000_000))) {
                    await rebalanceToRatio(poolInfo, tickLower, tickUpper);
                    await sweepDust(poolInfo, poolInfoRaw.poolKeys, tickLower, tickUpper);
                } else console.log("✅ Position Healthy (Dust < $1)");
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
