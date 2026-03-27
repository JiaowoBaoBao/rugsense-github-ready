const { id, nowIso, round, clamp } = require('../utils/helpers');

const AGENTS = ['TechGuard', 'OnChainWhale', 'SentimentHunter'];

function avg(values = []) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + Number(b || 0), 0) / values.length;
}

function computeFitness({
  agentOutputs,
  verifications,
  decisions = [],
  includeSynthetic = false,
  agentGenerationByName = {},
  agents = AGENTS
}) {
  const byDecision = new Map(verifications.map((v) => [v.decisionId, v]));
  const decisionById = new Map((decisions || []).map((d) => [d.id, d]));

  const currentRows = (agentOutputs || []).filter((r) => {
    if (!agents.includes(r.agent)) return false;
    const expectedGeneration = Number(agentGenerationByName[r.agent] || 1);
    return Number(r.agentGeneration || 1) === expectedGeneration;
  });

  const rowsByDecision = new Map();
  for (const row of currentRows) {
    if (!rowsByDecision.has(row.decisionId)) rowsByDecision.set(row.decisionId, []);
    rowsByDecision.get(row.decisionId).push(row);
  }

  const scores = agents.map((agent) => {
    const rows = currentRows.filter((r) => r.agent === agent);
    if (!rows.length) {
      return {
        agent,
        sampleCount: 0,
        brier: null,
        directionAcc: null,
        calibration: null,
        stability: null,
        btsAccuracy: null,
        contrarianHits: 0,
        contrarianRate: null,
        fitness: 0,
        excludedSynthetic: 0
      };
    }

    let brierSum = 0;
    let hit = 0;
    let calErr = 0;
    let prev = null;
    let drift = 0;
    let n = 0;
    let excludedSynthetic = 0;

    let btsAccSum = 0;
    let contrarianHits = 0;

    for (const row of rows) {
      const verify = byDecision.get(row.decisionId);
      if (!verify) continue;

      const decision = decisionById.get(row.decisionId);
      const isSynthetic = Boolean(decision?.marketAtDecision?.synthetic || verify?.signalAtVerify?.synthetic);
      if (!includeSynthetic && isSynthetic) {
        excludedSynthetic += 1;
        continue;
      }

      const peers = (rowsByDecision.get(row.decisionId) || []).filter((x) => x.agent !== row.agent);
      const actualPeerBuyRate = peers.length
        ? peers.filter((x) => String(x.vote).toUpperCase() === 'BUY').length / peers.length
        : 0.5;
      const predictedPeerBuy = Number(row?.peerPrediction?.peerBuyProb);
      const pred = Number.isFinite(predictedPeerBuy) ? predictedPeerBuy : 0.5;
      const predAcc = 1 - Math.abs(pred - actualPeerBuyRate);

      const meanPred = avg((rowsByDecision.get(row.decisionId) || []).map((x) => Number(x?.peerPrediction?.peerBuyProb ?? 0.5)));
      const novelty = Math.abs(pred - meanPred);

      const y = verify.verdict === 'RUG_TRUE' ? 1 : 0;
      const p = Number(row.rug_prob_15min || 0) / 100;
      const peerRiskAvg = peers.length ? avg(peers.map((x) => Number(x.rug_prob_15min || 0))) : Number(row.rug_prob_15min || 0);

      const contrarianRiskLead = Number(row.rug_prob_15min || 0) - peerRiskAvg;
      const contrarianHit = (
        (y === 1 && contrarianRiskLead >= 12) ||
        (y === 0 && contrarianRiskLead <= -12)
      );

      n += 1;
      brierSum += (p - y) ** 2;
      if ((p >= 0.5 && y === 1) || (p < 0.5 && y === 0)) hit += 1;
      calErr += Math.abs(p - y);
      if (prev != null) drift += Math.abs(p - prev);
      prev = p;

      btsAccSum += predAcc * (0.55 + novelty);
      if (contrarianHit) contrarianHits += 1;
    }

    if (n === 0) {
      return {
        agent,
        sampleCount: 0,
        brier: null,
        directionAcc: null,
        calibration: null,
        stability: null,
        btsAccuracy: null,
        contrarianHits: 0,
        contrarianRate: null,
        fitness: 0,
        excludedSynthetic
      };
    }

    const brier = brierSum / n;
    const directionAcc = hit / n;
    const calibration = 1 - calErr / n;
    const stability = 1 - (n > 1 ? drift / (n - 1) : 0.2);
    const btsAccuracy = clamp(btsAccSum / n, 0, 1);
    const contrarianRate = contrarianHits / n;

    const fitness =
      0.34 * (1 - brier) +
      0.2 * directionAcc +
      0.16 * Math.max(0, calibration) +
      0.08 * Math.max(0, stability) +
      0.1 * btsAccuracy +
      0.12 * contrarianRate;

    return {
      agent,
      sampleCount: n,
      brier: round(brier, 5),
      directionAcc: round(directionAcc, 5),
      calibration: round(calibration, 5),
      stability: round(stability, 5),
      btsAccuracy: round(btsAccuracy, 5),
      contrarianHits,
      contrarianRate: round(contrarianRate, 5),
      fitness: round(fitness, 5),
      excludedSynthetic
    };
  });

  const ranked = [...scores].sort((a, b) => b.fitness - a.fitness);
  const excludedSyntheticTotal = scores.reduce((acc, s) => acc + Number(s.excludedSynthetic || 0), 0);
  const replacementSuggestion = ranked.length
    ? {
        weakest: ranked[ranked.length - 1].agent,
        reason: 'Lowest composite fitness (accuracy + BTS insight + contrarian risk hit rate)',
        suggestion: 'Run shadow challenger and replace if challenger fitness is higher for 2 rounds.'
      }
    : null;

  return {
    id: id('evo'),
    ts: nowIso(),
    ranking: ranked,
    replacementSuggestion,
    scoringMode: includeSynthetic ? 'all-data' : 'real-only',
    excludedSyntheticTotal,
    votingProtocol: 'Incentive-Compatible Agent Voting Protocol (BTS-lite)'
  };
}

module.exports = {
  computeFitness
};
