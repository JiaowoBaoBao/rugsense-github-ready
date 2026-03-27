# RugSense AI: The Sixth Sense of Solana
## A Self-Evolving Risk Firewall with Counterfactual Reward Loops

---

## Problem Statement

In the Solana ecosystem, meme tokens are launched at extreme speed, with short lifecycles and high information noise. Without a systematic risk-control framework, users are highly exposed to rug risk due to momentum chasing, FOMO (fear of missing out), and emotion-driven decisions.

Traditional single-factor methods that “only look at price volatility” struggle to detect **structural risk** (e.g., liquidity withdrawal, holder-structure imbalance, suspicious fund relationships), and are even less capable of quantifying the strategic value of **not trading** (Counterfactual Value).

---

## Our Approach

RugSense uses **multi-agent collaborative decision-making**, a **BTS peer-probability feedback mechanism**, and an **evolutionary scoring-and-replacement loop** to perform multidimensional risk assessment for newly launched tokens. It also builds **Fraud Fingerprints** from historical behavior patterns to continuously improve rug detection.

The system validates outcomes under both `SIM_BUY` and `NO_TRADE` paths. When `NO_TRADE` correctly flags high risk, it triggers a constrained yield strategy, forming a closed loop:

**Risk Identification → Outcome Verification → Yield Reallocation**

> Plain-language summary: RugSense not only decides whether to buy, but also verifies whether “not buying” was the right choice—and converts that correct decision into auditable, conservative yield actions.

### Technical Stack
- **Execution**: Bitget Wallet Skills (Security, Quote, Staking)
- **Automation**: OpenClaw for real-time web-level forensic scraping

---

## Core Value

RugSense not only helps users reduce rug exposure, but also makes the hidden cost of blind trading explicit.
Opportunity cost is not just potential principal loss—it also includes stable yield that could have been earned instead.

---

## 1. Version Definition

### Core Mechanisms
1. **Voting Decision (5-vote system)**: 1 vote each from 3 analysis agents + 2 votes from the user; majority wins.
2. **Risk Agent Role**: Responsible for aggregation, execution, monitoring, and post-analysis.
3. **Dual-Path Closed Loop**:
   - **Path A (Vote to Buy)**: Enter simulated trading loop.
   - **Path B (Vote Not to Buy)**: Verify after 15 minutes; if rug is confirmed, trigger reward payment and pass funds to the Yield Agent under constraints.
4. **Automated Yield Agent Execution**: Must be constrained by “allowlist + position limits + hard guardrails.”
5. **Evolution of 3 Analysis Agents**: Continuous scoring, replacement, and iteration (continuous learning without breaching safety boundaries).

---

## 2. System Architecture (Modules)

1. **Data Collector (Scheduled Ingestion)**
   - Source: Bitget skill (market data, candlesticks, liquidity, security, trading behavior)
   - Interval: default every 5 minutes (configurable)

2. **Feature Store / Historian DB (Historical Database)**
   - Stores snapshots, votes, decisions, verifications, rewards, yield actions, and evolution data (supports replay and auditing)

3. **Three Analysis Agents**
   - TechGuard / OnChainWhale / SentimentHunter
   - Output: `p5/p10/p15 + confidence + vote + reason`

4. **Vote Engine**
   - Aggregates 3 agent votes + 2 user votes
   - Output: `SIM_BUY` or `NO_TRADE`

5. **Risk Agent (Aggregation & Orchestration)**
   - Produces weighted risk conclusions
   - Triggers simulated open/close actions
   - Schedules 15-minute verification
   - Triggers reward payment in Path B

6. **Sim Execution Engine (Simulated Position Engine)**
   - Records simulated fills, positions, unrealized/realized PnL, drawdown, fees, and slippage estimates
   - Automatically closes simulated positions when exit conditions are met

7. **15m Verifier (Verification Engine)**
   - Looks back at the 15-minute outcome and classifies as `RUG_TRUE / RUG_FALSE`

8. **Yield Agent (Yield Execution Agent)**
   - Executes yield actions within allowlist and guardrails
   - Supports real-time product sources with fallback
   - Full-process auditing

9. **Evolution Engine**
   - Periodically evaluates three agents for elimination/replacement/promotion

10. **Dashboard (Real-Time Panel)**
   - Displays votes, simulated positions, exit reasons, reward payouts, yield status, agent rankings, and event stream

---

## 3. Core Business Flow (State Machine)

### S0: Data Ingestion
Periodically pull token universe + key features into storage.

### S1: Analysis Request (On-demand / Auto)
User-specified token or auto-selected candidates; three agents produce outputs in parallel.

### S2: Voting Decision
- 5 total votes; if `BUY >= 3` => `SIM_BUY`
- Otherwise => `NO_TRADE`

### S3A: Simulated Buy Path (Path A)
- Open position using simulated execution model (with slippage/fees)
- Enter real-time monitoring
- Triggered by stop-loss / take-profit / timeout / risk event => auto simulated close

### S3B: No-Trade Path (Path B)
- Schedule 15-minute verification task
- If `verify_15m == RUG_TRUE`, trigger reward payout to Yield Agent
- Yield Agent executes constrained yield action and writes back audit logs

### S4: Post-Analysis Scoring
- Write prediction accuracy, calibration, stability, and BTS-related metrics
- Enter evolution queue

---

## 4. Voting and Decision Rules (Locked)

### 4.1 Voting Rules
- Agent votes: 1 vote each (`BUY / NO_BUY`)
- User votes: 2 votes (can be 2 BUY, 2 NO_BUY, or split)
- Decision threshold: `BUY >= 3`

### 4.2 User No-Vote Handling
- Default safety policy: both user votes are set to `NO_BUY`

### 4.3 Pre-Vote Hard Filters (System Rules)
If any condition is hit, force `NO_TRADE`:
- Security risk too high
- Liquidity below threshold
- Estimated slippage too high
- Insufficient market depth

---

## 5. 15-Minute Rug Classification Criteria

### Hard Rug (any one condition is sufficient)
- Significant liquidity collapse/withdrawal
- Risk score jumps into the high-risk zone
- Resonance of extreme abnormal behavior with price cliff

### Soft Rug (combined conditions)
- Significant drop within 15 minutes (configurable threshold policy)
- Concurrent liquidity deterioration or abnormal sell-pressure imbalance

### Output
- `RUG_TRUE | RUG_FALSE` (current implementation is primarily binary for automation)

---

## 6. Constrained Autonomy for Yield Agent (Hard-Coded Guardrails)

### 6.1 Allowlist (Required)
Allowed only:
- Mainstream stable lending pools (e.g., Aave / Compound)
- Mainstream staking protocols (e.g., Lido)
- Low-volatility stable pools (e.g., USDC-USDT)

Prohibited:
- Leverage, meme assets, derivatives, high-risk farms, unknown protocols

### 6.2 Position Limits (Required)
- Per order `<= 2%~5%` of total capital (default 3%)
- Daily new risk exposure `<= 10%`
- Single-protocol exposure `<= 20%`

### 6.3 Yield Rules
- Minimum APY threshold `> 3%`
- If unmet, remain in USDC (no forced risk-taking for yield)

### 6.4 Risk Exit Rules (Required)
- Exit on sudden TVL drop
- Exit on risk score jump
- Exit on abnormal volatility

### 6.5 Circuit Breaker
- If `KILL_SWITCH` is ON: no new entries; only exits are allowed

---

## 7. Reward Payment Rules (Path B)

### Trigger Conditions (all must be met)
1. `decision == NO_TRADE`
2. `verify_15m == RUG_TRUE`
3. `reward_paid == false`
4. Within daily budget and token cooldown limits

### Reward Amount Design (Anti-Incentive-Distortion)
- Default reward amount: **0.001 USDC**
- Purpose: validate the loop of “correct decision → auto settlement → auditable trace,” not maximize reward yield
- Rationale: if rewards are too high, policy may become overly conservative to farm rewards (incentive distortion)

### Settlement Paths (Dual Path)
- **Path A (Simplified)**: Direct transfer via **Bitget wallet skill** (lower complexity)
- **Path B (Standardized)**: **x402 verify/settle** flow (scalable and standard-compliant)

### Additional Constraints
- Daily reward cap (e.g., 30 times/day)
- Max one reward per token in 24 hours

---

## 8. Enhanced Agent Decision Process

### 8.1 BTS-lite (Peer Prediction)
Each agent not only votes, but also predicts peer buy probability:
- `peerBuyProb / peerNoBuyProb / expectedPeerVote`
- System outputs peer mean, disagreement level, and leading contrarian agent

### 8.2 Debate/Battle (Structured Challenge)
- Each agent receives challenges from dissenting agents and provides rebuttals
- Current implementation uses a structured single-round `challenge + rebuttal` (not infinite debate)

### 8.3 Structured Decision Explainability
Outputs include:
- `evidenceWeights` (risk/liquidity/momentum/flow)
- `conflicts` (vote splits / hard-filter overrides)
- BTS summary + debate summary

---

## 9. Fraud Fingerprints + Shadow Graph

### 9.1 Fraud Fingerprint
Each verified sample generates:
- `fingerprintId`
- `instructionSequence`
- `taxonomy(H/L/M/S)`
- `fingerprintScore`
- `similarCases`

> Note: `fingerprintId` is a pattern ID, not a unique event ID. Repetition indicates pattern recurrence and is expected.

### 9.2 Shadow Entity Graph
- Infer creator/funder entity relationships
- Build `funder -> creator` network
- Output high-risk lineages, suspicious clusters, and incident lists

---

## 10. Agent Elimination & Evolution (3 Analysis Agents)

### 10.1 Evaluation Cadence
- Runs periodically (scheduler-driven in the current system)

### 10.2 Scoring Function (Current)
`Fitness = 0.34*(1-Brier) + 0.20*DirectionAcc + 0.16*Calibration + 0.08*Stability + 0.10*BTSAccuracy + 0.12*ContrarianRate`

### 10.3 Elimination/Replacement Triggers
- Weakest agent reaches minimum sample count
- Falls below fitness threshold
- Gap versus best agent exceeds threshold
- On trigger, replace at `generation+1`

### 10.4 Evolution Scope
- Allowed: reasoning strategy, feature weighting, threshold refinement
- Forbidden: bypassing safety guardrails, allowlists, or capital hard limits

---

## 11. OpenClaw + Bitget Skill Implementation Checklist

### 11.1 Orchestration Recommendations
- collector: every 5 minutes
- auto analyze: every 5 minutes (shorter internal ticks allowed)
- verification: 15-minute delay after event trigger
- evolution: periodic task
- daily report: daily task

### 11.2 Bitget Skill Calls
- Pre-analysis: security / liquidity / market info / kline / tx info
- Price anchoring: quote (simulation only, no live order placement)

---

## 12. Minimal Data Tables (Recommended)

1. snapshots
2. agent_outputs / agent_votes
3. vote_decisions
4. sim_positions
5. verify_results
6. x402_rewards
7. yield_orders
8. agent_fitness
9. fraud_fingerprints
10. shadow_entity_graph

---

## 13. Default Parameters (v1)

- `STOP_LOSS = -8%`
- `TAKE_PROFIT = +12%`
- `MAX_HOLD = 6h`
- `MAX_ORDER_PCT = 3%`
- `MIN_APY = 3%`
- `TVL_DROP_EXIT = 20%/1h`
- `RUG_SOFT_DROP = 35%/15m`
- `VOTE_TIMEOUT = 120s` (or default safe-vote policy per implementation)

---

## 14. GitHub Deliverables (Condensed)

### 14.1 Core Deliverables
- `README.md`
- `src/`
- `config/config.example.json`
- `docs/architecture.mmd`, `docs/architecture.svg`
- `public/` (`index.html`, `app.js`, `style.css`)
- `package.json`, `.env.example`

### 14.2 High-Value Supporting Artifacts (Included)
- `SECURITY.md`
- `QUICKSTART.md`
- `REPRODUCIBILITY.md`
- `DEMO_SCRIPT.md` + `scripts/demo.sh`
- `TROUBLESHOOTING.md`

---

## 15. Reality Check (Implementation Notes)

1. The main trading path is simulation-first (no live order execution by default; capital safety first).
2. Debate is a structured single-round mechanism, not an open-ended infinite game.
3. Fingerprint ID is a pattern identifier, not a unique event primary key.
4. If real-time yield sources are unavailable, the system falls back to a static allowlist.
5. The payment pipeline supports both simplified and standardized paths, enabled by environment configuration.

---

## 16. Compliance & Disclaimer

RugSense (including code, documentation, model configurations, and visualization outputs) is intended solely for research, testing, method validation, and technical demonstration.

RugSense is not a broker, exchange, investment advisor, asset manager, custodian, or financial intermediary; it does not provide order matching, fiduciary execution, guaranteed returns, or any regulated financial services.

System outputs (including risk scores, rankings, voting decisions, fingerprint results, strategy suggestions, and simulation results) are technical artifacts only and do not constitute investment advice, legal/tax advice, solicitation, offering, or return guarantees.

The system runs in paper mode by default. If users independently enable live wallets, real assets, or on-chain execution, all behavior and risk are borne solely by the user.

Users are responsible for ensuring their usage complies with applicable laws and regulations in their jurisdiction, including licensing requirements, sanctions rules, tax obligations, and platform terms.

To the maximum extent permitted by law, RugSense is provided “as is” and “as available,” without any express or implied warranties, including but not limited to availability, continuity, accuracy, merchantability, fitness for a particular purpose, and non-infringement.

Project maintainers reserve the right to modify, limit, suspend, or terminate any function at any time without prior notice.
