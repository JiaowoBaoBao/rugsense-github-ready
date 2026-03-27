const { clamp, round, hashToUnit } = require('../utils/helpers');

const AGENTS = ['TechGuard', 'OnChainWhale', 'SentimentHunter'];

function agentBias(agent) {
  if (agent === 'TechGuard') return { caution: 1.05, buyBias: -3 };
  if (agent === 'OnChainWhale') return { caution: 1.15, buyBias: -6 };
  return { caution: 0.95, buyBias: 2 };
}

function num(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return round(n, digits);
}

function normalizeReason(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildAgentAnalysis({ agent, score5, score10, score15, marketSignal }) {
  const liq = num(marketSignal.liquidityUsd, 0) ?? 0;
  const d1m = num(marketSignal.priceDelta1mPct, 2) ?? 0;
  const anomaly = num(marketSignal.txAnomalyScore, 2) ?? 0;

  if (agent === 'TechGuard') {
    return `TechGuard risk stack: 5m=${num(score5)}%, 10m=${num(score10)}%, 15m=${num(score15)}%; liquidity=${liq} USD, 1m move=${d1m}%, anomaly=${anomaly}.`;
  }
  if (agent === 'OnChainWhale') {
    return `OnChainWhale flow read: rug path 5/10/15m = ${num(score5)}%/${num(score10)}%/${num(score15)}%, with depth=${liq} USD and order-flow anomaly=${anomaly}.`;
  }
  return `SentimentHunter momentum check: projected rug risk ${num(score5)}%→${num(score10)}%→${num(score15)}%, 1m delta=${d1m}%, liquidity=${liq} USD, anomaly=${anomaly}.`;
}

function reasonCandidates({ agent, vote, score15, confidence, marketSignal, keyWarning }) {
  const liq = num(marketSignal.liquidityUsd, 0) ?? 0;
  const d1m = num(marketSignal.priceDelta1mPct, 2) ?? 0;
  const anomaly = num(marketSignal.txAnomalyScore, 2) ?? 0;
  const risk = num(marketSignal.riskScore, 2) ?? 50;

  if (agent === 'TechGuard') {
    if (vote === 'BUY') {
      return [
        `TechGuard votes BUY because the 15m rug probability is ${num(score15)}%, which stays within the simulation tolerance, while liquidity is ${liq} USD and anomaly score is ${anomaly}; the market can still support controlled exits.`,
        `BUY from TechGuard: riskScore=${risk} and 15m rug risk=${num(score15)}% are below the hard-stop zone, and the 1m move (${d1m}%) does not show a cascading dump pattern.`,
        `TechGuard keeps a BUY stance with evidence: moderate projected rug risk (${num(score15)}%), acceptable depth (${liq} USD), and no severe microstructure warning beyond "${keyWarning}".`
      ];
    }
    return [
      `TechGuard votes NO_BUY because the 15m rug probability reaches ${num(score15)}% with riskScore=${risk}; this exceeds the safety budget for simulated entries and increases forced-exit probability.`,
      `NO_BUY from TechGuard: 1m move=${d1m}% plus anomaly=${anomaly} indicates unstable tape behavior, and current liquidity (${liq} USD) is not deep enough for safe downside management.`,
      `TechGuard blocks entry: projected rug risk (${num(score15)}%) is too high relative to confidence (${num(confidence)}%), and the warning "${keyWarning}" is consistent with loss-acceleration risk.`
    ];
  }

  if (agent === 'OnChainWhale') {
    if (vote === 'BUY') {
      return [
        `OnChainWhale votes BUY since liquidity depth (${liq} USD) is currently sufficient and flow anomaly (${anomaly}) is contained, so slippage-adjusted execution risk remains manageable.`,
        `BUY from OnChainWhale: despite normal noise, riskScore=${risk} and 15m rug risk=${num(score15)}% do not imply a liquidity vacuum, so a small-sized simulation entry is defendable.`,
        `OnChainWhale supports BUY based on depth/flow evidence: order-flow stress is limited, projected rug path is not extreme, and current market depth can likely absorb exits.`
      ];
    }
    return [
      `OnChainWhale votes NO_BUY because depth is weak (${liq} USD) against observed flow stress (anomaly=${anomaly}), which raises slippage and trapped-exit risk.`,
      `NO_BUY from OnChainWhale: 15m rug probability=${num(score15)}% combined with riskScore=${risk} suggests poor liquidity-adjusted expectancy for this setup.`,
      `OnChainWhale rejects entry as flow quality is unfavorable: the warning "${keyWarning}" aligns with a thin-book regime where whales can move price faster than exits can clear.`
    ];
  }

  if (vote === 'BUY') {
    return [
      `SentimentHunter votes BUY because momentum is not in a panic state (1m move=${d1m}%) and confidence=${num(confidence)}% supports a controlled simulation attempt.`,
      `BUY from SentimentHunter: projected 15m rug risk (${num(score15)}%) is acceptable for the current sentiment regime, and no strong capitulation signal is detected in short-horizon flow.`,
      `SentimentHunter keeps BUY with rationale: the signal mix (riskScore=${risk}, anomaly=${anomaly}, liquidity=${liq} USD) still allows a bounded-risk simulation entry.`
    ];
  }

  return [
    `SentimentHunter votes NO_BUY because short-horizon sentiment quality is weak: 1m move=${d1m}%, confidence=${num(confidence)}%, and warning "${keyWarning}" point to unstable participation.`,
    `NO_BUY from SentimentHunter: projected rug risk at 15m (${num(score15)}%) is too elevated for the current confidence level, so upside conviction is insufficient.`,
    `SentimentHunter rejects the trade as the momentum/flow blend (riskScore=${risk}, anomaly=${anomaly}) suggests headline-driven swings without reliable continuation.`
  ];
}

function chooseDistinctReason({ candidates, usedReasonSet, lastReason }) {
  const lastNorm = normalizeReason(lastReason);

  for (const text of candidates) {
    const n = normalizeReason(text);
    if (!usedReasonSet.has(n) && (!lastNorm || n !== lastNorm)) {
      return text;
    }
  }

  const fallback = candidates[0] || 'Insufficient signal quality for decision.';
  let i = 1;
  let picked = `${fallback} (alt-angle ${i})`;
  while (usedReasonSet.has(normalizeReason(picked)) || normalizeReason(picked) === lastNorm) {
    i += 1;
    picked = `${fallback} (alt-angle ${i})`;
  }
  return picked;
}

function predictPeerBuyProb({ agent, score15, confidence, marketSignal, seed }) {
  const liq = Number(marketSignal?.liquidityUsd || 0);
  const risk = Number(marketSignal?.riskScore || 50);
  const anomaly = Number(marketSignal?.txAnomalyScore || 0);

  const agentAdj = agent === 'TechGuard'
    ? -0.08
    : agent === 'OnChainWhale'
      ? -0.12
      : 0.06;

  const base = (100 - Number(score15 || 50)) / 100;
  const liqAdj = clamp((liq - 20_000) / 120_000, -0.25, 0.18);
  const riskAdj = clamp((50 - risk) / 180, -0.22, 0.22);
  const flowAdj = clamp((25 - anomaly) / 180, -0.16, 0.16);
  const confAdj = clamp((Number(confidence || 50) - 50) / 240, -0.12, 0.12);
  const noise = (seed - 0.5) * 0.06;

  return clamp(base + liqAdj + riskAdj + flowAdj + confAdj + agentAdj + noise, 0.02, 0.98);
}

function buildAgentOutput({ agent, token, marketSignal, ts, usedReasonSet, lastReasonByAgent, agentGenerationByName }) {
  const seed = hashToUnit(`${agent}_${token}_${Math.floor(ts / 60_000)}`);
  const { caution, buyBias } = agentBias(agent);
  const agentGeneration = Number(agentGenerationByName?.[agent] || 1);

  const baseRisk = marketSignal.riskScore || 50;
  const dropShock = Math.max(0, -(marketSignal.priceDelta1mPct || 0)) * 1.8;
  const liquidityPenalty = marketSignal.liquidityUsd < 20000 ? 18 : marketSignal.liquidityUsd < 50000 ? 9 : 2;
  const score5 = clamp((baseRisk + dropShock + liquidityPenalty + seed * 8) * caution, 1, 99);
  const score10 = clamp(score5 + seed * 4 - 1.5, 1, 99);
  const score15 = clamp(score10 + seed * 5 - 2.2, 1, 99);

  const confidence = clamp(55 + (Math.abs(marketSignal.priceDelta1mPct || 0) * 2) + seed * 20, 35, 98);
  const voteScore = 100 - score15 + buyBias + (confidence - 50) * 0.15;
  const vote = voteScore >= 52 ? 'BUY' : 'NO_BUY';

  let keyWarning = 'No major red flag';
  if (score15 > 75) keyWarning = 'High rug risk in 15m window';
  else if (marketSignal.liquidityUsd < 20000) keyWarning = 'Liquidity too thin';
  else if ((marketSignal.priceDelta1mPct || 0) < -8) keyWarning = 'Flash dump momentum detected';

  const candidates = reasonCandidates({
    agent,
    vote,
    score15,
    confidence,
    marketSignal,
    keyWarning
  });

  const reason = chooseDistinctReason({
    candidates,
    usedReasonSet,
    lastReason: lastReasonByAgent?.[agent]
  });

  const peerBuyProb = predictPeerBuyProb({
    agent,
    score15,
    confidence,
    marketSignal,
    seed
  });

  usedReasonSet.add(normalizeReason(reason));

  return {
    agent,
    agentGeneration,
    agentInstance: `${agent}#${agentGeneration}`,
    token,
    analysis: buildAgentAnalysis({ agent, score5, score10, score15, marketSignal }),
    rug_prob_5min: round(score5, 2),
    rug_prob_10min: round(score10, 2),
    rug_prob_15min: round(score15, 2),
    confidence: round(confidence, 2),
    vote,
    reason,
    peerPrediction: {
      peerBuyProb: round(peerBuyProb, 4),
      peerNoBuyProb: round(1 - peerBuyProb, 4),
      expectedPeerVote: peerBuyProb >= 0.5 ? 'BUY' : 'NO_BUY'
    },
    key_warning: keyWarning,
    features: {
      priceDelta1mPct: marketSignal.priceDelta1mPct,
      liquidityUsd: marketSignal.liquidityUsd,
      riskScore: marketSignal.riskScore,
      txAnomalyScore: marketSignal.txAnomalyScore
    }
  };
}

function applyDebateRound(outputs, marketSignal) {
  return outputs.map((row) => {
    const peers = outputs.filter((x) => x.agent !== row.agent);
    const opposite = peers.filter((x) => x.vote !== row.vote);
    const challengerPool = opposite.length ? opposite : peers;
    const challenger = challengerPool.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0] || null;

    if (!challenger) return row;

    const liq = num(marketSignal?.liquidityUsd, 0) ?? 0;
    const anomaly = num(marketSignal?.txAnomalyScore, 2) ?? 0;
    const challenge = `${challenger.agent} challenges ${row.agent}: vote=${challenger.vote}, key risk=${challenger.key_warning}.`;

    const rebuttal = row.vote === 'BUY'
      ? `${row.agent} keeps BUY: projected risk ${num(row.rug_prob_15min)}% is still tradable with liquidity ${liq} USD and anomaly ${anomaly}.`
      : `${row.agent} keeps NO_BUY: downside variance remains elevated (risk15=${num(row.rug_prob_15min)}%, anomaly=${anomaly}) despite counterpoints.`;

    const debateReason = `${row.reason} After debate with ${challenger.agent}, ${row.agent} maintains ${row.vote}.`;

    return {
      ...row,
      reason: debateReason,
      debate: {
        challenger: challenger.agent,
        challengerVote: challenger.vote,
        challenge,
        rebuttal,
        finalVote: row.vote
      }
    };
  });
}

function runThreeAgentAnalysis({ token, marketSignal, ts = Date.now(), lastReasonByAgent = {}, agentGenerationByName = {} }) {
  const usedReasonSet = new Set();
  const baseOutputs = AGENTS.map((agent) => buildAgentOutput({
    agent,
    token,
    marketSignal,
    ts,
    usedReasonSet,
    lastReasonByAgent,
    agentGenerationByName
  }));

  return applyDebateRound(baseOutputs, marketSignal);
}

module.exports = {
  AGENTS,
  runThreeAgentAnalysis
};
