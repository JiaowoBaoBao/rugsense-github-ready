const { round } = require('../utils/helpers');

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function reasonFromFilter(code) {
  if (code === 'LIQUIDITY_TOO_LOW') return 'Liquidity is below configured safety minimum.';
  if (code === 'SLIPPAGE_TOO_HIGH') return 'Estimated slippage exceeds configured tolerance.';
  if (code === 'SECURITY_RISK_TOO_HIGH') return 'Risk score breached security threshold.';
  return 'Hard risk filter blocked execution.';
}

function buildEvidence(signal, cfg) {
  const riskScore = Number(signal?.riskScore || 0);
  const liquidityUsd = Number(signal?.liquidityUsd || 0);
  const priceDelta1mPct = Number(signal?.priceDelta1mPct || 0);
  const txAnomalyScore = Number(signal?.txAnomalyScore || 0);

  const riskWeight = clamp01(riskScore / 100);
  const liquidityWeight = clamp01(1 - (liquidityUsd / Math.max(1, Number(cfg?.simulation?.minLiquidityUsd || 20_000) * 4)));
  const momentumWeight = clamp01(Math.max(0, -priceDelta1mPct) / 12);
  const flowWeight = clamp01(txAnomalyScore / 100);

  const rawTotal = riskWeight + liquidityWeight + momentumWeight + flowWeight || 1;
  return {
    risk: round((riskWeight / rawTotal) * 100, 2),
    liquidity: round((liquidityWeight / rawTotal) * 100, 2),
    momentum: round((momentumWeight / rawTotal) * 100, 2),
    flow: round((flowWeight / rawTotal) * 100, 2)
  };
}

function buildBtsSummary(agentOutputs = []) {
  const rows = Array.isArray(agentOutputs) ? agentOutputs : [];
  if (!rows.length) return null;

  const probs = rows.map((x) => Number(x?.peerPrediction?.peerBuyProb ?? 0.5));
  const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
  const variance = probs.reduce((acc, x) => acc + (x - mean) ** 2, 0) / probs.length;

  const riskAlerts = rows.map((x) => {
    const peers = rows.filter((p) => p.agent !== x.agent);
    const peerRisk = peers.length
      ? peers.reduce((acc, p) => acc + Number(p.rug_prob_15min || 0), 0) / peers.length
      : Number(x.rug_prob_15min || 0);
    return {
      agent: x.agent,
      risk15: Number(x.rug_prob_15min || 0),
      peerAvgRisk15: round(peerRisk, 2),
      contrarianRiskLead: round(Number(x.rug_prob_15min || 0) - peerRisk, 2)
    };
  }).sort((a, b) => b.contrarianRiskLead - a.contrarianRiskLead);

  return {
    protocol: 'Incentive-Compatible Agent Voting Protocol (BTS-lite)',
    peerBuyPredictionMean: round(mean, 4),
    peerBuyPredictionDispersion: round(Math.sqrt(variance), 4),
    topContrarianRiskAgent: riskAlerts[0] || null
  };
}

function buildDebateSummary(agentOutputs = []) {
  const rows = Array.isArray(agentOutputs) ? agentOutputs : [];
  const engaged = rows.filter((x) => x?.debate?.challenger);
  if (!engaged.length) return null;

  return {
    rounds: 2,
    engagedAgents: engaged.length,
    challengers: [...new Set(engaged.map((x) => x.debate.challenger))]
  };
}

function buildDecisionExplanation({ decision, voteResult, agentOutputs, hardFilter, signal, cfg }) {
  const buys = (agentOutputs || []).filter((x) => x.vote === 'BUY').map((x) => x.agent);
  const noBuys = (agentOutputs || []).filter((x) => x.vote !== 'BUY').map((x) => x.agent);

  const conflicts = [];
  if (buys.length && noBuys.length) {
    conflicts.push({
      type: 'VOTE_SPLIT',
      detail: `Agents split: BUY=${buys.join(', ') || '-'} / NO_BUY=${noBuys.join(', ') || '-'}`
    });
  }

  if (hardFilter?.blocked) {
    conflicts.push({
      type: 'HARD_FILTER_OVERRIDE',
      detail: reasonFromFilter(hardFilter.reason)
    });
  }

  return {
    decision: decision.decision,
    buyVotes: voteResult.buyVotes,
    threshold: Number(cfg?.voting?.buyThreshold || 3),
    consensus: {
      buyAgents: buys,
      noBuyAgents: noBuys,
      userVotes: [decision.request?.userVotes?.[0], decision.request?.userVotes?.[1]].filter(Boolean)
    },
    evidenceWeights: buildEvidence(signal, cfg),
    conflicts,
    bts: buildBtsSummary(agentOutputs),
    debate: buildDebateSummary(agentOutputs),
    hardFilter: hardFilter?.blocked
      ? {
          code: hardFilter.reason,
          detail: reasonFromFilter(hardFilter.reason)
        }
      : null
  };
}

module.exports = {
  buildDecisionExplanation
};
