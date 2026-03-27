const { round } = require('../utils/helpers');

function runBacktestSummary({ decisions = [], verifications = [], limit = 100, includeSynthetic = false }) {
  const recentDecisions = decisions.slice(-Math.max(1, Number(limit))).reverse();
  const verifyByDecision = new Map(verifications.map((v) => [v.decisionId, v]));

  let verified = 0;
  let noTradeCount = 0;
  let noTradeRugCaught = 0;
  let simBuyCount = 0;
  let simBuySafeCount = 0;
  let drawdownSum = 0;
  let syntheticVerified = 0;

  for (const d of recentDecisions) {
    const v = verifyByDecision.get(d.id);
    if (!v) continue;

    const isSynthetic = Boolean(d?.marketAtDecision?.synthetic || v?.signalAtVerify?.synthetic);
    if (isSynthetic) syntheticVerified += 1;
    if (isSynthetic && !includeSynthetic) continue;

    verified += 1;
    drawdownSum += Number(v.drawdownPct || 0);

    if (d.decision === 'NO_TRADE') {
      noTradeCount += 1;
      if (v.verdict === 'RUG_TRUE') noTradeRugCaught += 1;
    }

    if (d.decision === 'SIM_BUY') {
      simBuyCount += 1;
      if (v.verdict === 'RUG_FALSE') simBuySafeCount += 1;
    }
  }

  return {
    sampleSize: recentDecisions.length,
    verified,
    scoringMode: includeSynthetic ? 'all-data' : 'real-only',
    syntheticVerified,
    excludedSynthetic: includeSynthetic ? 0 : syntheticVerified,
    noTradeCount,
    noTradeRugCaught,
    noTradeRugCatchRate: noTradeCount ? round((noTradeRugCaught / noTradeCount) * 100, 2) : null,
    simBuyCount,
    simBuySafeCount,
    simBuySafetyRate: simBuyCount ? round((simBuySafeCount / simBuyCount) * 100, 2) : null,
    avgDrawdownPct: verified ? round(drawdownSum / verified, 4) : null
  };
}

function regressionChecks({ state }) {
  const failures = [];
  const account = state?.simAccount || {};

  if (Number(account.availableUsdc || 0) < -0.000001) {
    failures.push('availableUsdc should not be negative');
  }

  if (Number(account.equityUsdc || 0) < -0.000001) {
    failures.push('equityUsdc should not be negative');
  }

  const reasons = (state?.latestAgentOutputs || []).map((x) => String(x.reason || '').trim().toLowerCase());
  if (reasons.length && new Set(reasons).size !== reasons.length) {
    failures.push('latest agent reasons should be unique');
  }

  return {
    ok: failures.length === 0,
    failures
  };
}

module.exports = {
  runBacktestSummary,
  regressionChecks
};
