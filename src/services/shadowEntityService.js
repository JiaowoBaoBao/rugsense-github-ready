const crypto = require('crypto');
const { nowIso, round } = require('../utils/helpers');

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function makeId(prefix, seed) {
  const s = String(seed || '').trim();
  const hex = crypto.createHash('sha256').update(`${prefix}:${s}`).digest('hex').slice(0, 12);
  return `${prefix}_${hex}`;
}

function ensureGraph(graph) {
  const base = graph && typeof graph === 'object' ? graph : {};
  if (!base.version) base.version = 1;
  if (!base.updatedAt) base.updatedAt = nowIso();
  if (!base.entities || typeof base.entities !== 'object') base.entities = {};
  if (!base.edges || typeof base.edges !== 'object') base.edges = {};
  if (!base.tokenProfiles || typeof base.tokenProfiles !== 'object') base.tokenProfiles = {};
  if (!Array.isArray(base.incidents)) base.incidents = [];
  return base;
}

function getFromSecurityRaw(securityRaw = {}) {
  const creator = securityRaw.creatorAddress || securityRaw.creator || securityRaw.ownerAddress || securityRaw.owner || null;
  const funder = securityRaw.funderAddress || securityRaw.funder || securityRaw.deployer || null;
  return { creator, funder };
}

function inferLineageIds({ decision, fingerprint }) {
  const chain = String(decision?.chain || 'unknown');
  const contract = String(decision?.contract || decision?.token || 'unknown');
  const token = String(decision?.token || contract);

  const sec = decision?.marketAtDecision?.securityRaw || {};
  const hints = getFromSecurityRaw(sec);

  const creatorSeed = hints.creator || `${chain}:${contract}`;

  // Make funder cluster partially shared so repeated patterns can be detected.
  const fallbackCluster = `${chain}:cluster:${crypto.createHash('sha256').update(contract).digest('hex').slice(0, 3)}`;
  const funderSeed = hints.funder || fallbackCluster;

  return {
    chain,
    token,
    contract,
    creatorId: makeId('creator', creatorSeed),
    funderId: makeId('funder', funderSeed),
    creatorLabel: hints.creator || `shadow_creator:${creatorSeed.slice(0, 12)}`,
    funderLabel: hints.funder || `shadow_funder_cluster:${funderSeed.slice(0, 18)}`,
    fingerprintId: fingerprint?.fingerprintId || null
  };
}

function upsertEntity(graph, id, patch = {}) {
  if (!graph.entities[id]) {
    graph.entities[id] = {
      id,
      type: patch.type || 'UNKNOWN',
      label: patch.label || id,
      firstSeen: nowIso(),
      lastSeen: nowIso(),
      total: 0,
      rugged: 0,
      rugRatePct: 0,
      tags: [],
      linkedTokens: []
    };
  }

  const node = graph.entities[id];
  node.type = patch.type || node.type;
  node.label = patch.label || node.label;
  node.lastSeen = nowIso();
  node.total = num(node.total) + 1;

  if (patch.verdict === 'RUG_TRUE') node.rugged = num(node.rugged) + 1;
  node.rugRatePct = round(node.total ? (node.rugged / node.total) * 100 : 0, 2);

  const addTag = (patch.tags || []).filter(Boolean);
  if (addTag.length) {
    const merged = new Set([...(node.tags || []), ...addTag]);
    node.tags = [...merged].slice(-12);
  }

  const token = patch.token;
  if (token) {
    const merged = new Set([...(node.linkedTokens || []), token]);
    node.linkedTokens = [...merged].slice(-20);
  }

  return node;
}

function upsertEdge(graph, from, to, token) {
  const key = `${from}->${to}`;
  if (!graph.edges[key]) {
    graph.edges[key] = {
      key,
      from,
      to,
      weight: 0,
      firstSeen: nowIso(),
      lastSeen: nowIso(),
      tokens: []
    };
  }

  const edge = graph.edges[key];
  edge.weight = num(edge.weight) + 1;
  edge.lastSeen = nowIso();
  if (token) {
    const merged = new Set([...(edge.tokens || []), token]);
    edge.tokens = [...merged].slice(-30);
  }
  return edge;
}

function updateTokenProfile(graph, ids, fingerprint, verify) {
  const key = `${ids.chain}:${ids.contract}`;
  if (!graph.tokenProfiles[key]) {
    graph.tokenProfiles[key] = {
      key,
      chain: ids.chain,
      token: ids.token,
      contract: ids.contract,
      creatorId: ids.creatorId,
      funderId: ids.funderId,
      firstSeen: nowIso(),
      lastSeen: nowIso(),
      totalChecks: 0,
      ruggedChecks: 0,
      ruggedRatePct: 0,
      lineageRiskScore: 0,
      lineageLabel: 'UNKNOWN',
      latestFingerprintId: null,
      taxonomyMix: { H: 0, L: 0, M: 0, S: 0 },
      dominantTaxonomy: 'UNKNOWN'
    };
  }

  const p = graph.tokenProfiles[key];
  p.lastSeen = nowIso();
  p.totalChecks = num(p.totalChecks) + 1;
  if (verify?.verdict === 'RUG_TRUE') p.ruggedChecks = num(p.ruggedChecks) + 1;
  p.ruggedRatePct = round(p.totalChecks ? (p.ruggedChecks / p.totalChecks) * 100 : 0, 2);

  const mix = fingerprint?.taxonomy?.mix || {};
  const prev = p.taxonomyMix || { H: 0, L: 0, M: 0, S: 0 };
  const n = p.totalChecks;
  p.taxonomyMix = {
    H: round(((prev.H * (n - 1)) + num(mix.H)) / n, 2),
    L: round(((prev.L * (n - 1)) + num(mix.L)) / n, 2),
    M: round(((prev.M * (n - 1)) + num(mix.M)) / n, 2),
    S: round(((prev.S * (n - 1)) + num(mix.S)) / n, 2)
  };

  const dominant = Object.entries(p.taxonomyMix).sort((a, b) => b[1] - a[1])[0] || ['UNKNOWN', 0];
  p.dominantTaxonomy = dominant[0];
  p.latestFingerprintId = fingerprint?.fingerprintId || p.latestFingerprintId;

  return p;
}

function refreshLineageRisk(graph, profile) {
  const funder = graph.entities[profile.funderId];
  const creator = graph.entities[profile.creatorId];

  const funderRugRate = num(funder?.rugRatePct, 0) / 100;
  const creatorRugRate = num(creator?.rugRatePct, 0) / 100;
  const sharedTokens = num((funder?.linkedTokens || []).length, 0);

  const recurrence = Math.min(1, sharedTokens / 10);
  const score = round((funderRugRate * 0.55 + creatorRugRate * 0.25 + recurrence * 0.2) * 100, 2);
  profile.lineageRiskScore = score;

  if (score >= 70) profile.lineageLabel = 'SCAM_SECOND_GEN';
  else if (score >= 45) profile.lineageLabel = 'SHADOW_CLUSTER_RISK';
  else if (score >= 25) profile.lineageLabel = 'WATCHLIST';
  else profile.lineageLabel = 'LOW_CLUSTER_RISK';

  return profile;
}

function updateShadowEntityGraph(graphRaw, { decision, verify, fingerprint }) {
  const graph = ensureGraph(graphRaw);
  const ids = inferLineageIds({ decision, fingerprint });

  const creator = upsertEntity(graph, ids.creatorId, {
    type: 'CREATOR',
    label: ids.creatorLabel,
    verdict: verify?.verdict,
    tags: fingerprint?.tags,
    token: ids.token
  });

  const funder = upsertEntity(graph, ids.funderId, {
    type: 'FUNDER',
    label: ids.funderLabel,
    verdict: verify?.verdict,
    tags: fingerprint?.tags,
    token: ids.token
  });

  upsertEdge(graph, ids.funderId, ids.creatorId, ids.token);

  const profile = updateTokenProfile(graph, ids, fingerprint, verify);
  refreshLineageRisk(graph, profile);

  graph.incidents.push({
    ts: nowIso(),
    token: ids.token,
    contract: ids.contract,
    decisionId: decision?.id,
    verifyId: verify?.id,
    creatorId: ids.creatorId,
    funderId: ids.funderId,
    lineageRiskScore: profile.lineageRiskScore,
    lineageLabel: profile.lineageLabel,
    dominantTaxonomy: profile.dominantTaxonomy,
    fingerprintId: fingerprint?.fingerprintId || null,
    verdict: verify?.verdict
  });
  graph.incidents = graph.incidents.slice(-200);
  graph.updatedAt = nowIso();

  return graph;
}

function summarizeShadowEntityGraph(graphRaw) {
  const graph = ensureGraph(graphRaw);
  const entities = Object.values(graph.entities || {});
  const profiles = Object.values(graph.tokenProfiles || {});

  const highRiskTokens = profiles
    .filter((p) => num(p.lineageRiskScore) >= 45)
    .sort((a, b) => num(b.lineageRiskScore) - num(a.lineageRiskScore))
    .slice(0, 20);

  const topFunders = entities
    .filter((e) => e.type === 'FUNDER')
    .sort((a, b) => num(b.rugRatePct) - num(a.rugRatePct) || num(b.total) - num(a.total))
    .slice(0, 20)
    .map((e) => ({
      id: e.id,
      label: e.label,
      total: e.total,
      rugged: e.rugged,
      rugRatePct: e.rugRatePct,
      linkedTokens: (e.linkedTokens || []).slice(0, 6).join(', ')
    }));

  const taxonomyMix = profiles.reduce((acc, p) => {
    acc.H += num(p.taxonomyMix?.H, 0);
    acc.L += num(p.taxonomyMix?.L, 0);
    acc.M += num(p.taxonomyMix?.M, 0);
    acc.S += num(p.taxonomyMix?.S, 0);
    return acc;
  }, { H: 0, L: 0, M: 0, S: 0 });

  const n = profiles.length || 1;
  const taxonomyAvg = {
    H: round(taxonomyMix.H / n, 2),
    L: round(taxonomyMix.L / n, 2),
    M: round(taxonomyMix.M / n, 2),
    S: round(taxonomyMix.S / n, 2)
  };

  const dominant = Object.entries(taxonomyAvg).sort((a, b) => b[1] - a[1])[0] || ['UNKNOWN', 0];

  return {
    updatedAt: graph.updatedAt,
    entityCount: entities.length,
    edgeCount: Object.keys(graph.edges || {}).length,
    profileCount: profiles.length,
    incidents: graph.incidents.slice(-50).reverse(),
    topFunders,
    highRiskTokens,
    taxonomyAvg,
    dominantTaxonomy: dominant[0],
    dominantTaxonomyPct: dominant[1]
  };
}

module.exports = {
  ensureGraph,
  updateShadowEntityGraph,
  summarizeShadowEntityGraph
};
