const { id, nowIso, round } = require('../utils/helpers');

const DEFAULT_RETENTION = {
  maxExperiences: 160,
  maxSummaries: 40,
  maxLongTerm: 24,
  maxLifecycle: 120,
  summaryIntervalMs: 6 * 60 * 60_000,
  minSamplesForReplacement: 12,
  replaceFitnessThreshold: 0.46,
  replaceGapThreshold: 0.08
};

function normalizeReason(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function createAgentProfile(agent, generation = 1, replacements = 0) {
  return {
    agent,
    generation,
    instanceId: `${agent}#${generation}`,
    active: true,
    createdAt: nowIso(),
    retiredAt: null,
    retiredReason: null,
    experiences: [],
    summaries: [],
    longTerm: [],
    stats: {
      totalRounds: 0,
      lastDecisionId: null,
      replacements
    }
  };
}

function ensureAgentMemoryState(state, agents = []) {
  const base = state && typeof state === 'object'
    ? state
    : { version: 1, updatedAt: nowIso(), agents: {}, lifecycle: [] };

  let changed = false;

  if (!base.version) {
    base.version = 1;
    changed = true;
  }
  if (!base.updatedAt) {
    base.updatedAt = nowIso();
    changed = true;
  }
  if (!base.agents || typeof base.agents !== 'object') {
    base.agents = {};
    changed = true;
  }
  if (!Array.isArray(base.lifecycle)) {
    base.lifecycle = [];
    changed = true;
  }

  for (const agent of agents) {
    if (!base.agents[agent]) {
      base.agents[agent] = createAgentProfile(agent, 1, 0);
      changed = true;
    }
  }

  if (changed) {
    base.updatedAt = nowIso();
  }

  return base;
}

function getAgentGenerationByName(state, agents = []) {
  const out = {};
  for (const agent of agents) {
    const g = Number(state?.agents?.[agent]?.generation || 1);
    out[agent] = Number.isFinite(g) && g > 0 ? g : 1;
  }
  return out;
}

function getLastReasonByAgent(state, agents = []) {
  const out = {};
  for (const agent of agents) {
    const p = state?.agents?.[agent];
    const last = p?.experiences?.[p.experiences.length - 1];
    out[agent] = last?.reason || null;
  }
  return out;
}

function appendDecisionExperiences({ state, outputs, decision }) {
  if (!Array.isArray(outputs) || !decision) return state;

  for (const row of outputs) {
    const agent = String(row.agent || '').trim();
    if (!agent) continue;

    if (!state.agents[agent]) {
      state.agents[agent] = createAgentProfile(agent, Number(row.agentGeneration || 1), 0);
    }

    const profile = state.agents[agent];
    const generation = Number(row.agentGeneration || profile.generation || 1);

    profile.experiences.push({
      id: id('exp'),
      ts: decision.ts || nowIso(),
      decisionId: decision.id,
      token: decision.token,
      chain: decision.chain,
      vote: row.vote,
      reason: row.reason,
      keyWarning: row.key_warning,
      confidence: num(row.confidence),
      rugProb15: num(row.rug_prob_15min),
      riskScore: num(row.features?.riskScore),
      liquidityUsd: num(row.features?.liquidityUsd),
      priceDelta1mPct: num(row.features?.priceDelta1mPct),
      txAnomalyScore: num(row.features?.txAnomalyScore),
      agentGeneration: generation,
      agentInstance: `${agent}#${generation}`
    });

    profile.stats.totalRounds = num(profile.stats.totalRounds) + 1;
    profile.stats.lastDecisionId = decision.id;
  }

  state.updatedAt = nowIso();
  return state;
}

function dedupeExperiences(experiences = []) {
  const seen = new Set();
  const keep = [];

  for (let i = experiences.length - 1; i >= 0; i -= 1) {
    const row = experiences[i];
    const key = `${row.decisionId}|${row.vote}|${normalizeReason(row.reason)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(row);
  }

  return keep.reverse();
}

function summarizeAgent({ profile, agentOutputs, verifyByDecision }) {
  const gen = Number(profile.generation || 1);
  const rows = agentOutputs
    .filter((r) => r.agent === profile.agent && Number(r.agentGeneration || 1) === gen)
    .slice(-120);

  const sampleCount = rows.length;
  if (!sampleCount) {
    return {
      sampleCount: 0,
      verifiedCount: 0,
      directionAcc: null,
      avgConfidence: null,
      avgRisk15: null,
      reasonDiversity: null,
      topWarnings: [],
      text: `${profile.instanceId}: no new samples to summarize.`
    };
  }

  let verifiedCount = 0;
  let hit = 0;
  let confidenceSum = 0;
  let riskSum = 0;
  const warningCount = new Map();
  const reasonSet = new Set();

  for (const row of rows) {
    const verify = verifyByDecision.get(row.decisionId);
    const p = num(row.rug_prob_15min) / 100;

    confidenceSum += num(row.confidence);
    riskSum += num(row.rug_prob_15min);
    reasonSet.add(normalizeReason(row.reason));

    const warning = String(row.key_warning || 'none');
    warningCount.set(warning, (warningCount.get(warning) || 0) + 1);

    if (verify) {
      verifiedCount += 1;
      const y = verify.verdict === 'RUG_TRUE' ? 1 : 0;
      if ((p >= 0.5 && y === 1) || (p < 0.5 && y === 0)) hit += 1;
    }
  }

  const topWarnings = [...warningCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, c]) => `${k}(${c})`);

  const directionAcc = verifiedCount ? round(hit / verifiedCount, 4) : null;
  const avgConfidence = round(confidenceSum / sampleCount, 2);
  const avgRisk15 = round(riskSum / sampleCount, 2);
  const reasonDiversity = round(reasonSet.size / sampleCount, 4);

  const text = `${profile.instanceId}: samples=${sampleCount}, verified=${verifiedCount}, acc=${directionAcc ?? '-'}, avgConf=${avgConfidence}%, avgRisk15=${avgRisk15}%, reasonDiversity=${reasonDiversity}, warnings=${topWarnings.join(', ') || 'none'}.`;

  return {
    sampleCount,
    verifiedCount,
    directionAcc,
    avgConfidence,
    avgRisk15,
    reasonDiversity,
    topWarnings,
    text
  };
}

function appendSummaryAndLongTerm({ profile, summary }) {
  const summaryRow = {
    id: id('summary'),
    ts: nowIso(),
    agent: profile.agent,
    generation: profile.generation,
    instanceId: profile.instanceId,
    ...summary
  };
  profile.summaries.push(summaryRow);

  if (summary.sampleCount >= 8) {
    let insight = 'Signal quality stable; keep current posture.';
    if (summary.directionAcc != null && summary.directionAcc < 0.45) {
      insight = 'Accuracy weak on verified samples; tighten entry criteria.';
    } else if (summary.directionAcc != null && summary.directionAcc > 0.65) {
      insight = 'Accuracy strong on verified samples; preserve current heuristics.';
    }

    profile.longTerm.push({
      id: id('ltm'),
      ts: nowIso(),
      agent: profile.agent,
      generation: profile.generation,
      insight,
      metrics: {
        sampleCount: summary.sampleCount,
        verifiedCount: summary.verifiedCount,
        directionAcc: summary.directionAcc,
        reasonDiversity: summary.reasonDiversity
      }
    });
  }
}

function pruneProfile(profile, limits) {
  profile.experiences = dedupeExperiences(profile.experiences).slice(-limits.maxExperiences);
  profile.summaries = profile.summaries.slice(-limits.maxSummaries);
  profile.longTerm = profile.longTerm.slice(-limits.maxLongTerm);
}

function summarizeAndMaintain({ state, cfg, fitness, agentOutputs, verifications, agents = [] }) {
  const limits = {
    ...DEFAULT_RETENTION,
    ...(cfg?.evolution?.agentMemory || {})
  };

  const verifyByDecision = new Map(verifications.map((v) => [v.decisionId, v]));
  const now = Date.now();
  const summaryEvents = [];

  for (const agent of agents) {
    const profile = state.agents[agent] || createAgentProfile(agent);
    state.agents[agent] = profile;

    const lastSummaryAt = profile.summaries.length
      ? new Date(profile.summaries[profile.summaries.length - 1].ts).getTime()
      : 0;

    const due = !lastSummaryAt || (now - lastSummaryAt >= limits.summaryIntervalMs);

    if (due) {
      const summary = summarizeAgent({ profile, agentOutputs, verifyByDecision });
      appendSummaryAndLongTerm({ profile, summary });
      summaryEvents.push({ agent, generation: profile.generation, text: summary.text });
    }

    pruneProfile(profile, limits);
  }

  const retired = maybeReplaceWeakest({ state, fitness, limits, agents });
  state.lifecycle = state.lifecycle.slice(-limits.maxLifecycle);
  state.updatedAt = nowIso();

  return {
    state,
    summaryEvents,
    retired
  };
}

function maybeReplaceWeakest({ state, fitness, limits, agents = [] }) {
  const ranking = Array.isArray(fitness?.ranking) ? [...fitness.ranking] : [];
  const activeRank = ranking
    .filter((r) => agents.includes(r.agent))
    .sort((a, b) => Number(b.fitness || 0) - Number(a.fitness || 0));

  if (activeRank.length < 2) return [];

  const best = activeRank[0];
  const weakest = activeRank[activeRank.length - 1];

  if (num(weakest.sampleCount) < limits.minSamplesForReplacement) return [];
  if (num(weakest.fitness) > limits.replaceFitnessThreshold) return [];
  if (num(best.fitness) - num(weakest.fitness) < limits.replaceGapThreshold) return [];

  const old = state.agents[weakest.agent] || createAgentProfile(weakest.agent, 1, 0);
  const oldGeneration = Number(old.generation || 1);
  const newGeneration = oldGeneration + 1;

  state.lifecycle.push({
    id: id('life'),
    ts: nowIso(),
    type: 'AGENT_RETIRED',
    agent: weakest.agent,
    retiredGeneration: oldGeneration,
    reason: `fitness=${num(weakest.fitness)} below threshold ${limits.replaceFitnessThreshold}`,
    sampleCount: weakest.sampleCount,
    bestAgent: best.agent,
    bestFitness: best.fitness
  });

  const replacements = num(old.stats?.replacements) + 1;
  state.agents[weakest.agent] = createAgentProfile(weakest.agent, newGeneration, replacements);

  state.lifecycle.push({
    id: id('life'),
    ts: nowIso(),
    type: 'AGENT_CREATED',
    agent: weakest.agent,
    generation: newGeneration,
    reason: `replacement_after_retirement_${oldGeneration}`
  });

  return [{
    agent: weakest.agent,
    retiredGeneration: oldGeneration,
    newGeneration
  }];
}

function pruneRetiredAgentOutputs(agentOutputs = [], retired = []) {
  if (!retired.length) return agentOutputs;
  const retiredSet = new Set(retired.map((r) => `${r.agent}#${r.retiredGeneration}`));
  return agentOutputs.filter((row) => {
    const gen = Number(row.agentGeneration || 1);
    return !retiredSet.has(`${row.agent}#${gen}`);
  });
}

function buildAgentMemoryOverview(state, agents = []) {
  return agents.map((agent) => {
    const p = state?.agents?.[agent] || {};
    return {
      agent,
      generation: Number(p.generation || 1),
      instanceId: p.instanceId || `${agent}#1`,
      experiences: Array.isArray(p.experiences) ? p.experiences.length : 0,
      summaries: Array.isArray(p.summaries) ? p.summaries.length : 0,
      longTerm: Array.isArray(p.longTerm) ? p.longTerm.length : 0,
      replacements: num(p.stats?.replacements)
    };
  });
}

module.exports = {
  ensureAgentMemoryState,
  getAgentGenerationByName,
  getLastReasonByAgent,
  appendDecisionExperiences,
  summarizeAndMaintain,
  pruneRetiredAgentOutputs,
  buildAgentMemoryOverview
};
