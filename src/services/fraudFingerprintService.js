const crypto = require('crypto');
const { id, nowIso, round } = require('../utils/helpers');

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeMix(raw = {}) {
  const keys = ['H', 'L', 'M', 'S'];
  const total = keys.reduce((acc, k) => acc + Math.max(0, num(raw[k], 0)), 0) || 1;
  const out = {};
  for (const k of keys) {
    out[k] = round((Math.max(0, num(raw[k], 0)) / total) * 100, 2);
  }
  return out;
}

function dominantTaxonomy(mix = {}) {
  const entries = Object.entries(mix);
  if (!entries.length) return { class: 'UNKNOWN', pct: 0 };
  const [klass, pct] = entries.sort((a, b) => b[1] - a[1])[0];
  return { class: klass, pct: round(pct, 2) };
}

function instructionSequence({ decision, verify, vector }) {
  const seq = [];
  const hardFilter = String(decision?.hardFilter || '');

  if (num(vector.liquidityShock) < 12) seq.push('LP_BOOTSTRAP');
  if (num(vector.riskShock) >= 18) seq.push('PERMISSION_DRIFT');
  if (num(vector.anomalyShock) >= 15) seq.push('WASH_FLOW');
  if (hardFilter.includes('SECURITY_RISK_TOO_HIGH')) seq.push('GUARDRAIL_HIT');
  if (num(vector.liquidityShock) >= 35) seq.push('LIQUIDITY_DRAIN');
  if (num(vector.drawdownShock) >= 25) seq.push('MARKET_DUMP');
  if (verify?.hardRug) seq.push('RUG_EXECUTE');
  if (verify?.softRug) seq.push('SLOW_BLEED');

  if (!seq.length) seq.push('NO_ATTACK_PATTERN');
  return seq;
}

function fingerprintIdFromSequence(sequence = []) {
  const key = sequence.join('>');
  const hex = crypto.createHash('sha256').update(key).digest('hex');
  const no = (parseInt(hex.slice(0, 8), 16) % 1000) + 1;
  return `#${String(no).padStart(3, '0')}`;
}

function taxonomyFromSignals({ decision, verify, vector }) {
  const hardFilter = String(decision?.hardFilter || '');

  const H =
    num(vector.anomalyShock) * 0.45 +
    num(vector.riskShock) * 0.35 +
    (hardFilter.includes('SLIPPAGE') ? 25 : 0) +
    (hardFilter.includes('SECURITY_RISK') ? 20 : 0);

  const L =
    num(vector.liquidityShock) * 0.6 +
    num(vector.drawdownShock) * 0.25 +
    num(vector.anomalyShock) * 0.15;

  const M =
    num(vector.riskShock) * 0.5 +
    num(vector.anomalyShock) * 0.35 +
    (verify?.hardRug ? 20 : 0);

  const S =
    (verify?.verdict === 'RUG_TRUE' ? 45 : 25) +
    Math.max(0, 35 - num(vector.liquidityShock)) * 0.6 +
    Math.max(0, 35 - num(vector.riskShock)) * 0.4;

  const mix = normalizeMix({ H, L, M, S });
  const top = dominantTaxonomy(mix);

  const labels = {
    H: 'Honeypot-like (buy-sell asymmetry risk)',
    L: 'LP-removal style (liquidity drain)',
    M: 'Mint/permission exploit style',
    S: 'Social-engineering dominant pattern'
  };

  return {
    mix,
    dominantClass: top.class,
    dominantPct: top.pct,
    dominantLabel: labels[top.class] || 'Unknown taxonomy class'
  };
}

function classifyFingerprint({ decision, verify }) {
  const atDecision = decision?.marketAtDecision || {};
  const atVerify = verify?.signalAtVerify || {};

  const liquidityBefore = num(atDecision.liquidityUsd, 0);
  const liquidityAfter = num(atVerify.liquidityUsd, liquidityBefore);
  const riskBefore = num(atDecision.riskScore, 0);
  const riskAfter = num(atVerify.riskScore, riskBefore);
  const anomalyBefore = num(atDecision.txAnomalyScore, 0);
  const anomalyAfter = num(atVerify.txAnomalyScore, anomalyBefore);
  const drawdownPct = num(verify?.drawdownPct, 0);

  const tags = [];
  if (decision?.hardFilter) tags.push(`HARD_FILTER_${decision.hardFilter}`);
  if (liquidityBefore > 0 && liquidityAfter <= liquidityBefore * 0.5) tags.push('LIQUIDITY_COLLAPSE');
  if (riskAfter - riskBefore >= 18) tags.push('RISK_SPIKE');
  if (drawdownPct <= -20) tags.push('FLASH_DUMP');
  if (anomalyAfter - anomalyBefore >= 18) tags.push('FLOW_ANOMALY_SURGE');
  if (verify?.hardRug) tags.push('HARD_RUG_SIGNAL');
  if (verify?.softRug) tags.push('SOFT_RUG_SIGNAL');
  if (atDecision?.synthetic || atVerify?.synthetic) tags.push('SYNTHETIC_DATA');

  const vector = {
    liquidityShock: round(Math.max(0, liquidityBefore > 0 ? (1 - liquidityAfter / liquidityBefore) * 100 : 0), 2),
    riskShock: round(Math.max(0, riskAfter - riskBefore), 2),
    anomalyShock: round(Math.max(0, anomalyAfter - anomalyBefore), 2),
    drawdownShock: round(Math.abs(Math.min(0, drawdownPct)), 2)
  };

  const score = round(
    vector.liquidityShock * 0.35 +
    vector.riskShock * 0.25 +
    vector.anomalyShock * 0.2 +
    vector.drawdownShock * 0.2,
    3
  );

  const cause = tags[0] || 'NO_CLEAR_FRAUD_FINGERPRINT';

  return {
    tags,
    cause,
    vector,
    score
  };
}

function toVector(row) {
  return [
    num(row?.vector?.liquidityShock, 0),
    num(row?.vector?.riskShock, 0),
    num(row?.vector?.anomalyShock, 0),
    num(row?.vector?.drawdownShock, 0)
  ];
}

function cosine(a = [], b = []) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;

  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa <= 0 || bb <= 0) return 0;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

function explainSimilarity(cur, hit) {
  const shared = (cur.tags || []).filter((t) => (hit.tags || []).includes(t));
  const lead = shared.length
    ? `Shared tags: ${shared.join(', ')}`
    : 'Vector overlap on liquidity/risk/anomaly pattern';

  return `${lead}; benchmark case ${hit.token || '-'} (${hit.verdict || 'UNKNOWN'})`;
}

function attachSimilarCases(fingerprint, history = [], topK = 3) {
  const curVec = toVector(fingerprint);

  const ranked = (history || [])
    .filter((x) => x && x.decisionId !== fingerprint.decisionId)
    .map((x) => {
      const score = cosine(curVec, toVector(x));
      return {
        decisionId: x.decisionId,
        token: x.token,
        verdict: x.verdict,
        cause: x.cause,
        fingerprintId: x.fingerprintId || null,
        score,
        scorePct: round(score * 100, 2),
        tags: x.tags || [],
        ts: x.ts
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(topK || 3)));

  return {
    ...fingerprint,
    similarCases: ranked,
    similarExplanation: ranked.length
      ? explainSimilarity(fingerprint, ranked[0])
      : 'No historical similar case yet.'
  };
}

function buildFraudFingerprint({ decision, verify }) {
  const cls = classifyFingerprint({ decision, verify });
  const sequence = instructionSequence({ decision, verify, vector: cls.vector });
  const taxonomy = taxonomyFromSignals({ decision, verify, vector: cls.vector });
  const fingerprintId = fingerprintIdFromSequence(sequence);

  return {
    id: id('fp'),
    ts: nowIso(),
    chain: decision?.chain,
    token: decision?.token,
    contract: decision?.contract,
    decisionId: decision?.id,
    verifyId: verify?.id,
    verdict: verify?.verdict,
    cause: cls.cause,
    tags: cls.tags,
    vector: cls.vector,
    fingerprintScore: cls.score,
    fingerprintId,
    instructionSequence: sequence,
    taxonomy,
    synthetic: Boolean(decision?.marketAtDecision?.synthetic || verify?.signalAtVerify?.synthetic)
  };
}

function summarizeFraudFingerprints(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;

  const tagStats = new Map();
  const idStats = new Map();
  const taxSum = { H: 0, L: 0, M: 0, S: 0 };
  let rugged = 0;
  let synthetic = 0;

  for (const row of list) {
    if (row.verdict === 'RUG_TRUE') rugged += 1;
    if (row.synthetic) synthetic += 1;

    for (const tag of row.tags || []) {
      if (!tagStats.has(tag)) tagStats.set(tag, { count: 0, rugged: 0 });
      const cur = tagStats.get(tag);
      cur.count += 1;
      if (row.verdict === 'RUG_TRUE') cur.rugged += 1;
    }

    const fid = String(row.fingerprintId || '').trim();
    if (fid) {
      if (!idStats.has(fid)) idStats.set(fid, { count: 0, rugged: 0 });
      const cur = idStats.get(fid);
      cur.count += 1;
      if (row.verdict === 'RUG_TRUE') cur.rugged += 1;
    }

    for (const k of ['H', 'L', 'M', 'S']) {
      taxSum[k] += num(row?.taxonomy?.mix?.[k], 0);
    }
  }

  const topTags = [...tagStats.entries()]
    .map(([tag, v]) => ({
      tag,
      count: v.count,
      rugRatePct: round(v.count ? (v.rugged / v.count) * 100 : 0, 2)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topFingerprintIds = [...idStats.entries()]
    .map(([fingerprintId, v]) => ({
      fingerprintId,
      count: v.count,
      rugRatePct: round(v.count ? (v.rugged / v.count) * 100 : 0, 2)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const taxonomyAvg = {
    H: round(total ? taxSum.H / total : 0, 2),
    L: round(total ? taxSum.L / total : 0, 2),
    M: round(total ? taxSum.M / total : 0, 2),
    S: round(total ? taxSum.S / total : 0, 2)
  };
  const dominant = dominantTaxonomy(taxonomyAvg);

  return {
    total,
    rugged,
    ruggedRatePct: round(total ? (rugged / total) * 100 : 0, 2),
    synthetic,
    syntheticRatePct: round(total ? (synthetic / total) * 100 : 0, 2),
    topTags,
    topFingerprintIds,
    taxonomyAvg,
    dominantTaxonomy: dominant.class,
    dominantTaxonomyPct: dominant.pct
  };
}

module.exports = {
  buildFraudFingerprint,
  attachSimilarCases,
  summarizeFraudFingerprints
};
