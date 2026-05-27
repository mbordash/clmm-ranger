# clmm-ranger

Automated [Raydium CLMM](https://raydium.io/) position re-ranger for Solana, with optional **Ledger hardware wallet** or **hot wallet private key** signing.

The bot monitors a concentrated-liquidity pool and keeps your position in the tightest possible tick range around the current price. When the price drifts out of range it automatically:

1. Withdraws & closes the stale position
2. Rebalances token holdings via [Jupiter](https://jup.ag/) swaps
3. Opens a fresh position centered on the current tick

### ✨ Smart Dust Top-Up

When the position is already in range and centered, the bot checks for any undeposited token dust sitting in the wallet. If the combined value exceeds **$5**, it automatically rebalances the dust to the correct ratio for the existing tick range and calls `increaseLiquidity` — no position close/reopen required. This keeps idle capital working without the overhead of burning and re-minting the position NFT.

Designed for stablecoin pairs (e.g. USDC/USDT) but works with any Raydium CLMM pool.

## Requirements

- **Node.js** ≥ 18
- A Solana RPC endpoint (e.g. [Helius](https://helius.dev/), [Triton](https://triton.one/))
- One signing mode:
  - **Ledger mode**: Ledger connected via USB with the Solana app open
  - **Hot wallet mode**: base58 private key in env (`WALLET_PRIVATE_KEY`)

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
| `POOL_ID` | Raydium CLMM pool to manage |
| `MINT_A` / `MINT_B` | Token mints (defaults to USDC/USDT) |
| `CHECK_INTERVAL_MS` | Poll interval in ms |
| `WALLET_PRIVATE_KEY` | **Hot wallet mode** (base58 64-byte secret key). If set, this mode is used |
| `WALLET_ADDRESS` | **Ledger mode** safety check (recommended) |
| `LEDGER_PATH` | **Ledger mode** derivation path (default `44'/501'`) |

### Wallet Mode Switching

The bot auto-selects signing mode using this rule:

1. If `WALLET_PRIVATE_KEY` is set -> **hot wallet mode**
2. If `WALLET_PRIVATE_KEY` is empty/unset -> **Ledger mode**

Use one of these `.env` snippets:

**Ledger mode**

```dotenv
# Leave hot key unset/commented
# WALLET_PRIVATE_KEY=

WALLET_ADDRESS=YourLedgerPubkey
LEDGER_PATH=44'/501'
```

**Hot wallet mode**

```dotenv
WALLET_PRIVATE_KEY=YourBase58SecretKey
# Optional in hot-wallet mode:
# WALLET_ADDRESS=YourPubkey
```

## Usage

```bash
npm start
```

The bot will:
- Use hot wallet signing when `WALLET_PRIVATE_KEY` is present; otherwise use Ledger signing
- Check for an existing CLMM position
- Re-range if the position is stale or out of range
- Prompt for Ledger confirmation only when running in Ledger mode

## How It Works

- Uses the **Raydium SDK v2** for CLMM position management
- Uses the **Jupiter Swap API** for token rebalancing
- Computes the mathematically optimal token ratio using the concentrated-liquidity formula
- Iteratively swaps until the residual imbalance is below the configured threshold
- Tops up existing in-range positions with idle wallet dust via `increaseLiquidity` (no re-open needed)
- Includes workarounds for Raydium SDK bugs (reward account derivation, Token-2022 NFT ATA patching)

## ⚠️ Disclaimer

This software is provided as-is. Use at your own risk. The authors are not responsible for any financial losses.

- In Ledger mode, always verify transaction details on-device before confirming.
- In hot wallet mode, protect `.env` carefully and never commit or share `WALLET_PRIVATE_KEY`.

## License

[GPL-3.0](LICENSE)
