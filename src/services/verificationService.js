const { id, nowIso, round } = require('../utils/helpers');

function evaluateRug({ decision, currentSignal, cfg }) {
  const entryPrice = Number(decision?.marketAtDecision?.price || 0);
  const nowPrice = Number(currentSignal?.price || 0);
  const drawdownPct = entryPrice > 0 ? ((nowPrice - entryPrice) / entryPrice) * 100 : 0;

  const hardRug =
    Number(currentSignal?.liquidityUsd || 0) < cfg.simulation.minLiquidityUsd * 0.5 ||
    Number(currentSignal?.riskScore || 0) > 85;

  const softRug =
    drawdownPct <= cfg.simulation.softRugDropPct15m ||
    (Number(currentSignal?.riskScore || 0) - Number(decision?.marketAtDecision?.riskScore || 0) >= 22);

  const verdict = hardRug || softRug ? 'RUG_TRUE' : 'RUG_FALSE';

  return {
    drawdownPct: round(drawdownPct, 4),
    hardRug,
    softRug,
    verdict
  };
}

function buildVerificationRecord({ decision, signalAtVerify, rugEval }) {
  return {
    id: id('verify'),
    ts: nowIso(),
    decisionId: decision.id,
    token: decision.token,
    contract: decision.contract,
    decision: decision.decision,
    verifyWindow: '15m',
    signalAtVerify,
    ...rugEval
  };
}

module.exports = {
  evaluateRug,
  buildVerificationRecord
};
