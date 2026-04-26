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

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS ?? '60000');
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
        const { data: quoteResponse } = await axios.get(`https://api.jup.ag/swap/v1/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=50`);
        const { data: { swapTransaction } } = await axios.post('https://api.jup.ag/swap/v1/swap', { quoteResponse, userPublicKey: walletAddress.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' });
        return VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    } catch (e) { return null; }
}

async function sendAndConfirm(tx: Transaction | VersionedTransaction) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    if (tx instanceof Transaction) { tx.recentBlockhash = blockhash; tx.feePayer = walletAddress; }
    const signedTx = await ledgerSigner.signTransaction(tx);
    const signature = await connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true });
    console.log(`TX Sent: ${signature}`);
    const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (result.value.err) throw new Error(`TX Failed: ${JSON.stringify(result.value.err)}`);
    return signature;
}

// ====================== CORE ACTIONS ======================

async function safeWithdrawAll(position: any) {
    console.log(`\n🛡️ WITHDRAWING...`);
    const poolInfoRaw = await raydium.clmm.getPoolInfoFromRpc(position.poolId.toBase58());
    // @ts-ignore
    const { transaction: decreaseTx } = await raydium.clmm.decreaseLiquidity({
        poolInfo: poolInfoRaw.poolInfo, ownerPosition: position, ownerInfo: { useSOLBalance: false, closePosition: true },
        liquidity: position.liquidity, amountMinA: new BN(0), amountMinB: new BN(0), txVersion: TxVersion.LEGACY
    });
    await sendAndConfirm(decreaseTx as Transaction);
}

async function getRatioMath(poolInfo: ApiV3PoolInfoConcentratedItem, tickLower: number, tickUpper: number) {
    // @ts-ignore
    const sP = new Decimal(poolInfo.sqrtPriceX64.toString());
    const sPa = new Decimal(TickUtils.getTickPrice({ poolInfo, tick: tickLower, baseIn: true }).tickSqrtPriceX64.toString());
    const sPb = new Decimal(TickUtils.getTickPrice({ poolInfo, tick: tickUpper, baseIn: true }).tickSqrtPriceX64.toString());
    const Q64 = new Decimal(2).pow(64);
    const price = new Decimal(poolInfo.price);

    let R: Decimal;
    if (sP.lte(sPa)) R = new Decimal(1e18); // 100% USDC
    else if (sP.gte(sPb)) R = new Decimal(0); // 100% USDT
    else R = sPb.sub(sP).mul(Q64).mul(Q64).div(sP.mul(sPb).mul(sP.sub(sPa)));

    return { R, price, sP, sPa, sPb };
}

async function rebalanceToRatio(poolInfo: ApiV3PoolInfoConcentratedItem, tickLower: number, tickUpper: number) {
    const { R, price } = await getRatioMath(poolInfo, tickLower, tickUpper);
    
    await raydium.account.fetchWalletTokenAccounts();
    const usdcBal = await getTokenBalance(MINT_A);
    const usdtBal = await getTokenBalance(MINT_B);
    
    const usdcRaw = new Decimal(usdcBal.toString());
    const usdtRaw = new Decimal(usdtBal.toString());
    const totalUsdcVal = usdcRaw.add(usdtRaw.div(price));

    const targetUsdt = totalUsdcVal.div(R.add(new Decimal(1).div(price)));
    const targetUsdc = R.mul(targetUsdt);

    console.log(`⚖️ Wallet: USDC ${(usdcRaw.toNumber()/1e6).toFixed(2)}, USDT ${(usdtRaw.toNumber()/1e6).toFixed(2)}`);
    console.log(`🎯 Target: USDC ${(targetUsdc.toNumber()/1e6).toFixed(2)}, USDT ${(targetUsdt.toNumber()/1e6).toFixed(2)}`);

    const diffUsdc = usdcRaw.sub(targetUsdc);
    if (diffUsdc.abs().gt(1_000_000)) { // Swap if off by > $1.00
        console.log(`🔄 Rebalancing: ${diffUsdc.gt(0) ? "Selling USDC for USDT" : "Selling USDT for USDC"}`);
        const swapTx = diffUsdc.gt(0) 
            ? await getJupiterSwapTx(MINT_A, MINT_B, diffUsdc.toFixed(0))
            : await getJupiterSwapTx(MINT_B, MINT_A, usdtRaw.sub(targetUsdt).toFixed(0));
        if (swapTx) await sendAndConfirm(swapTx);
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function depositLiquidity(poolInfo: ApiV3PoolInfoConcentratedItem, poolKeys: any, tickLower: number, tickUpper: number, isNew: boolean, position?: any) {
    await raydium.account.fetchWalletTokenAccounts();
    const usdcBal = await getTokenBalance(MINT_A);
    const usdtBal = await getTokenBalance(MINT_B);

    if (usdcBal.add(usdtBal).lt(new BN(2_000_000))) return;

    const { R } = await getRatioMath(poolInfo, tickLower, tickUpper);
    
    // Strategy: Use the "scarce" token as base to prevent running out of the "abundant" one.
    // If R < 1, pool wants more USDT than USDC. Use USDC as base.
    // If R > 1, pool wants more USDC than USDT. Use USDT as base.
    const useUsdcAsBase = R.lt(1); 
    const baseAmount = (useUsdcAsBase ? usdcBal : usdtBal).mul(new BN(90)).div(new BN(100));

    console.log(`🚀 ${isNew ? "Opening" : "Top-up"} via ${useUsdcAsBase ? "USDC" : "USDT"} (Ratio: ${R.toFixed(4)})`);

    let result;
    if (isNew) {
        result = await raydium.clmm.openPositionFromBase({
            poolInfo, poolKeys, tickLower, tickUpper, baseAmount, 
            otherAmountMax: useUsdcAsBase ? usdtBal : usdcBal,
            base: useUsdcAsBase ? 'MintA' : 'MintB', ownerInfo: { useSOLBalance: false }, txVersion: TxVersion.LEGACY
        });
    } else {
        // @ts-ignore
        result = await raydium.clmm.increasePositionFromBase({
            poolInfo, ownerPosition: position, baseAmount, 
            otherAmountMax: useUsdcAsBase ? usdtBal : usdcBal,
            base: useUsdcAsBase ? 'MintA' : 'MintB', ownerInfo: { useSOLBalance: false }, txVersion: TxVersion.LEGACY
        });
    }

    const tx = result.transaction as Transaction;
    const validSigners = (result.signers || []).filter(s => s instanceof Keypair);
    if (validSigners.length > 0) tx.sign(...validSigners);
    await sendAndConfirm(tx);
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
        } else {
            if (myPosition.tickLower !== tickLower) {
                console.log("🔁 Out of range, re-ranging...");
                await safeWithdrawAll(myPosition);
            } else {
                const usdc = await getTokenBalance(MINT_A);
                const usdt = await getTokenBalance(MINT_B);
                if (usdc.add(usdt).gt(new BN(5_000_000))) {
                    await rebalanceToRatio(poolInfo, tickLower, tickUpper);
                    await depositLiquidity(poolInfo, poolInfoRaw.poolKeys, tickLower, tickUpper, false, myPosition);
                } else console.log("✅ Position Healthy");
            }
        }
    } catch (e: any) { console.error('Loop Error:', e.message); }
}

async function startBot() {
    await initRaydium();
    while (true) {
        await mainLoop();
        await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
    }
}
startBot();
