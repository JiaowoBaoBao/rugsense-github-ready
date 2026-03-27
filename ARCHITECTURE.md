# Architecture

RugSense is a simulation-first risk decision pipeline with closed-loop verification and reward-driven yield routing.

## High-Level Components

1. **Collector Layer**
   - Launchpad scan + market signal ingestion
   - Reliability controls (retry/backoff/circuit/cache)

2. **Analysis Layer**
   - 3 analysis agents generate risk estimates and votes
   - BTS/debate metadata for explainability

3. **Decision Layer**
   - Vote engine (3 agent votes + 2 user votes)
   - Hard filters (liquidity/slippage/risk)

4. **Execution Layer**
   - `SIM_BUY`: simulated open/monitor/close
   - `NO_TRADE`: delayed verifier

5. **Reward & Yield Layer**
   - On `NO_TRADE + RUG_TRUE` => reward settlement
   - Yield deployment under strict guardrails

6. **Adaptation Layer**
   - Backtest metrics
   - Agent fitness scoring and replacement logic
   - Fraud fingerprint + shadow graph

7. **Presentation Layer**
   - Dashboard (SSE)
   - API endpoints for demo/report/export

## Diagram

- SVG image: `docs/architecture.svg`
- Mermaid source: `docs/architecture.mmd`

## Data Stores (JSON)

`data/*.json` stores persistent simulation state:

- snapshots
- decisions
- positions
- verifications
- rewards
- yield orders
- events
- fitness / memory / fingerprints

> Public repo excludes runtime data files by default (`data/.gitkeep` only).
