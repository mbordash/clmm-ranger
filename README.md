# clmm-ranger

Automated [Raydium CLMM](https://raydium.io/) position re-ranger for Solana, with **Ledger hardware wallet** signing.

The bot monitors a concentrated-liquidity pool and keeps your position in the tightest possible tick range around the current price. When the price drifts out of range it automatically:

1. Withdraws & closes the stale position
2. Rebalances token holdings via [Jupiter](https://jup.ag/) swaps
3. Opens a fresh position centered on the current tick

Designed for stablecoin pairs (e.g. USDC/USDT) but works with any Raydium CLMM pool.

## Requirements

- **Node.js** ≥ 18
- **Ledger** hardware wallet connected via USB with the Solana app open
- A Solana RPC endpoint (e.g. [Helius](https://helius.dev/), [Triton](https://triton.one/))

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/clmm-ranger.git
cd clmm-ranger
npm install
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Description |
|---|---|
| `RPC_URL` | Solana RPC endpoint (with API key) |
| `WALLET_ADDRESS` | Your Solana wallet address (must match Ledger) |
| `POOL_ID` | Raydium CLMM pool to manage |
| `MINT_A` / `MINT_B` | Token mints (defaults to USDC/USDT) |
| `LEDGER_PATH` | Ledger derivation path (default `44'/501'`) |
| `CHECK_INTERVAL_MS` | Poll interval in ms (default `60000`) |
| `REBALANCE_RESIDUAL_USD` | Max residual imbalance in USD before stopping swaps (default `1.0`) |
| `MIN_SOL_LAMPORTS` | Minimum SOL to keep for rent (default `35000000`) |

## Usage

```bash
npm start
```

The bot will:
- Connect to your Ledger and verify the wallet address
- Check for an existing CLMM position
- Re-range if the position is stale or out of range
- Prompt you to confirm each transaction on the Ledger

## How It Works

- Uses the **Raydium SDK v2** for pool state reads, tick math, and base transaction building
- Uses the **Jupiter Swap API** for token rebalancing
- Computes the mathematically optimal token ratio using the concentrated-liquidity formula (Q64 sqrtPrice math with 80-digit Decimal.js precision)
- Iteratively swaps until the residual imbalance is below the configured threshold
- All transactions use `TxVersion.LEGACY` for Ledger compatibility (Ledger cannot sign V0/versioned transactions)

## Raydium SDK Workarounds

This bot uses the Raydium SDK selectively. The SDK is helpful for **reading pool state** (`getPoolInfoFromRpc`, `getOwnerPositionInfo`) and **tick math** (`TickUtils.getTickPrice`), but its transaction building has several issues that required manual patching:

| Issue | SDK Bug | Our Fix |
|---|---|---|
| **Versioned transactions** | SDK defaults to `TxVersion.V0` which Ledger can't sign | Force `TxVersion.LEGACY` on all calls |
| **Missing NFT signer** | `openPositionFromBase` returns `{ transaction, signers }` but the SDK's own `execute()` is the only path that applies the ephemeral NFT mint keypair signature | Destructure `signers`, call `tx.sign(...signers)` before Ledger signs |
| **Empty reward accounts** | `clmmComputeInfoToApiInfo()` hardcodes `rewardDefaultInfos: []`, causing `InvalidRewardInputAccountNumber` (6035) on pools with rewards | Populate from `poolKeys.rewardInfos` manually |
| **Wrong NFT ATA** | SDK hardcodes `TOKEN_PROGRAM_ID` when deriving the position NFT's ATA; fails for Token-2022 NFTs | Detect actual token program, patch instruction account keys |
| **Stale token cache** | After Jupiter swaps, the SDK's cached token accounts are stale | Call `fetchWalletTokenAccounts()` before building deposit tx |
| **poolKeys not passed** | `openPositionFromBase` re-fetches pool keys via API if not provided, which can fail | Capture from `getPoolInfoFromRpc` and pass directly |
| **Q64 precision overflow** | Default Decimal.js precision (20 digits) is insufficient for sqrtPriceX64 math (~57 digits needed) | Set `Decimal.precision = 80` |

If you're building your own CLMM bot, we recommend using the SDK only for reads and math, then handling transaction construction, signing, and submission yourself.

## ⚠️ Disclaimer

This software is provided as-is. Use at your own risk. The authors are not responsible for any financial losses. Always verify transactions on your Ledger before confirming.

## License

[GPL-3.0](LICENSE)

