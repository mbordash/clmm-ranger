# clmm-ranger

Automated [Raydium CLMM](https://raydium.io/) position re-ranger for Solana, with **Ledger hardware wallet** signing.

The bot monitors a concentrated-liquidity pool and keeps your position in the tightest possible tick range around the current price. When the price drifts out of range it automatically:

1. Withdraws & closes the stale position
2. Rebalances token holdings via [Jupiter](https://jup.ag/) swaps
3. Opens a fresh position centered on the current tick

### ✨ Smart Dust Top-Up

When the position is already in range and centered, the bot checks for any undeposited token dust sitting in the wallet. If the combined value exceeds **$5**, it automatically rebalances the dust to the correct ratio for the existing tick range and calls `increaseLiquidity` — no position close/reopen required. This keeps idle capital working without the overhead of burning and re-minting the position NFT.

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

- Uses the **Raydium SDK v2** for CLMM position management
- Uses the **Jupiter Swap API** for token rebalancing
- Computes the mathematically optimal token ratio using the concentrated-liquidity formula
- Iteratively swaps until the residual imbalance is below the configured threshold
- Tops up existing in-range positions with idle wallet dust via `increaseLiquidity` (no re-open needed)
- Includes workarounds for Raydium SDK bugs (reward account derivation, Token-2022 NFT ATA patching)

## ⚠️ Disclaimer

This software is provided as-is. Use at your own risk. The authors are not responsible for any financial losses. Always verify transactions on your Ledger before confirming.

## License

[GPL-3.0](LICENSE)

