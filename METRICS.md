# Metrics Definitions

This document defines dashboard metrics to improve review clarity.

## Core KPI Metrics

### 1) Rug Catch Rate (%)

Definition:
- Among decisions classified as `NO_TRADE`, how many are later verified as `RUG_TRUE`.

Formula:

`RugCatchRate = noTradeRugTrue / noTradeVerified`

Shown as:
- percentage + sample size `n`

### 2) SIM_BUY Safety Rate (%)

Definition:
- Among decisions classified as `SIM_BUY`, how many are later verified as not rug.

Formula:

`SimBuySafetyRate = simBuyNotRug / simBuyVerified`

Shown as:
- percentage + sample size `n`

### 3) Average Drawdown (%)

Definition:
- Average drawdown of simulated positions in the observed window.

### 4) Market/Launchpad Data Success Rate (%)

Definition:
- Success ratio of upstream data fetch calls by domain.

Used to assess confidence and infrastructure health.

### 5) Top NO_TRADE Reason

Definition:
- Most frequent hard-filter reason in latest decision window.

Purpose:
- parameter tuning and explainability.

## Additional Recommended Metrics

### 6) Verification Coverage (%)

`verifiedDecisions / totalDecisions`

### 7) Data Quality Mix (%)

Share of `real / partial / stale / synthetic` in decision-time and verify-time signals.

### 8) False Abstention Rate (%)

Definition:
- `NO_TRADE` decisions later verified as `RUG_FALSE`.

## Interpretation Notes

- High Rug Catch with very small sample size should not be over-interpreted.
- Metrics must always be read with sample counts and data quality mix.
- For fair comparison, use the same mode (`safe` vs `demo`) and same time window.
