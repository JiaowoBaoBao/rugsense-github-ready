const { round } = require('../utils/helpers');

function normalizeVote(v) {
  return String(v || '').toUpperCase() === 'BUY' ? 'BUY' : 'NO_BUY';
}

function aggregateRisk(agentOutputs) {
  const n = agentOutputs.length || 1;
  const sums = agentOutputs.reduce(
    (acc, row) => {
      acc.p5 += Number(row.rug_prob_5min || 0);
      acc.p10 += Number(row.rug_prob_10min || 0);
      acc.p15 += Number(row.rug_prob_15min || 0);
      return acc;
    },
    { p5: 0, p10: 0, p15: 0 }
  );

  return {
    p5: round(sums.p5 / n, 2),
    p10: round(sums.p10 / n, 2),
    p15: round(sums.p15 / n, 2)
  };
}

function runVote({ agentOutputs, userVotes, threshold }) {
  const votes = {
    techguard: normalizeVote(agentOutputs.find((a) => a.agent === 'TechGuard')?.vote),
    onchainwhale: normalizeVote(agentOutputs.find((a) => a.agent === 'OnChainWhale')?.vote),
    sentimenthunter: normalizeVote(agentOutputs.find((a) => a.agent === 'SentimentHunter')?.vote),
    user_vote_1: normalizeVote(userVotes?.[0]),
    user_vote_2: normalizeVote(userVotes?.[1])
  };

  const buyVotes = Object.values(votes).filter((v) => v === 'BUY').length;
  const decision = buyVotes >= threshold ? 'SIM_BUY' : 'NO_TRADE';
  const weightedRug = aggregateRisk(agentOutputs);

  return {
    votes,
    buyVotes,
    decision,
    weightedRug
  };
}

module.exports = {
  runVote,
  aggregateRisk,
  normalizeVote
};
