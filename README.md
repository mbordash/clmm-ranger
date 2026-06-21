# clmm-ranger

Automated [Raydium CLMM](https://raydium.io/) position re-ranger for Solana, with optional **Ledger hardware wallet** or **hot wallet private key** signing.

The bot monitors a concentrated-liquidity pool and keeps your position in the tightest possible tick range around the current price. When the price drifts out of range it automatically:

1. Withdraws & closes the stale position
2. Rebalances token holdings via [Jupiter](https://jup.ag/) swaps
3. Opens a fresh position centered on the current tick

### ✨ Smart Dust Top-Up

When the position is already in range and centered, the bot checks for any undeposited token dust sitting in the wallet. If the combined value exceeds `DUST_THRESHOLD_USD` (default **$50**), it automatically rebalances the dust to the correct ratio for the existing tick range and calls `increaseLiquidity` — no position close/reopen required. This keeps idle capital working without the overhead of burning and re-minting the position NFT. Raising the threshold avoids spending more in swap/top-up fees than the leftover dust is worth.

Designed for stablecoin pairs (e.g. USDC/USDT) but works with any Raydium CLMM pool.

### 🧯 Storm Protection

During a volatile/depeg episode the price can whipsaw across your band many times in minutes. Without guards, the bot would close + Jupiter-swap + reopen the **whole** position on every crossing — bleeding slippage on each round-trip. Three guards cap that:

1. **Re-range cooldown** — after a re-range, the bot holds for `RERANGE_COOLDOWN_MS` before re-ranging again, *unless* the price has moved `RERANGE_FAR_TICKS` past the band (a genuine trend worth following, not a wiggle to chase).
2. **Volatility circuit-breaker** — if `RERANGE_BURST_LIMIT` re-ranges happen within `RERANGE_BURST_WINDOW_MS`, the bot stops re-ranging entirely for `RERANGE_CIRCUIT_PAUSE_MS` and simply holds the position — it stops swapping capital back and forth into a moving price.
3. **Tighter Jupiter slippage** — normal rebalance swaps quote at `JUPITER_SLIPPAGE_BPS` (default 5 bps) so a high-impact route is refused rather than filled, with a one-shot widen to `JUPITER_SLIPPAGE_FALLBACK_BPS` only if the tight quote can't route.

Single-sided opens (price at/outside the band) are also handled explicitly rather than via an infinity ratio sentinel, which removes a class of `6047/6017` open failures.

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
| `CHECK_INTERVAL_MS` | Poll interval in ms (default `120000`) |
| `POSITION_WIDTH_SPACINGS` | LP width in tick-spacings (default `3`). Wider bands re-range less and swap a smaller fraction per re-range, cutting slippage during volatility. `1` = single-tick max-APR mode |
| `JUPITER_SLIPPAGE_BPS` | Tight slippage cap for normal rebalance swaps (default `5`). High-price-impact routes are refused, not filled |
| `JUPITER_SLIPPAGE_FALLBACK_BPS` | Wider cap used only if the tight quote can't route (default `20`) |
| `RERANGE_COOLDOWN_MS` | After a re-range, wait this long before re-ranging again (default `1200000` = 20 min) unless price runs far past the band |
| `RERANGE_FAR_TICKS` | Ticks past the band edge that override the cooldown — a genuine move worth following (default `3`) |
| `RERANGE_BURST_LIMIT` / `RERANGE_BURST_WINDOW_MS` | Circuit breaker: this many re-ranges within this window trips a pause (defaults `3` / `900000` = 15 min) |
| `RERANGE_CIRCUIT_PAUSE_MS` | How long the circuit breaker holds the position without re-ranging (default `3600000` = 60 min) |
| `DUST_THRESHOLD_USD` | Min leftover wallet value (USD) worth re-depositing; below this the bot stops sweeping (default `50`) |
| `BASE_DEPOSIT_PCT` | Percent of the dominant token deposited per round; the rest is a slippage cushion vs error 6021. Higher = more capital deployed (default `95`; try `99` for stable 1-tick pairs) |
| `REBALANCE_RESIDUAL_USD` | Min wallet imbalance (USD) before firing a Jupiter rebalance swap; below this is "close enough" (default `1.0`) |
| `MIN_SOL_LAMPORTS` | Min wallet SOL (lamports) required to start a re-range; below this the loop skips mutating actions (default `35000000` = 0.035 SOL) |
| `PRIORITY_FEE_MICRO_LAMPORTS` | Priority fee per compute unit applied to every Raydium CLMM tx; set `0` to disable (default `50000`) |
| `COMPUTE_UNIT_LIMIT` | Compute-unit limit paired with the priority fee (default `600000`) |
| `WALLET_PRIVATE_KEY` | **Hot wallet mode** (base58 64-byte secret key). If set, this mode is used |
| `WALLET_ADDRESS` | **Ledger mode** safety check (recommended) |
| `LEDGER_PATH` | **Ledger mode** derivation path (default `44'/501'`) |
| `DISABLE_RAYDIUM_TOKEN_LOAD` | Disable Raydium token-list preload on startup (default `true`) |

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

## Docker

Container mode is best for **hot wallet mode** (`WALLET_PRIVATE_KEY`).

Ledger mode usually needs USB passthrough and device permissions, which are not included in the default container setup below.

Build and run locally:

```bash
docker build -t clmm-ranger:latest .
docker run --rm --name clmm-ranger --env-file .env clmm-ranger:latest
```

## Deploy To AWS Host

This repo includes `deploy.sh.example`, which:

1. Syncs the project to your server
2. Uploads your local `.env`
3. Builds the Docker image on the server
4. Recreates and starts the container with restart policy

Default target is:

- `ubuntu@52.211.208.155`
- key: `~/.ssh/rustpolybot-ireland-key-2026.pem`

Create your local deploy script from the template:

```bash
cp deploy.sh.example deploy.sh
chmod +x deploy.sh
```

Then run deploy:

```bash
./deploy.sh
```

Useful overrides:

```bash
SSH_HOST=52.211.208.155 SSH_USER=ubuntu ./deploy.sh
```

`deploy.sh` is intentionally gitignored so each developer can keep their own host/key defaults.

Follow logs on server:

```bash
ssh -i ~/.ssh/rustpolybot-ireland-key-2026.pem ubuntu@52.211.208.155 'docker logs -f clmm-ranger'
```

### Startup Log Noise (ENOTFOUND tokens.jup.ag)

If your server DNS/egress blocks `tokens.jup.ag`, Raydium SDK can print a large Axios stack trace during startup token preload. The bot can still run, but logs become noisy.

By default this repo sets `DISABLE_RAYDIUM_TOKEN_LOAD=true`, which skips that preload and avoids the startup stack dump.

The bot will:
- Use hot wallet signing when `WALLET_PRIVATE_KEY` is present; otherwise use Ledger signing
- Check for an existing CLMM position
- Re-range if the position is stale or out of range
- Prompt for Ledger confirmation only when running in Ledger mode

## How It Works

- Uses the **Raydium SDK v2** for CLMM position management
- Uses the **Jupiter Swap API** for token rebalancing
- Computes the mathematically optimal token ratio using the concentrated-liquidity formula
- Iteratively swaps until the residual imbalance is below `REBALANCE_RESIDUAL_USD`
- Tops up existing in-range positions with idle wallet dust via `increaseLiquidity` (no re-open needed)
- Reclaims locked rent (~0.0055 SOL each) from any empty position NFTs left behind by a previously failed close
- Applies a configurable priority fee / compute budget to every CLMM tx so the close→open pipeline lands atomically and doesn't strand orphaned positions
- Skips re-ranging when wallet SOL drops below `MIN_SOL_LAMPORTS`, avoiding a half-open position after running out of gas mid-cycle
- Includes workarounds for Raydium SDK bugs (reward account derivation, Token-2022 NFT ATA patching)

## ⚠️ Disclaimer

This software is provided as-is. Use at your own risk. The authors are not responsible for any financial losses.

- In Ledger mode, always verify transaction details on-device before confirming.
- In hot wallet mode, protect `.env` carefully and never commit or share `WALLET_PRIVATE_KEY`.

## License

[GPL-3.0](LICENSE)
