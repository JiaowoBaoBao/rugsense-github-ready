# Demo Script (3-5 Minutes)

Use this script for judges, reviewers, or user walkthroughs.

## 0) Pre-demo setup (30s)

```bash
npm install
npm run dev
```

Open dashboard at `http://localhost:3781`.

Say:

> "RugSense is simulation-first. We score risk with multi-agent voting, verify outcomes, and route correct abstention rewards into guardrailed yield allocation."

## 1) Turn on demo mode (20s)

Action:
- Click **Toggle Demo Mode**

Say:

> "Demo mode increases observability and reproducibility for evaluation, while safe mode keeps stricter thresholds."

## 2) Run end-to-end scenario (40s)

Action:
- Click **Run Demo E2E**

Say:

> "This runs candidate selection, voting, verification, reward settlement logic, and yield routing in one sequence."

## 3) Show proof panels (90s)

Highlight, in order:

1. **Latest Decision**
   - final vote outcome
   - hard-filter rationale (if any)
   - data quality badge

2. **Verifications**
   - delayed verdict rows

3. **Reward Events**
   - settled reward records

4. **Yield Agent**
   - allocation mode
   - active status
   - deployed amount and source

5. **KPI Bar**
   - rug catch, safety rate, drawdown, data health, no-trade diagnostics

## 4) Export artifacts (20s)

Action:
- Click **Export Report JSON**
- Click **Export Report MD**

Say:

> "We provide machine-readable and human-readable outputs for independent review."

## 5) Risk and compliance close (20s)

Say:

> "RugSense is a research and simulation framework. It does not provide investment advice or guaranteed returns."

## Optional API-only demo

```bash
curl -s -X POST http://localhost:3781/api/demo-mode -H 'Content-Type: application/json' -d '{"enabled":true}'
curl -s -X POST http://localhost:3781/api/demo/run
curl -s http://localhost:3781/api/report?format=md
```
