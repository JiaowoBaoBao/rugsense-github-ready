# RugSense v3.1

![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![Last Commit](https://img.shields.io/github/last-commit/JiaowoBaoBao/rugsense-github-ready)
![License](https://img.shields.io/badge/license-not%20specified-lightgrey)

RugSense v3.1 is a runnable MVP implementing your latest design:

- **3 analysis agents** (TechGuard / OnChainWhale / SentimentHunter)
- **Voting engine** (3 agent votes + 2 user votes, majority decides)
- **Risk Agent aggregation/execution** (no veto)
- **Dual path**
  - `SIM_BUY` => open simulated position, monitor, auto-close on risk rules
  - `NO_TRADE` + 15m `RUG_TRUE` => x402 real on-chain payment (`0.001 USDC`) via Bitget skill, then trigger Yield Agent flow
- **Yield Agent constrained autonomy** with hardcoded guardrails
- **Evolution engine** for analysis-agent scoring and replacement suggestion
- **Visual dashboard** with interaction and live state updates (SSE)

---

## Project Documents

- Full proposal (EN): [`RUGSENSE_PROPOSAL_EN.md`](./RUGSENSE_PROPOSAL_EN.md)

---

## 1) Quick Start

```bash
cd <repo-folder>
npm install
npm run dev
```

Open: `http://localhost:3781`

For a faster reviewer path, see:
- [`QUICKSTART.md`](./QUICKSTART.md)
- [`REPRODUCIBILITY.md`](./REPRODUCIBILITY.md)
- [`DEMO_SCRIPT.md`](./DEMO_SCRIPT.md)

### x402 Real-Chain Setup (Bitget skill)

Reward settlement calls `../skills/bitget-wallet/scripts/x402_pay.py`.

For EVM x402:

```bash
# Option A: use private key file (recommended)
export RUGSENSE_X402_PRIVATE_KEY_FILE=/absolute/path/to/evm_private_key.txt

# Option B: direct env private key
export RUGSENSE_X402_PRIVATE_KEY=0x...
```

For Solana x402 (when `reward.x402.network=solana:...`):

```bash
# Option A: file containing 32-byte Solana private key hex seed
export RUGSENSE_X402_PRIVATE_KEY_FILE_SOL=/absolute/path/to/sol_private_key_hex.txt

# Option B: direct env
export RUGSENSE_X402_PRIVATE_KEY_SOL=<32-byte-hex-seed>
```

Optional overrides:

```bash
export RUGSENSE_X402_PAY_URL="http://localhost:3781/api/x402/reward"
export RUGSENSE_X402_CHAIN_ID=8453
export RUGSENSE_X402_TIMEOUT_MS=60000
```

### Direct transfer mode (no x402)

If you want wallet1 -> wallet2 transfer without x402 challenge/settle, set:

```json
{
  "reward": {
    "paymentMode": "DIRECT_TRANSFER",
    "directTransfer": {
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "toAddress": "0x...wallet2",
      "useKeychain": true,
      "dryRun": true
    }
  }
}
```

- `dryRun=true`: no on-chain tx, only simulated receipt (safe validation)
- `dryRun=false`: sends real on-chain transfer (wallet1 must have token balance + gas)

### Self-hosted x402 receiver (wallet2 as payee)

RugSense exposes `POST /api/x402/reward` as a minimal x402 receiver.
You can let wallet1 pay and wallet2 receive by configuring wallet2 as `reward.x402.payTo`.

Config keys (in `reward.x402`):
- `internalEndpoint`: `http://localhost:3781/api/x402/reward`
- `network`: `eip155:8453` or `solana:mainnet`
- `payTo`: receiver address (EVM or Solana)
- `asset`: Base USDC (EVM) or Solana USDC mint
- `verifyMode`: `mock` (default) or `strict`（CDP facilitator verify + settle）
- `security.*`: receiver authentication (token)
- `rateLimit.*`: receiver rate limiting
- `idempotency.*`: idempotency protection against duplicate payment signatures
- `facilitator.*`: verify/settle endpoints and auth settings for strict mode

To use local self-hosted receiving for Solana reward payment, set:

```json
{
  "reward": {
    "x402": {
      "url": "http://localhost:3781/api/x402/reward",
      "network": "solana:mainnet",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "<wallet2_solana_address>",
      "payerPublicKey": "<wallet1_solana_address>",
      "verifyMode": "mock",
      "security": {
        "requireAuth": true,
        "authHeader": "x-rugsense-token"
      },
      "rateLimit": {
        "enabled": true,
        "windowMs": 60000,
        "max": 60
      },
      "idempotency": {
        "enabled": true,
        "ttlMs": 86400000
      }
    }
  }
}
```

Enable strict settle (CDP facilitator):

```json
{
  "reward": {
    "x402": {
      "verifyMode": "strict",
      "facilitator": {
        "baseUrl": "https://api.cdp.coinbase.com/platform/v2/x402",
        "verifyPath": "/verify",
        "settlePath": "/settle",
        "authMode": "bearer",
        "apiKeyEnv": "CDP_API_KEY"
      }
    }
  }
}
```

> Solana strict mode also requires a signable `accepts[0].extra.serializedTransaction` in the challenge (provided by an upstream x402 service/middleware).

```bash
# required for strict mode
export CDP_API_KEY=your_cdp_api_key
# optional when facilitator authMode=headers
export CDP_API_SECRET=your_cdp_api_secret
# optional receiver token (when security.requireAuth=true)
export RUGSENSE_X402_RECEIVER_TOKEN=your_receiver_token
```

Quick smoke test:

```bash
# 1) Should return 402 + payment-required
# (if auth enabled: add -H "x-rugsense-token: $RUGSENSE_X402_RECEIVER_TOKEN")
curl -i -X POST http://localhost:3781/api/x402/reward

# 2) EVM branch: pay through Bitget x402 client
python3 ../skills/bitget-wallet/scripts/x402_pay.py pay \
  --url "http://localhost:3781/api/x402/reward" \
  --private-key-file /absolute/path/to/wallet1_evm_private_key.txt \
  --method POST \
  --auto

# 3) Solana mock branch: replay accepted requirement as PAYMENT-SIGNATURE
PR=$(curl -s -D - -o /dev/null -X POST http://localhost:3781/api/x402/reward | awk 'BEGIN{IGNORECASE=1} /^payment-required:/ {sub(/^[^:]*:[[:space:]]*/,"",$0); gsub(/\r/,"",$0); print; exit}')
PS=$(HDR="$PR" python3 - <<'PY'
import os, json, base64
req=json.loads(base64.b64decode(os.environ['HDR']))['accepts'][0]
p={"x402Version":2,"accepted":req,"payload":{"publicKey":"<wallet1_solana_address>","mock":True}}
print(base64.b64encode(json.dumps(p).encode()).decode())
PY
)
curl -i -X POST http://localhost:3781/api/x402/reward -H "PAYMENT-SIGNATURE: $PS"
```

---

## 2) Dashboard Sections

1. SOL launchpad new pool scanner (Bitget) with simple filters (limit/age/liquidity/risk/keyword)
2. Control panel (token + user 2 votes + order%)
3. Latest analysis and vote decision
4. Simulated open/closed positions (live PnL)
5. 15m verification + x402 reward events
6. Yield agent status and guardrail-constrained allocations
7. Agent fitness + evolution ranking
8. System event stream

---

## 3) API Endpoints

- `POST /api/analyze-and-vote`
- `GET /api/state`
- `GET /api/positions`
- `GET /api/events`
- `GET /api/launchpad-sol` (SOL launchpad scanner, with query filters)
- `POST /api/config`
- `POST /api/kill-switch`
- `POST /api/run-verification/:decisionId`
- `POST /api/run-evolution`
- `POST /api/x402/reward` (self-hosted x402 receiver)
- `GET /api/stream` (SSE)
- `GET /api/health`

### Example `POST /api/analyze-and-vote`

```json
{
  "token": "BONK",
  "chain": "sol",
  "orderPct": 2,
  "userVotes": ["BUY", "NO_BUY"]
}
```

---

## 4) Core Rules (Implemented)

### Voting
- Total 5 votes
- `BUY >= 3` => `SIM_BUY`, otherwise `NO_TRADE`

### 15m Verification (demo toggle)
- Configurable delay (`runtime.verificationDelayMs`)
- In demo mode default is 30s

### x402 Reward Trigger
Must satisfy all:
1. decision is `NO_TRADE`
2. verification verdict is `RUG_TRUE`
3. reward not paid for same decision
4. daily cap + token cooldown pass

### Yield Agent Guardrails
- Whitelist categories only (`stable_lending`, `major_staking`, `low_vol_stable_pool`)
- Forbidden: leverage/meme/derivatives/high-risk-farm
- Single-order cap
- Daily new-exposure cap
- Per-protocol exposure cap
- Minimum APY threshold
- Risk exits for TVL drop / risk jump
- Kill switch support

---

## 5) Data Persistence

Local JSON files in `./data/`:

- `snapshots.json`
- `agent_outputs.json`
- `vote_decisions.json`
- `sim_positions.json`
- `verify_results.json`
- `x402_rewards.json`
- `yield_orders.json`
- `agent_fitness.json`
- `events.json`
- `runtime.json`
- `config.json`

---

## 6) Bitget Integration

`src/services/bitgetClient.js` uses signed requests:

- signature = `sha256(Method + Path + Body + Timestamp)` with `0x` prefix
- required headers include `channel/brand/clientversion/language/token/X-SIGN/X-TIMESTAMP`

Wrapped market calls:
- `coin-market-info`
- `kline`
- `tx-info`
- `liquidity`
- `security`
- `quote` (fallback utility)

If upstream API fails, it automatically falls back to **synthetic degraded mode**, surfaced in dashboard status.

---

## 7) Demo Tips

- Keep `runtime.verificationDelayMs = 30000` to quickly demo NO_TRADE -> RUG_TRUE -> x402 -> Yield flow.
- Use `Run Evolution` button after generating a few verified samples.
- Toggle kill switch to test yield execution halt.

---

## 8) Known Limitations

- Trading is still simulation-level in this MVP.
- x402 reward path is wired to real on-chain settlement via Bitget skill (`scripts/x402_pay.py`) when private key config is provided.
- Direct transfer mode currently supports EVM path in this build (Solana direct transfer not yet implemented here).
- Real protocol execution adapters are not wired to wallets in this build.
- Rug verification is deterministic heuristic, not a production classifier.
