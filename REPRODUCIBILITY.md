# Reproducibility Guide

This document defines a deterministic review path for technical evaluation.

## Scope

- Goal: reproduce decision -> verification -> reward -> yield flow
- Mode: `DEMO MODE`
- Chain focus: Solana candidate scanning (simulation execution)

## Environment Baseline

```bash
npm install
npm run dev
```

Confirm:

```bash
curl -s http://localhost:3781/api/health
```

Expected: `{"ok": true, ...}`

## Repro Steps (Reviewer Path)

### Step 1 — Enable demo mode

```bash
curl -s -X POST http://localhost:3781/api/demo-mode \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

Expected:

- `mode: "demo"`
- higher SOL slippage cap than safe mode
- demo allocation mode enabled for yield

### Step 2 — Run E2E demo

```bash
curl -s -X POST http://localhost:3781/api/demo/run
```

Expected:

- `ok: true`
- `attempts` array exists
- `selected` object exists (decision + verify result)

### Step 3 — Verify state output

```bash
curl -s http://localhost:3781/api/state
```

Check key sections:

- `kpis`
- `noTradeReasonSummary`
- `verifyResults` (latest)
- `rewards` (latest)
- `yieldOrders` (latest)

### Step 4 — Export report artifacts

```bash
curl -s http://localhost:3781/api/report?format=json > demo-report.json
curl -s http://localhost:3781/api/report?format=md > demo-report.md
```

## Acceptance Criteria

A run is considered successfully reproduced when:

1. Server health is `ok=true`
2. Demo mode can be toggled via API
3. `/api/demo/run` returns `ok=true` with a non-empty `attempts` list
4. `/api/report` exports JSON and Markdown successfully

## Non-Determinism Note

Launchpad data and external market endpoints are time-dependent.
Therefore:

- exact token symbols/contracts may vary by run
- exact verdict mix may vary
- flow integrity (API availability + event chain + report generation) is the primary reproducibility target

## Recovery If a Step Fails

See `TROUBLESHOOTING.md` for quick fixes.
