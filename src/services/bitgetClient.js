const crypto = require('crypto');
const defaultConfig = require('../config/default');
const { round, hashToUnit } = require('../utils/helpers');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) return 0;
  return Math.max(0, t - Date.now());
}

function newDomainState() {
  return {
    total: 0,
    success: 0,
    failed: 0,
    consecutiveFailures: 0,
    lastError: null,
    lastOkAt: null,
    lastFailAt: null,
    lastLatencyMs: null,
    circuitOpenUntilMs: 0
  };
}

class BitgetClient {
  constructor(config = defaultConfig.bitget) {
    this.config = config;
    this.baseUrl = config.baseUrl;
    this.reliability = {
      timeoutMs: Number(config?.reliability?.timeoutMs || 9000),
      retries: Number(config?.reliability?.retries || 2),
      retryBackoffMs: Number(config?.reliability?.retryBackoffMs || 350),
      retryMaxBackoffMs: Number(config?.reliability?.retryMaxBackoffMs || 4000),
      retryJitterMs: Number(config?.reliability?.retryJitterMs || 180),
      circuitBreakerFailures: Number(config?.reliability?.circuitBreakerFailures || 4),
      circuitBreakerCooldownMs: Number(config?.reliability?.circuitBreakerCooldownMs || 45_000),
      signalCacheTtlMs: Number(config?.reliability?.signalCacheTtlMs || 15_000),
      signalStaleTtlMs: Number(config?.reliability?.signalStaleTtlMs || 120_000),
      signalCacheMaxEntries: Number(config?.reliability?.signalCacheMaxEntries || 1000),
      minSignalParts: Number(config?.reliability?.minSignalParts || 3)
    };

    this.health = {
      market: newDomainState(),
      launchpad: newDomainState(),
      other: newDomainState()
    };

    this.signalCache = new Map();
  }

  sign(method, path, bodyStr, ts) {
    const msg = `${method}${path}${bodyStr}${ts}`;
    return `0x${crypto.createHash('sha256').update(msg).digest('hex')}`;
  }

  getDomain(domain) {
    const name = String(domain || 'other').toLowerCase();
    if (!this.health[name]) this.health[name] = newDomainState();
    return this.health[name];
  }

  domainFromPath(path) {
    if (String(path).includes('/launchpad/')) return 'launchpad';
    if (String(path).includes('/market/')) return 'market';
    return 'other';
  }

  isCircuitOpen(domain) {
    const d = this.getDomain(domain);
    return Date.now() < Number(d.circuitOpenUntilMs || 0);
  }

  markSuccess(domain, latencyMs) {
    const d = this.getDomain(domain);
    d.total += 1;
    d.success += 1;
    d.consecutiveFailures = 0;
    d.lastError = null;
    d.lastOkAt = new Date().toISOString();
    d.lastLatencyMs = Math.round(latencyMs);
  }

  markFailure(domain, err, latencyMs) {
    const d = this.getDomain(domain);
    d.total += 1;
    d.failed += 1;
    d.consecutiveFailures += 1;
    d.lastError = String(err?.message || err || 'unknown');
    d.lastFailAt = new Date().toISOString();
    d.lastLatencyMs = Math.round(latencyMs);

    if (d.consecutiveFailures >= this.reliability.circuitBreakerFailures) {
      d.circuitOpenUntilMs = Date.now() + this.reliability.circuitBreakerCooldownMs;
    }
  }

  computeRetryDelayMs(attempt, err) {
    const exp = this.reliability.retryBackoffMs * (2 ** Math.max(0, attempt - 1));
    const capped = Math.min(exp, this.reliability.retryMaxBackoffMs);
    const jitter = Math.random() * Math.max(0, this.reliability.retryJitterMs);
    const retryAfterMs = Math.max(0, Number(err?.retryAfterMs || 0));
    return Math.max(retryAfterMs, Math.round(capped + jitter));
  }

  getSignalCacheKey({ chain, contract }) {
    return `${String(chain || '').toLowerCase()}::${String(contract || '').toLowerCase()}`;
  }

  getCachedSignal({ chain, contract }) {
    const key = this.getSignalCacheKey({ chain, contract });
    const row = this.signalCache.get(key);
    if (!row) return null;
    return {
      key,
      ...row,
      ageMs: Math.max(0, Date.now() - Number(row.ts || 0))
    };
  }

  setCachedSignal({ chain, contract, data }) {
    const key = this.getSignalCacheKey({ chain, contract });
    this.signalCache.set(key, {
      ts: Date.now(),
      data
    });

    const maxEntries = Math.max(100, Number(this.reliability.signalCacheMaxEntries || 1000));
    while (this.signalCache.size > maxEntries) {
      const oldest = this.signalCache.keys().next().value;
      if (oldest === undefined) break;
      this.signalCache.delete(oldest);
    }
  }

  async post(path, body = {}, options = {}) {
    const domain = options.domain || this.domainFromPath(path);
    if (this.isCircuitOpen(domain)) {
      const d = this.getDomain(domain);
      const err = new Error(`Bitget ${domain} circuit open until ${new Date(d.circuitOpenUntilMs).toISOString()}`);
      err.circuitOpen = true;
      err.retryable = true;
      throw err;
    }

    const maxAttempts = Math.max(1, this.reliability.retries + 1);
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      const ts = Date.now().toString();
      const bodyStr = JSON.stringify(body);
      const sign = this.sign('POST', path, bodyStr, ts);
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort('timeout'), this.reliability.timeoutMs);

      try {
        const resp = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.config.headers,
            'X-SIGN': sign,
            'X-TIMESTAMP': ts
          },
          body: bodyStr,
          signal: ctrl.signal
        });

        clearTimeout(timeout);

        if (!resp.ok) {
          const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'));
          const txt = await resp.text();
          const err = new Error(`Bitget ${path} HTTP ${resp.status}: ${txt.slice(0, 180)}`);
          err.status = resp.status;
          err.retryAfterMs = retryAfterMs;
          err.retryable = resp.status >= 500 || [408, 409, 425, 429].includes(resp.status);
          throw err;
        }

        const out = await resp.json();
        this.markSuccess(domain, Date.now() - started);
        return out;
      } catch (err) {
        clearTimeout(timeout);
        err.retryable = err.retryable ?? (
          err.name === 'AbortError'
          || /fetch failed/i.test(String(err.message || ''))
          || /network/i.test(String(err.message || ''))
        );

        const isLastAttempt = attempt >= maxAttempts;
        if (!err.retryable || isLastAttempt) {
          this.markFailure(domain, err, Date.now() - started);
          lastErr = err;
          break;
        }

        lastErr = err;
        await sleep(this.computeRetryDelayMs(attempt, err));
      }
    }

    throw lastErr || new Error(`Bitget ${path} request failed`);
  }

  getHealth() {
    const now = Date.now();
    const format = (name, d) => ({
      domain: name,
      total: d.total,
      success: d.success,
      failed: d.failed,
      successRate: d.total ? round((d.success / d.total) * 100, 2) : null,
      consecutiveFailures: d.consecutiveFailures,
      lastError: d.lastError,
      lastOkAt: d.lastOkAt,
      lastFailAt: d.lastFailAt,
      lastLatencyMs: d.lastLatencyMs,
      circuitOpen: now < Number(d.circuitOpenUntilMs || 0),
      circuitOpenUntil: d.circuitOpenUntilMs ? new Date(d.circuitOpenUntilMs).toISOString() : null
    });

    return {
      market: format('market', this.getDomain('market')),
      launchpad: format('launchpad', this.getDomain('launchpad')),
      other: format('other', this.getDomain('other'))
    };
  }

  async getMarketInfo(chain, contract) {
    return this.post('/market/v3/coin/getMarketInfo', { chain, contract }, { domain: 'market' });
  }

  async getKline(chain, contract, period = '1m', size = 30) {
    return this.post('/market/v3/coin/getKline', { chain, contract, period, size }, { domain: 'market' });
  }

  async getTxInfo(chain, contract) {
    return this.post('/market/v3/coin/getTxInfo', { chain, contract }, { domain: 'market' });
  }

  async getLiquidity(chain, contract) {
    return this.post('/market/v3/poolList', { chain, contract }, { domain: 'market' });
  }

  async getSecurity(chain, contract) {
    return this.post('/market/v3/coin/security/audits', {
      list: [{ chain, contract }],
      source: 'bg'
    }, { domain: 'market' });
  }

  async getLaunchpadTokens({
    chain = 'sol',
    limit = 100,
    stage,
    ageMax,
    lpMin,
    keywords
  } = {}) {
    const body = { chain, limit };
    if (stage !== undefined && stage !== null && stage !== '') body.stage = Number(stage);
    if (ageMax !== undefined && ageMax !== null && ageMax !== '') body.age_max = Number(ageMax);
    if (lpMin !== undefined && lpMin !== null && lpMin !== '') body.lp_min = Number(lpMin);
    if (keywords) body.keywords = String(keywords);
    return this.post('/market/v3/launchpad/tokens', body, { domain: 'launchpad' });
  }

  async getQuote({ fromAddress, fromChain, fromSymbol, fromContract, fromAmount, toChain, toSymbol, toContract }) {
    return this.post('/swap-go/swapx/quote', {
      fromAddress,
      fromChain,
      fromSymbol,
      fromContract,
      fromAmount,
      toChain,
      toSymbol,
      toContract: toContract || '',
      tab_type: 'swap',
      publicKey: '',
      slippage: '',
      toAddress: fromAddress,
      requestId: Date.now().toString()
    }, { domain: 'other' });
  }

  syntheticMarket(contract = 'UNKNOWN') {
    const u = hashToUnit(`${contract}_${Math.floor(Date.now() / 60_000)}`);
    const basePrice = 0.0002 + u * 0.02;
    const liquidityUsd = 10_000 + u * 250_000;
    const riskScore = round(20 + u * 70, 2);
    const priceDelta1mPct = round((u - 0.5) * 12, 3);

    return {
      synthetic: true,
      price: round(basePrice, 8),
      liquidityUsd: round(liquidityUsd, 2),
      riskScore,
      priceDelta1mPct,
      tvlDrop1hPct: round(Math.max(0, (u - 0.65) * 60), 3),
      txAnomalyScore: round(u * 100, 2),
      dataQuality: 'synthetic',
      stale: false
    };
  }

  normalizeMarket({ contract, marketInfo, kline, txInfo, liquidity, security }) {
    const securityItem = security?.data?.list?.[0] || {};
    const riskCount = Number(securityItem.riskCount || 0);
    const highRisk = Number(securityItem.highRisk || 0);

    const market = marketInfo?.data || {};

    const klineList = kline?.data?.list || kline?.data || [];
    const recent = Array.isArray(klineList) ? klineList.slice(-2) : [];
    let priceDelta1mPct = 0;
    if (recent.length === 2) {
      const p0 = Number(recent[0]?.close || recent[0]?.c || recent[0]?.[4] || 0);
      const p1 = Number(recent[1]?.close || recent[1]?.c || recent[1]?.[4] || 0);
      if (p0 > 0) priceDelta1mPct = ((p1 - p0) / p0) * 100;
    }

    const klineLatest = Array.isArray(klineList) && klineList.length
      ? Number(klineList[klineList.length - 1]?.close || klineList[klineList.length - 1]?.c || klineList[klineList.length - 1]?.[4] || 0)
      : 0;

    const lastPrice = Number(market.price || market.last || klineLatest || 0);

    const poolList = liquidity?.data?.list || [];
    const firstPool = poolList[0] || {};
    const liquidityUsd = Number(firstPool.liquidity || market.liquidity || 0);

    const txData = txInfo?.data || {};
    const buyVol = Number(txData.buyVolume || txData.buy_amount || 0);
    const sellVol = Number(txData.sellVolume || txData.sell_amount || 0);
    const imbalance = buyVol + sellVol > 0 ? Math.abs(buyVol - sellVol) / (buyVol + sellVol) : 0;

    const riskScore = Math.min(100, round(highRisk * 25 + riskCount * 6 + imbalance * 35 + Math.max(0, -priceDelta1mPct) * 1.2, 2));

    const tvlDrop1hPct = round(Math.max(0, Number(firstPool?.tvlDrop1hPct || 0)), 2);

    return {
      synthetic: false,
      contract,
      price: lastPrice > 0 ? round(lastPrice, 8) : null,
      liquidityUsd: round(liquidityUsd, 2),
      riskScore,
      priceDelta1mPct: round(priceDelta1mPct, 3),
      tvlDrop1hPct,
      txAnomalyScore: round(imbalance * 100, 2),
      securityRaw: securityItem,
      stale: false
    };
  }

  async getTokenSignals({ chain, contract }) {
    const cached = this.getCachedSignal({ chain, contract });
    if (cached && cached.ageMs <= this.reliability.signalCacheTtlMs) {
      return {
        ...cached.data,
        stale: false,
        cacheHit: true,
        cacheAgeMs: cached.ageMs
      };
    }

    try {
      const settled = await Promise.allSettled([
        this.getMarketInfo(chain, contract),
        this.getKline(chain, contract, '1m', 30),
        this.getTxInfo(chain, contract),
        this.getLiquidity(chain, contract),
        this.getSecurity(chain, contract)
      ]);

      const okCount = settled.filter((r) => r.status === 'fulfilled').length;
      if (okCount < Math.max(1, this.reliability.minSignalParts)) {
        const reasons = settled
          .filter((r) => r.status === 'rejected')
          .map((r) => r.reason?.message || String(r.reason || 'unknown'))
          .slice(0, 2)
          .join(' | ');
        throw new Error(`insufficient upstream coverage (${okCount}/${settled.length})${reasons ? `: ${reasons}` : ''}`);
      }

      const [marketInfo, kline, txInfo, liquidity, security] = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
      const normalized = this.normalizeMarket({ contract, marketInfo, kline, txInfo, liquidity, security });
      if (!normalized.price) throw new Error('Missing price from Bitget response');

      const out = {
        ...normalized,
        dataQuality: okCount === settled.length ? 'real' : 'partial',
        upstreamCoverage: {
          ok: okCount,
          total: settled.length
        }
      };

      this.setCachedSignal({ chain, contract, data: out });
      return out;
    } catch (err) {
      if (cached && cached.ageMs <= this.reliability.signalStaleTtlMs) {
        return {
          ...cached.data,
          stale: true,
          cacheHit: true,
          cacheAgeMs: cached.ageMs,
          dataQuality: cached.data?.dataQuality === 'real' ? 'stale' : 'stale_partial',
          fallback: 'last_good',
          error: err.message
        };
      }

      return {
        ...this.syntheticMarket(contract),
        fallback: 'synthetic',
        error: err.message
      };
    }
  }
}

module.exports = { BitgetClient };
