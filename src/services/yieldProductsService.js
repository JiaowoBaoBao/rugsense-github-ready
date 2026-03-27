const { round } = require('../utils/helpers');

let cache = {
  ts: 0,
  source: 'none',
  products: []
};

function nowMs() {
  return Date.now();
}

function normalizeText(v) {
  return String(v || '').trim().toLowerCase();
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildLiveConfig(cfg = {}) {
  const live = cfg?.yield?.liveProducts || {};
  return {
    enabled: live.enabled !== false,
    endpoint: String(live.endpoint || 'https://yields.llama.fi/pools'),
    timeoutMs: Math.max(2000, Number(live.timeoutMs || 8000)),
    cacheTtlMs: Math.max(10_000, Number(live.cacheTtlMs || 300_000)),
    staleTtlMs: Math.max(60_000, Number(live.staleTtlMs || 3_600_000)),
    minTvlUsd: Math.max(0, Number(live.minTvlUsd || 100_000)),
    maxRows: Math.max(20, Number(live.maxRows || 800))
  };
}

function estimateRiskScore(row, fallback = 30) {
  const ilRisk = normalizeText(row.ilRisk);
  const stablecoin = Boolean(row.stablecoin);
  const exposure = normalizeText(row.exposure);

  let score = Number(fallback);
  if (stablecoin) score -= 4;
  if (ilRisk.includes('no')) score -= 3;
  if (ilRisk.includes('yes')) score += 8;
  if (exposure.includes('single')) score -= 2;
  if (exposure.includes('multi')) score += 3;

  return Math.max(5, Math.min(85, Math.round(score)));
}

function matchWhitelistProduct(row, whitelist = []) {
  const project = normalizeText(row.project);
  const symbol = normalizeText(row.symbol);

  for (const w of whitelist) {
    const wProtocol = normalizeText(w.protocol);
    if (!project || !wProtocol) continue;

    const protocolMatch = project.includes(wProtocol) || wProtocol.includes(project);
    if (!protocolMatch) continue;

    const wSymbol = normalizeText(w.symbol);
    if (!wSymbol) return w;

    const symbolMatch = symbol === wSymbol
      || symbol.includes(wSymbol)
      || wSymbol.includes(symbol)
      || (wSymbol.includes('-') && wSymbol.split('-').every((p) => symbol.includes(p.trim())));

    if (symbolMatch) return w;
  }

  return null;
}

function mapToYieldProduct(row, whitelistHit) {
  const apyPct = toNumber(row.apy, toNumber(row.apyBase, 0) + toNumber(row.apyReward, 0));
  const protocol = whitelistHit?.protocol || String(row.project || 'Unknown');
  const symbol = String(row.symbol || whitelistHit?.symbol || 'UNKNOWN');
  const chain = String(row.chain || '').trim();
  const productId = String(row.pool || row.poolMeta || `${protocol}-${symbol}-${chain}`).replace(/\s+/g, '-').slice(0, 80);

  return {
    id: `live-${productId}`,
    category: whitelistHit?.category || 'stable_lending',
    protocol,
    symbol,
    apyPct: round(apyPct, 4),
    riskScore: estimateRiskScore(row, Number(whitelistHit?.riskScore || 30)),
    source: 'defillama',
    chain,
    tvlUsd: round(toNumber(row.tvlUsd, 0), 2),
    pool: String(row.pool || ''),
    url: String(row.url || '')
  };
}

async function fetchLiveProducts(cfg = {}) {
  const liveCfg = buildLiveConfig(cfg);
  if (!liveCfg.enabled) {
    return { ok: true, source: 'disabled', products: [] };
  }

  const ttlFresh = liveCfg.cacheTtlMs;
  const age = nowMs() - Number(cache.ts || 0);
  if (cache.ts && age <= ttlFresh && Array.isArray(cache.products) && cache.products.length) {
    return {
      ok: true,
      source: cache.source || 'cache',
      cacheHit: true,
      stale: false,
      products: cache.products
    };
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort('timeout'), liveCfg.timeoutMs);

  try {
    const resp = await fetch(liveCfg.endpoint, { method: 'GET', signal: ctrl.signal });
    if (!resp.ok) {
      throw new Error(`live yield source HTTP ${resp.status}`);
    }

    const body = await resp.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    const whitelist = Array.isArray(cfg?.yield?.whitelist) ? cfg.yield.whitelist : [];

    const out = rows
      .slice(0, liveCfg.maxRows)
      .map((row) => ({ row, hit: matchWhitelistProduct(row, whitelist) }))
      .filter((x) => x.hit)
      .map((x) => mapToYieldProduct(x.row, x.hit))
      .filter((x) => Number(x.apyPct || 0) > 0)
      .filter((x) => Number(x.tvlUsd || 0) >= liveCfg.minTvlUsd)
      .sort((a, b) => Number(b.apyPct || 0) - Number(a.apyPct || 0));

    cache = {
      ts: nowMs(),
      source: 'defillama',
      products: out
    };

    return {
      ok: true,
      source: 'defillama',
      cacheHit: false,
      stale: false,
      products: out
    };
  } catch (err) {
    const staleAge = nowMs() - Number(cache.ts || 0);
    if (cache.ts && staleAge <= liveCfg.staleTtlMs && Array.isArray(cache.products) && cache.products.length) {
      return {
        ok: true,
        source: cache.source || 'cache',
        cacheHit: true,
        stale: true,
        error: err.message,
        products: cache.products
      };
    }

    return {
      ok: false,
      source: 'defillama',
      cacheHit: false,
      stale: false,
      error: err.message,
      products: []
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  fetchLiveProducts
};
