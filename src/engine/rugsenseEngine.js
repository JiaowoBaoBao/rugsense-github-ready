const defaultConfig = require('../config/default');
const db = require('../store/db');
const { id, nowIso, round, hashToUnit } = require('../utils/helpers');
const { BitgetClient } = require('../services/bitgetClient');
const { AGENTS, runThreeAgentAnalysis } = require('../services/analysisService');
const { runVote, normalizeVote } = require('../services/voteService');
const { evaluateRug, buildVerificationRecord } = require('../services/verificationService');
const { createX402RewardReceipt } = require('../services/x402Service');
const { runYieldDeployment, runYieldRiskCheck } = require('../services/yieldAgentService');
const { fetchLiveProducts } = require('../services/yieldProductsService');
const { computeFitness } = require('../services/evolutionService');
const {
  ensureAgentMemoryState,
  getAgentGenerationByName,
  getLastReasonByAgent,
  appendDecisionExperiences,
  summarizeAndMaintain,
  pruneRetiredAgentOutputs,
  buildAgentMemoryOverview
} = require('../services/agentMemoryService');
const {
  ensureSimAccount,
  recomputeFromPositions,
  canOpen,
  reserveForOpen,
  settleClose
} = require('../services/simAccountService');
const { buildDecisionExplanation } = require('../services/decisionExplainService');
const { runBacktestSummary, regressionChecks } = require('../services/backtestService');
const { buildFraudFingerprint, attachSimilarCases, summarizeFraudFingerprints } = require('../services/fraudFingerprintService');
const { ensureGraph, updateShadowEntityGraph, summarizeShadowEntityGraph } = require('../services/shadowEntityService');

class RugSenseEngine {
  constructor() {
    db.ensureFiles();
    const initialConfig = db.read('config');
    this.bitget = new BitgetClient(initialConfig?.bitget || defaultConfig.bitget);
    this.verificationTimers = new Map();
    this.intervals = [];
    this.launchpadCache = {
      ts: 0,
      key: '',
      data: null
    };
    this.autoAnalyzeRunning = false;
    this.autoAnalyzeRecentByContract = new Map();
    this.schedulerLocks = {
      collector: false,
      monitor: false,
      evolution: false,
      autoAnalyze: false
    };
    this.schedulerSkipLogAt = {
      collector: 0,
      monitor: 0,
      evolution: 0,
      autoAnalyze: 0
    };
  }

  getConfig() {
    return db.read('config');
  }

  setConfig(patch) {
    const next = db.updateConfig(patch);

    if (patch && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'bitget')) {
      this.bitget = new BitgetClient(next?.bitget || defaultConfig.bitget);
      db.pushEvent('BITGET_CLIENT_RELOADED', {
        source: 'setConfig',
        reason: 'BITGET_CONFIG_UPDATED'
      });
    }

    db.pushEvent('CONFIG_UPDATED', { patch, next });
    return next;
  }

  setKillSwitch(enabled) {
    const next = db.updateConfig({ yield: { killSwitch: !!enabled } });
    db.pushEvent('KILL_SWITCH_UPDATED', { enabled: !!enabled });
    return next;
  }

  setDemoMode(enabled) {
    const cfg = this.getConfig();
    const presets = cfg?.runtime?.demoPresets || {};
    const target = enabled ? presets.demo : presets.safe;

    const patch = {
      runtime: {
        demoMode: Boolean(enabled)
      }
    };

    if (target?.autoAnalyze && typeof target.autoAnalyze === 'object') {
      patch.runtime.autoAnalyze = target.autoAnalyze;
    }

    if (target?.simulation && typeof target.simulation === 'object') {
      patch.simulation = target.simulation;
    }

    if (target?.yield && typeof target.yield === 'object') {
      patch.yield = target.yield;
    }

    const next = this.setConfig(patch);
    db.pushEvent('DEMO_MODE_UPDATED', {
      enabled: Boolean(enabled),
      mode: enabled ? 'demo' : 'safe',
      solMaxSlippagePct: this.getMaxSlippagePctForChain(next, 'sol'),
      solMinLiquidityUsd: this.getMinLiquidityUsdForChain(next, 'sol')
    });

    return {
      enabled: Boolean(next?.runtime?.demoMode),
      mode: next?.runtime?.demoMode ? 'demo' : 'safe',
      solMaxSlippagePct: this.getMaxSlippagePctForChain(next, 'sol'),
      solMinLiquidityUsd: this.getMinLiquidityUsdForChain(next, 'sol'),
      yieldAllocationMode: next?.yield?.allocationMode || 'reward_only',
      yieldBalanceReinvestPct: Number(next?.yield?.balanceReinvestPct || 0),
      autoAnalyze: this.getAutoAnalyzeConfig(next)
    };
  }

  async runDemoScenario() {
    const cfg = this.getConfig();
    const demoPreset = cfg?.runtime?.demoPresets?.demo || {};
    const launchpadPreset = demoPreset?.launchpad || {};

    const scan = await this.getSolLaunchpadScan({
      limit: Number(launchpadPreset.limit || 30),
      ageMaxSec: Number(launchpadPreset.ageMaxSec || 7200),
      minLiquidityUsd: Number(launchpadPreset.minLiquidityUsd || 0),
      hideHighRisk: launchpadPreset.hideHighRisk ? 1 : 0,
      keyword: ''
    });

    const candidates = (scan.items || [])
      .filter((x) => x && x.contract && !String(x.contract).startsWith('synthetic_'))
      .slice(0, 5);

    if (!candidates.length) {
      throw new Error('No launchpad candidates available for demo scenario');
    }

    const attempts = [];
    for (const row of candidates) {
      const out = await this.analyzeAndVote({
        token: String(row.symbol || row.contract),
        contract: String(row.contract),
        chain: 'sol',
        orderPct: Number(demoPreset.orderPct || cfg?.simulation?.defaultOrderPct || 1),
        userVotes: ['BUY', 'BUY']
      });

      const verify = await this.runVerification(out.decision.id);
      let reward = db.read('x402_rewards').find((r) => r.decisionId === out.decision.id) || null;

      let demoRewardForced = false;
      if (!reward && cfg?.runtime?.demoMode && out.decision.decision === 'NO_TRADE' && verify?.verdict === 'RUG_TRUE') {
        const demoCfg = JSON.parse(JSON.stringify(cfg));
        demoCfg.reward.dailyRewardCapCount = Number.MAX_SAFE_INTEGER;
        demoCfg.reward.tokenCooldownHours = 0;
        await this.triggerNoTradeReward(out.decision, verify, demoCfg);
        reward = db.read('x402_rewards').find((r) => r.decisionId === out.decision.id) || null;
        demoRewardForced = Boolean(reward);
      }

      const yieldOrder = reward
        ? db.read('yield_orders').find((o) => o.rewardId === reward.id) || null
        : null;

      const result = {
        token: out.decision.token,
        contract: out.decision.contract,
        decisionId: out.decision.id,
        decision: out.decision.decision,
        hardFilter: out.decision.hardFilter || null,
        verifyVerdict: verify?.verdict || null,
        rewardId: reward?.id || null,
        yieldOrderId: yieldOrder?.id || null,
        demoRewardForced
      };

      attempts.push(result);

      if (result.decision === 'NO_TRADE' && result.verifyVerdict === 'RUG_TRUE' && result.rewardId) {
        break;
      }
    }

    const best = attempts.find((x) => x.decision === 'NO_TRADE' && x.verifyVerdict === 'RUG_TRUE' && x.rewardId)
      || attempts[0];

    db.pushEvent('DEMO_SCENARIO_RUN', {
      attempts: attempts.length,
      selectedToken: best?.token || null,
      selectedDecision: best?.decision || null,
      selectedVerifyVerdict: best?.verifyVerdict || null,
      rewardTriggered: Boolean(best?.rewardId)
    });

    return {
      ok: true,
      attempts,
      selected: best,
      degraded: Boolean(scan.degraded),
      scannedCount: Number(scan.count || 0)
    };
  }

  buildDemoReport() {
    const state = this.getState();
    return {
      generatedAt: nowIso(),
      app: state.app,
      mode: state.config?.runtime?.demoMode ? 'demo' : 'safe',
      kpis: state.kpis,
      noTradeReasonSummary: state.noTradeReasonSummary,
      rewardSummary: state.rewardSummary,
      latestDecision: state.latestDecision,
      backtest: state.backtest,
      counts: state.counts,
      rows: {
        decisions: state.recentDecisions || [],
        verifications: state.verifyResults || [],
        rewards: state.rewards || [],
        yieldOrders: state.yieldOrders || [],
        events: state.events || []
      }
    };
  }

  getAgentMemoryState() {
    const current = db.read('agent_memory');
    const next = ensureAgentMemoryState(current, AGENTS);

    const currentHasAllAgents = AGENTS.every((a) => current?.agents?.[a]);
    const currentShapeOk = Boolean(current?.version && current?.updatedAt && Array.isArray(current?.lifecycle) && currentHasAllAgents);

    if (!currentShapeOk) {
      db.write('agent_memory', next);
    }
    return next;
  }

  updateAgentMemoryState(next) {
    const ensured = ensureAgentMemoryState(next, AGENTS);
    db.write('agent_memory', ensured);
    return ensured;
  }

  getSimAccountState(cfg = this.getConfig()) {
    const current = db.read('sim_account');
    const ensured = ensureSimAccount(current, cfg);
    const shapeOk = current && typeof current === 'object' && Number.isFinite(Number(current.availableUsdc));

    if (!shapeOk) {
      db.write('sim_account', ensured);
    }

    return ensured;
  }

  updateSimAccountState(next, cfg = this.getConfig()) {
    const ensured = ensureSimAccount(next, cfg);
    db.write('sim_account', ensured);
    return ensured;
  }

  recomputeAndPersistSimAccount(cfg = this.getConfig()) {
    const positions = db.read('sim_positions');
    const account = this.getSimAccountState(cfg);
    const recomputed = recomputeFromPositions(account, positions, cfg);
    return this.updateSimAccountState(recomputed, cfg);
  }

  getShadowEntityGraph() {
    const current = db.read('shadow_entity_graph');
    const ensured = ensureGraph(current);
    const shapeOk = current && typeof current === 'object' && current.entities && current.edges && current.tokenProfiles;
    if (!shapeOk) {
      db.write('shadow_entity_graph', ensured);
    }
    return ensured;
  }

  updateShadowEntityGraph(next) {
    const ensured = ensureGraph(next);
    db.write('shadow_entity_graph', ensured);
    return ensured;
  }

  getAutoAnalyzeConfig(cfg = this.getConfig()) {
    const aa = cfg?.runtime?.autoAnalyze || {};
    return {
      enabled: Boolean(aa.enabled),
      intervalMs: Math.max(30_000, Number(aa.intervalMs || 300_000)),
      candidatesPerRun: Math.max(1, Math.min(5, Number(aa.candidatesPerRun || 1))),
      launchpadFetchLimit: Math.max(10, Math.min(80, Number(aa.launchpadFetchLimit || 20))),
      ageMaxSec: Number(aa.ageMaxSec ?? 1800),
      minLiquidityUsd: Math.max(0, Number(aa.minLiquidityUsd ?? 20_000)),
      hideHighRisk: aa.hideHighRisk !== false,
      allowDegraded: Boolean(aa.allowDegraded),
      allowSyntheticCandidates: Boolean(aa.allowSyntheticCandidates),
      candidateCooldownMs: Math.max(60_000, Number(aa.candidateCooldownMs || 1_800_000)),
      userVotes: Array.isArray(aa.userVotes) && aa.userVotes.length >= 2
        ? [normalizeVote(aa.userVotes[0]), normalizeVote(aa.userVotes[1])]
        : ['NO_BUY', 'NO_BUY'],
      orderPct: Math.max(0.1, Number(aa.orderPct || cfg?.simulation?.defaultOrderPct || 1)),
      tickMs: Math.max(10_000, Number(aa.tickMs || 30_000))
    };
  }

  toggleAutoAnalyze(enabled) {
    const next = this.setConfig({ runtime: { autoAnalyze: { enabled: Boolean(enabled) } } });
    const state = db.read('runtime');
    const autoAnalyze = {
      ...(state.autoAnalyze || {}),
      enabled: Boolean(enabled),
      updatedAt: nowIso()
    };
    db.upsertRuntime({ autoAnalyze });
    db.pushEvent('AUTO_ANALYZE_TOGGLED', { enabled: Boolean(enabled) });
    return next.runtime.autoAnalyze;
  }

  shouldSkipAutoCandidate(contract, cooldownMs) {
    const key = String(contract || '').trim();
    if (!key) return true;
    const last = Number(this.autoAnalyzeRecentByContract.get(key) || 0);
    if (!last) return false;
    return Date.now() - last < cooldownMs;
  }

  markAutoCandidate(contract) {
    const key = String(contract || '').trim();
    if (!key) return;
    this.autoAnalyzeRecentByContract.set(key, Date.now());
  }

  async runAutoAnalyzeCycle({ manual = false } = {}) {
    const cfg = this.getConfig();
    const aa = this.getAutoAnalyzeConfig(cfg);

    if (!manual && !aa.enabled) {
      return { ok: true, skipped: 'AUTO_ANALYZE_DISABLED', analyzed: [] };
    }

    if (this.autoAnalyzeRunning) {
      return { ok: true, skipped: 'AUTO_ANALYZE_BUSY', analyzed: [] };
    }

    this.autoAnalyzeRunning = true;
    try {
      const scan = await this.getSolLaunchpadScan({
        limit: aa.launchpadFetchLimit,
        ageMaxSec: aa.ageMaxSec,
        minLiquidityUsd: aa.minLiquidityUsd,
        hideHighRisk: aa.hideHighRisk ? 1 : 0,
        keyword: ''
      });

      if (scan.degraded && !aa.allowDegraded) {
        const meta = {
          enabled: aa.enabled,
          running: false,
          lastRunAt: nowIso(),
          analyzedCount: 0,
          analyzedTokens: [],
          skipped: 'DEGRADED_SCAN_DISALLOWED',
          degraded: true,
          error: scan.error || null
        };
        db.upsertRuntime({ autoAnalyze: meta });
        db.pushEvent('AUTO_ANALYZE_SKIPPED', meta);
        return { ok: true, skipped: meta.skipped, analyzed: [] };
      }

      const analyzed = [];
      for (const row of scan.items || []) {
        if (analyzed.length >= aa.candidatesPerRun) break;

        const contract = String(row.contract || '').trim();
        const symbol = String(row.symbol || contract || '').trim();
        if (!contract || !symbol) continue;

        const synthetic = contract.startsWith('synthetic_');
        if (synthetic && !aa.allowSyntheticCandidates) continue;
        if (this.shouldSkipAutoCandidate(contract, aa.candidateCooldownMs)) continue;

        const out = await this.analyzeAndVote({
          token: symbol,
          contract,
          chain: 'sol',
          orderPct: aa.orderPct,
          userVotes: aa.userVotes
        });

        analyzed.push({
          token: symbol,
          contract,
          decision: out?.decision?.decision || 'UNKNOWN',
          hardFilter: out?.decision?.hardFilter || null,
          synthetic
        });
        this.markAutoCandidate(contract);
      }

      const meta = {
        enabled: aa.enabled,
        running: false,
        lastRunAt: nowIso(),
        analyzedCount: analyzed.length,
        analyzedTokens: analyzed.map((x) => x.token),
        skipped: analyzed.length ? null : 'NO_ELIGIBLE_CANDIDATES',
        degraded: Boolean(scan.degraded),
        error: scan.error || null
      };

      db.upsertRuntime({ autoAnalyze: meta });
      db.pushEvent('AUTO_ANALYZE_RUN', {
        ...meta,
        manual,
        candidatesPerRun: aa.candidatesPerRun,
        analyzed
      });

      return { ok: true, analyzed, skipped: meta.skipped || null };
    } catch (err) {
      const meta = {
        enabled: aa.enabled,
        running: false,
        lastRunAt: nowIso(),
        analyzedCount: 0,
        analyzedTokens: [],
        skipped: 'AUTO_ANALYZE_ERROR',
        degraded: null,
        error: err.message
      };
      db.upsertRuntime({ autoAnalyze: meta });
      db.pushEvent('AUTO_ANALYZE_ERROR', { error: err.message });
      throw err;
    } finally {
      this.autoAnalyzeRunning = false;
    }
  }

  async autoAnalyzeTick() {
    const cfg = this.getConfig();
    const aa = this.getAutoAnalyzeConfig(cfg);
    if (!aa.enabled) return;

    const runtime = db.read('runtime');
    const lastRunAtMs = runtime?.autoAnalyze?.lastRunAt
      ? new Date(runtime.autoAnalyze.lastRunAt).getTime()
      : 0;

    if (lastRunAtMs && Date.now() - lastRunAtMs < aa.intervalMs) return;

    await this.runAutoAnalyzeCycle({ manual: false });
  }

  topUpSimAccount(amountUsdc) {
    const cfg = this.getConfig();
    const amount = Number(amountUsdc);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('topup amountUsdc must be a positive number');
    }

    const before = this.getSimAccountState(cfg);
    const positions = db.read('sim_positions');

    const afterRaw = {
      ...before,
      availableUsdc: round(Number(before.availableUsdc || 0) + amount, 6)
    };

    const after = recomputeFromPositions(afterRaw, positions, cfg);
    const persisted = this.updateSimAccountState(after, cfg);

    db.pushEvent('SIM_ACCOUNT_TOPUP', {
      amountUsdc: round(amount, 6),
      beforeAvailableUsdc: before.availableUsdc,
      afterAvailableUsdc: persisted.availableUsdc,
      beforePaused: Boolean(before.tradingPaused),
      afterPaused: Boolean(persisted.tradingPaused),
      pauseReason: persisted.pauseReason || null
    });

    return persisted;
  }

  toNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  toIssueMs(v) {
    const n = this.toNumber(v, 0);
    if (!n) return 0;
    return n > 1e12 ? n : n * 1000;
  }

  normalizeLaunchpadToken(row = {}) {
    const issueMs = this.toIssueMs(row.issue_date || row.issueDate || row.createdAt || row.createTime || 0);
    const now = Date.now();
    const ageSec = issueMs > 0 ? Math.max(0, Math.floor((now - issueMs) / 1000)) : null;

    const liquidityUsd = this.toNumber(row.liquidity || row.liquidity_usd || row.lp || row.lp_usd || 0);
    const marketCapUsd = this.toNumber(row.market_cap || row.marketCap || row.market_cap_usd || 0);
    const volumeUsd = this.toNumber(row.turnover || row.volume || row.volume_usd || row.vol || 0);
    const holders = this.toNumber(row.holders || row.holder_count || 0);

    const sniperRaw = this.toNumber(row.sniper_percent || row.sniper_holding_percent || 0);
    const devRugRaw = this.toNumber(row.dev_rug_percent || 0);
    const rugStatus = this.toNumber(row.rug_status, 0);

    const sniperPct = sniperRaw <= 1 ? sniperRaw * 100 : sniperRaw;
    const devRugPct = devRugRaw <= 1 ? devRugRaw * 100 : devRugRaw;

    const riskLevel = rugStatus === 1 || devRugPct >= 50 || sniperPct >= 40 ? 'HIGH' : devRugPct >= 20 ? 'MEDIUM' : 'LOW';

    return {
      symbol: row.symbol || 'UNKNOWN',
      name: row.name || row.symbol || 'Unknown token',
      contract: row.contract || row.address || '',
      chain: row.chain || 'sol',
      platform: row.platform || row.launchpad || 'unknown',
      issueMs,
      ageSec,
      liquidityUsd: round(liquidityUsd, 2),
      marketCapUsd: round(marketCapUsd, 2),
      volumeUsd: round(volumeUsd, 2),
      holders: Math.round(holders),
      progress: this.toNumber(row.progress, null),
      price: this.toNumber(row.price, null),
      riskLevel,
      rugStatus,
      sniperPct: round(sniperPct, 2),
      devRugPct: round(devRugPct, 2)
    };
  }

  syntheticLaunchpadSol(limit = 15) {
    const seeds = ['SOLCAT', 'BONKU', 'RAYX', 'FROGSOL', 'MANGO2', 'PUMPY', 'WAVE', 'MOONZ', 'LSTR', 'JITOX'];
    return seeds.slice(0, Math.max(5, limit)).map((s, idx) => {
      const u = hashToUnit(`${s}_${Math.floor(Date.now() / 120000)}`);
      const ageSec = Math.floor(u * 7200);
      return {
        symbol: s,
        name: `${s} Protocol`,
        contract: `synthetic_${idx}_${Math.floor(u * 1e6)}`,
        chain: 'sol',
        platform: 'pump.fun',
        issueMs: Date.now() - ageSec * 1000,
        ageSec,
        liquidityUsd: round(5000 + u * 120000, 2),
        marketCapUsd: round(10000 + u * 800000, 2),
        volumeUsd: round(1000 + u * 200000, 2),
        holders: Math.round(50 + u * 1200),
        progress: round(u, 3),
        price: round(0.00001 + u * 0.02, 8),
        riskLevel: u > 0.82 ? 'HIGH' : u > 0.62 ? 'MEDIUM' : 'LOW',
        rugStatus: u > 0.9 ? 1 : 0,
        sniperPct: round((u > 0.7 ? u : u * 0.6) * 100, 2),
        devRugPct: round((u > 0.75 ? u * 0.8 : u * 0.3) * 100, 2)
      };
    });
  }

  async getSolLaunchpadScan(query = {}) {
    const cfg = this.getConfig();
    const launchpadCfg = cfg?.market?.launchpad || {};

    const limit = Math.max(5, Math.min(50, Number(query.limit || launchpadCfg.defaultLimit || 15)));
    const ageMaxSec = query.ageMaxSec !== undefined
      ? Number(query.ageMaxSec)
      : Number(launchpadCfg.defaultAgeMaxSec ?? 7200);
    const minLiquidityUsd = query.minLiquidityUsd !== undefined
      ? Number(query.minLiquidityUsd)
      : Number(launchpadCfg.defaultMinLiquidityUsd ?? 0);
    const rawHideHighRisk = query.hideHighRisk !== undefined
      ? query.hideHighRisk
      : (launchpadCfg.defaultHideHighRisk ?? 1);
    const hideHighRisk = rawHideHighRisk === true
      || rawHideHighRisk === 1
      || String(rawHideHighRisk).toLowerCase() === 'true'
      || String(rawHideHighRisk) === '1';
    const keyword = String(query.keyword || '').trim().toLowerCase();

    const cacheTtlMs = Math.max(5000, Number(launchpadCfg.cacheTtlMs || 30000));
    const cacheKey = JSON.stringify({ limit, ageMaxSec, minLiquidityUsd, hideHighRisk, keyword });
    const now = Date.now();

    if (this.launchpadCache.data && this.launchpadCache.key === cacheKey && now - this.launchpadCache.ts < cacheTtlMs) {
      return this.launchpadCache.data;
    }

    let list = [];
    let degraded = false;
    let error = null;

    try {
      const raw = await this.bitget.getLaunchpadTokens({ chain: 'sol', limit: 100 });
      const rows = raw?.data?.list || raw?.data?.tokens || raw?.data?.items || [];
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error('empty launchpad list');
      }
      list = rows.map((r) => this.normalizeLaunchpadToken(r));
    } catch (err) {
      degraded = true;
      error = err.message;
      list = this.syntheticLaunchpadSol(50);
    }

    if (Number.isFinite(ageMaxSec) && ageMaxSec > 0) {
      list = list.filter((r) => r.ageSec === null || r.ageSec <= ageMaxSec);
    }

    if (Number.isFinite(minLiquidityUsd) && minLiquidityUsd > 0) {
      list = list.filter((r) => Number(r.liquidityUsd || 0) >= minLiquidityUsd);
    }

    if (hideHighRisk) {
      list = list.filter((r) => r.riskLevel !== 'HIGH');
    }

    if (keyword) {
      list = list.filter((r) => {
        const text = `${r.symbol} ${r.name} ${r.contract}`.toLowerCase();
        return text.includes(keyword);
      });
    }

    list.sort((a, b) => Number(b.issueMs || 0) - Number(a.issueMs || 0));

    const result = {
      ts: nowIso(),
      chain: 'sol',
      degraded,
      error,
      filters: { limit, ageMaxSec, minLiquidityUsd, hideHighRisk, keyword },
      count: list.length,
      items: list.slice(0, limit)
    };

    this.launchpadCache = {
      ts: now,
      key: cacheKey,
      data: result
    };

    db.upsertRuntime({ degradedLaunchpadMode: degraded });
    return result;
  }

  async getMarketSignal({ chain, contract }) {
    const signal = await this.bitget.getTokenSignals({ chain, contract });
    db.upsertRuntime({
      degradedMarketMode: !!signal.synthetic,
      bitgetHealth: this.bitget.getHealth(),
      lastMarketSignalAt: nowIso()
    });
    return signal;
  }

  getMinLiquidityUsdForChain(cfg, chain) {
    const key = String(chain || '').toLowerCase();
    const byChain = cfg?.simulation?.minLiquidityUsdByChain || {};
    if (Object.prototype.hasOwnProperty.call(byChain, key)) {
      return Number(byChain[key]);
    }
    return Number(cfg?.simulation?.minLiquidityUsd ?? 0);
  }

  getMaxSlippagePctForChain(cfg, chain) {
    const key = String(chain || '').toLowerCase();
    const byChain = cfg?.simulation?.maxSlippagePctByChain || {};
    if (Object.prototype.hasOwnProperty.call(byChain, key)) {
      return Number(byChain[key]);
    }
    return Number(cfg?.simulation?.maxSlippagePct ?? 0);
  }

  hardFilter(signal, cfg, chain) {
    const minLiquidityUsd = this.getMinLiquidityUsdForChain(cfg, chain);
    const maxSlippagePct = this.getMaxSlippagePctForChain(cfg, chain);

    if (signal.liquidityUsd < minLiquidityUsd) {
      return { blocked: true, reason: 'LIQUIDITY_TOO_LOW', minLiquidityUsd, maxSlippagePct };
    }

    const syntheticSlippage = Math.max(0.1, round(100000 / Math.max(1, signal.liquidityUsd), 2));
    if (syntheticSlippage > maxSlippagePct) {
      return {
        blocked: true,
        reason: 'SLIPPAGE_TOO_HIGH',
        syntheticSlippagePct: syntheticSlippage,
        maxSlippagePct,
        minLiquidityUsd
      };
    }

    if (signal.riskScore > 88) {
      return { blocked: true, reason: 'SECURITY_RISK_TOO_HIGH', syntheticSlippagePct: syntheticSlippage, maxSlippagePct, minLiquidityUsd };
    }

    return { blocked: false, syntheticSlippagePct: syntheticSlippage, maxSlippagePct, minLiquidityUsd };
  }

  normalizeUserVotes(votes, cfg) {
    if (!Array.isArray(votes) || votes.length < 2) return cfg.voting.defaultUserVotes;
    return [normalizeVote(votes[0]), normalizeVote(votes[1])];
  }

  getExecutionCostParams(cfg) {
    return {
      takerFeeBps: Number(cfg?.simulation?.takerFeeBps ?? 10),
      baseSlippageBps: Number(cfg?.simulation?.baseSlippageBps ?? 8),
      impactSlippageMultiplier: Number(cfg?.simulation?.impactSlippageMultiplier ?? 0.35),
      maxExecutionSlippageBps: Number(cfg?.simulation?.maxExecutionSlippageBps ?? 120)
    };
  }

  estimateExecutionSlippageBps({ notionalUsdc, liquidityUsd, cfg }) {
    const p = this.getExecutionCostParams(cfg);
    const liq = Math.max(1, Number(liquidityUsd || 0));
    const ratio = Math.max(0, Number(notionalUsdc || 0) / liq);
    const impactBps = ratio * 10_000 * p.impactSlippageMultiplier;
    const slippageBps = p.baseSlippageBps + impactBps;
    return Math.max(p.baseSlippageBps, Math.min(p.maxExecutionSlippageBps, round(slippageBps, 4)));
  }

  openSimPosition({ decision, cfg }) {
    const account = this.getSimAccountState(cfg);
    const orderPct = Number(decision.request?.orderPct || cfg.simulation.defaultOrderPct);
    const targetNotional = cfg.simulation.totalCapitalUsdc * (orderPct / 100);
    const notionalUsdc = round(Math.min(targetNotional, account.availableUsdc), 6);

    const gate = canOpen(account, notionalUsdc, cfg);
    if (!gate.ok) {
      db.pushEvent('SIM_BUY_SKIPPED', {
        decisionId: decision.id,
        token: decision.token,
        reason: gate.reason,
        availableUsdc: account.availableUsdc,
        requestedNotionalUsdc: round(targetNotional, 6)
      });
      return null;
    }

    const costs = this.getExecutionCostParams(cfg);
    const marketPrice = Number(decision.marketAtDecision.price || 0);
    const entrySlippageBps = this.estimateExecutionSlippageBps({
      notionalUsdc,
      liquidityUsd: decision.marketAtDecision.liquidityUsd,
      cfg
    });
    const entryExecPrice = marketPrice > 0
      ? marketPrice * (1 + entrySlippageBps / 10_000)
      : marketPrice;
    const qty = entryExecPrice > 0 ? notionalUsdc / entryExecPrice : 0;
    const entryFeeUsdc = round(notionalUsdc * (costs.takerFeeBps / 10_000), 6);

    const position = {
      id: id('pos'),
      decisionId: decision.id,
      token: decision.token,
      contract: decision.contract,
      chain: decision.chain,
      openedAt: nowIso(),
      status: 'OPEN',
      entryPrice: round(entryExecPrice, 8),
      marketEntryPrice: round(marketPrice, 8),
      currentPrice: round(marketPrice, 8),
      currentExecPrice: round(entryExecPrice, 8),
      quantity: round(qty, 8),
      notionalUsdc: round(notionalUsdc, 6),
      pnlPct: 0,
      pnlUsdc: -entryFeeUsdc,
      entryFeeUsdc,
      estExitFeeUsdc: 0,
      exitFeeUsdc: 0,
      totalFeesUsdc: entryFeeUsdc,
      feeBps: costs.takerFeeBps,
      entrySlippageBps,
      currentSlippageBps: entrySlippageBps,
      stopLossPct: cfg.simulation.stopLossPct,
      takeProfitPct: cfg.simulation.takeProfitPct,
      maxHoldMinutes: cfg.simulation.maxHoldMinutes,
      closeReason: null,
      closedAt: null
    };

    db.append('sim_positions', position);

    const reserved = reserveForOpen(account, notionalUsdc);
    const recomputed = recomputeFromPositions(reserved, db.read('sim_positions'), cfg);
    this.updateSimAccountState(recomputed, cfg);

    db.pushEvent('SIM_POSITION_OPENED', {
      positionId: position.id,
      token: position.token,
      marketEntryPrice: position.marketEntryPrice,
      entryPrice: position.entryPrice,
      entrySlippageBps,
      entryFeeUsdc,
      notionalUsdc,
      availableUsdc: recomputed.availableUsdc
    });
    return position;
  }

  scheduleVerification(decisionId, cfg) {
    const ms = cfg.runtime.verificationDelayMs;
    if (this.verificationTimers.has(decisionId)) {
      clearTimeout(this.verificationTimers.get(decisionId));
    }

    const timer = setTimeout(() => {
      this.runVerification(decisionId).catch((err) => {
        db.pushEvent('VERIFY_ERROR', { decisionId, error: err.message });
      });
    }, ms);

    this.verificationTimers.set(decisionId, timer);
  }

  async analyzeAndVote(payload) {
    const cfg = this.getConfig();
    const token = String(payload.token || '').trim() || 'UNKNOWN';
    const chain = String(payload.chain || cfg.market.defaultChain || 'sol').trim();
    const contract = String(payload.contract || token).trim();

    const signal = await this.getMarketSignal({ chain, contract });

    const snapshot = {
      id: id('snap'),
      ts: nowIso(),
      token,
      chain,
      contract,
      signal
    };
    db.append('snapshots', snapshot);

    const hardFilter = this.hardFilter(signal, cfg, chain);

    const memoryState = this.getAgentMemoryState();
    const lastReasonByAgent = getLastReasonByAgent(memoryState, AGENTS);
    const agentGenerationByName = getAgentGenerationByName(memoryState, AGENTS);

    const outputs = runThreeAgentAnalysis({
      token,
      marketSignal: signal,
      ts: Date.now(),
      lastReasonByAgent,
      agentGenerationByName
    });

    const userVotes = this.normalizeUserVotes(payload.userVotes, cfg);
    let voteResult = runVote({ agentOutputs: outputs, userVotes, threshold: cfg.voting.buyThreshold });

    if (hardFilter.blocked) {
      voteResult = {
        ...voteResult,
        decision: 'NO_TRADE',
        hardFilter: hardFilter.reason
      };
    }

    const requestedOrderPct = Number(payload.orderPct || cfg.simulation.defaultOrderPct);
    const targetNotional = cfg.simulation.totalCapitalUsdc * (requestedOrderPct / 100);
    const simAccountBefore = this.getSimAccountState(cfg);

    let gateMeta = null;
    if (voteResult.decision === 'SIM_BUY') {
      const gate = canOpen(simAccountBefore, Math.min(targetNotional, simAccountBefore.availableUsdc), cfg);
      if (!gate.ok) {
        voteResult = {
          ...voteResult,
          decision: 'NO_TRADE',
          hardFilter: gate.reason
        };
        gateMeta = {
          blocked: true,
          reason: gate.reason,
          availableUsdc: simAccountBefore.availableUsdc,
          requestedNotionalUsdc: Math.min(targetNotional, simAccountBefore.availableUsdc)
        };
      }
    }

    const decision = {
      id: id('decision'),
      ts: nowIso(),
      token,
      chain,
      contract,
      decision: voteResult.decision,
      buyVotes: voteResult.buyVotes,
      votes: voteResult.votes,
      weightedRug: voteResult.weightedRug,
      hardFilter: voteResult.hardFilter || null,
      hardFilterMeta: gateMeta || (hardFilter.blocked ? hardFilter : (voteResult.hardFilter ? { blocked: true, reason: voteResult.hardFilter } : null)),
      marketAtDecision: signal,
      request: {
        userVotes,
        orderPct: requestedOrderPct
      }
    };

    decision.explanation = buildDecisionExplanation({
      decision,
      voteResult,
      agentOutputs: outputs,
      hardFilter: hardFilter.blocked ? hardFilter : (decision.hardFilter ? { blocked: true, reason: decision.hardFilter } : null),
      signal,
      cfg
    });

    for (const row of outputs) {
      db.append('agent_outputs', {
        id: id('agentout'),
        ts: nowIso(),
        decisionId: decision.id,
        ...row
      });
    }

    if (decision.decision === 'SIM_BUY') {
      const opened = this.openSimPosition({ decision, cfg });
      if (!opened) {
        decision.decision = 'NO_TRADE';
        decision.hardFilter = decision.hardFilter || 'INSUFFICIENT_AVAILABLE_BALANCE';
        decision.hardFilterMeta = decision.hardFilterMeta || { blocked: true, reason: decision.hardFilter };
        decision.explanation = buildDecisionExplanation({
          decision,
          voteResult: { ...voteResult, decision: 'NO_TRADE' },
          agentOutputs: outputs,
          hardFilter: { blocked: true, reason: decision.hardFilter },
          signal,
          cfg
        });
      }
    }

    db.append('vote_decisions', decision);

    const memoryNext = appendDecisionExperiences({
      state: memoryState,
      outputs,
      decision
    });
    this.updateAgentMemoryState(memoryNext);

    this.scheduleVerification(decision.id, cfg);

    db.pushEvent('VOTE_DECISION_MADE', {
      decisionId: decision.id,
      token,
      decision: decision.decision,
      buyVotes: decision.buyVotes,
      hardFilter: decision.hardFilter
    });

    return {
      snapshot,
      agentOutputs: outputs,
      decision
    };
  }

  async runVerification(decisionId) {
    const decisions = db.read('vote_decisions');
    const decision = decisions.find((d) => d.id === decisionId);
    if (!decision) throw new Error(`decision ${decisionId} not found`);

    const existing = db.read('verify_results').find((v) => v.decisionId === decisionId);
    if (existing) return existing;

    const cfg = this.getConfig();
    const signal = await this.getMarketSignal({ chain: decision.chain, contract: decision.contract });
    const rugEval = evaluateRug({ decision, currentSignal: signal, cfg });
    const verifyRecord = buildVerificationRecord({ decision, signalAtVerify: signal, rugEval });

    db.append('verify_results', verifyRecord);

    if (String(decision.chain || '').toLowerCase() === 'sol') {
      const fingerprintBase = buildFraudFingerprint({ decision, verify: verifyRecord });
      const history = db.read('fraud_fingerprints').slice(-400);
      const fingerprint = attachSimilarCases(fingerprintBase, history, 3);

      db.append('fraud_fingerprints', fingerprint);

      const shadowGraph = this.getShadowEntityGraph();
      const updatedShadow = updateShadowEntityGraph(shadowGraph, {
        decision,
        verify: verifyRecord,
        fingerprint
      });
      this.updateShadowEntityGraph(updatedShadow);

      db.pushEvent('FRAUD_FINGERPRINT_CAPTURED', {
        decisionId,
        token: decision.token,
        cause: fingerprint.cause,
        fingerprintId: fingerprint.fingerprintId,
        taxonomy: fingerprint?.taxonomy?.dominantClass,
        score: fingerprint.fingerprintScore,
        tags: fingerprint.tags,
        topSimilarScorePct: fingerprint.similarCases?.[0]?.scorePct || null,
        topSimilarToken: fingerprint.similarCases?.[0]?.token || null
      });
    }

    db.pushEvent('VERIFY_COMPLETED', {
      decisionId,
      token: decision.token,
      verdict: verifyRecord.verdict,
      drawdownPct: verifyRecord.drawdownPct
    });

    if (decision.decision === 'NO_TRADE' && verifyRecord.verdict === 'RUG_TRUE') {
      await this.triggerNoTradeReward(decision, verifyRecord, cfg);
    }

    return verifyRecord;
  }

  rewardAllowed({ decision, cfg }) {
    const rewards = db.read('x402_rewards');
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = rewards.filter((r) => String(r.ts).startsWith(today)).length;
    if (todayCount >= cfg.reward.dailyRewardCapCount) return { ok: false, reason: 'DAILY_REWARD_CAP' };

    const existingForDecision = rewards.find((r) => r.decisionId === decision.id);
    if (existingForDecision) return { ok: false, reason: 'REWARD_ALREADY_PAID' };

    const cooldownMs = cfg.reward.tokenCooldownHours * 3600 * 1000;
    const now = Date.now();
    const lastForToken = rewards
      .filter((r) => r.token === decision.token)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())[0];

    if (lastForToken && now - new Date(lastForToken.ts).getTime() < cooldownMs) {
      return { ok: false, reason: 'TOKEN_COOLDOWN' };
    }

    return { ok: true };
  }

  async triggerNoTradeReward(decision, verifyRecord, cfg) {
    const allow = this.rewardAllowed({ decision, cfg });
    if (!allow.ok) {
      db.pushEvent('X402_REWARD_SKIPPED', { decisionId: decision.id, reason: allow.reason });
      return null;
    }

    let receipt;
    try {
      receipt = await createX402RewardReceipt({
        amountUsdc: cfg.reward.x402AmountUsdc,
        decisionId: decision.id,
        token: decision.token,
        rewardCfg: cfg.reward
      });
    } catch (err) {
      db.pushEvent('X402_REWARD_FAILED', {
        decisionId: decision.id,
        token: decision.token,
        status: 'SETTLEMENT_EXCEPTION',
        error: err.message
      });
      return { receipt: null, deploy: null };
    }

    if (receipt.status !== 'SETTLED_ONCHAIN' && receipt.status !== 'SETTLED_SIMULATED') {
      db.pushEvent('X402_REWARD_FAILED', {
        decisionId: decision.id,
        token: decision.token,
        status: receipt.status,
        error: receipt.error || 'unknown'
      });
      return { receipt, deploy: null };
    }

    db.append('x402_rewards', receipt);
    db.pushEvent('X402_REWARD_PAID', {
      decisionId: decision.id,
      rewardId: receipt.id,
      amountUsdc: receipt.amountUsdc,
      status: receipt.status,
      txRef: receipt.txRef || null
    });

    const orders = db.read('yield_orders');
    const simAccount = this.getSimAccountState(cfg);

    const liveProductsResult = await fetchLiveProducts(cfg);
    if (!liveProductsResult.ok) {
      db.pushEvent('YIELD_PRODUCTS_SOURCE_WARN', {
        source: liveProductsResult.source,
        error: liveProductsResult.error || 'unknown',
        fallback: 'static_whitelist'
      });
    }

    const primarySource = liveProductsResult.ok
      ? `${liveProductsResult.source}${liveProductsResult.stale ? ':stale' : ''}`
      : 'static_whitelist';

    let deploy = runYieldDeployment({
      cfg,
      reward: receipt,
      decision,
      simAccount,
      totalCapital: cfg.simulation.totalCapitalUsdc,
      existingOrders: orders,
      candidateProducts: liveProductsResult.ok ? liveProductsResult.products : null,
      candidateSource: primarySource
    });

    if (
      !deploy.order
      && deploy.reason === 'NO_PRODUCT_ABOVE_MIN_APY'
      && liveProductsResult.ok
      && Array.isArray(cfg?.yield?.whitelist)
      && cfg.yield.whitelist.length
    ) {
      deploy = runYieldDeployment({
        cfg,
        reward: receipt,
        decision,
        simAccount,
        totalCapital: cfg.simulation.totalCapitalUsdc,
        existingOrders: orders,
        candidateProducts: null,
        candidateSource: 'static_whitelist:fallback'
      });

      db.pushEvent('YIELD_PRODUCTS_FALLBACK_USED', {
        rewardId: receipt.id,
        fallback: 'static_whitelist',
        reason: 'NO_PRODUCT_ABOVE_MIN_APY_IN_LIVE_SOURCE'
      });
    }

    db.pushEvent('YIELD_PRODUCTS_SOURCE_USED', {
      source: liveProductsResult.ok
        ? `${liveProductsResult.source}${liveProductsResult.stale ? ':stale' : ''}`
        : 'static_whitelist',
      count: Array.isArray(liveProductsResult.products) ? liveProductsResult.products.length : 0,
      cacheHit: Boolean(liveProductsResult.cacheHit),
      rewardId: receipt.id
    });

    if (deploy.order) {
      db.append('yield_orders', deploy.order);
      db.pushEvent('YIELD_DEPLOYED', {
        orderId: deploy.order.id,
        protocol: deploy.order.protocol,
        amountUsdc: deploy.order.amountUsdc,
        allocationMode: deploy.order?.allocationMeta?.mode || null,
        rewardBaseUsdc: deploy.order?.allocationMeta?.baseRewardUsdc || null,
        balanceComponentUsdc: deploy.order?.allocationMeta?.balanceComponentUsdc || null,
        rewardId: receipt.id
      });
    } else {
      db.pushEvent('YIELD_HOLD_USDC', {
        rewardId: receipt.id,
        reason: deploy.reason,
        allocationMode: deploy?.allocation?.mode || cfg?.yield?.allocationMode || 'reward_only',
        allocationAmountUsdc: deploy?.allocation?.amountUsdc ?? null,
        balanceComponentUsdc: deploy?.allocation?.balanceComponentUsdc ?? null
      });
    }

    return { receipt, deploy };
  }

  async monitorPositions() {
    const cfg = this.getConfig();
    const positions = db.read('sim_positions');
    const open = positions.filter((p) => p.status === 'OPEN');

    let changed = false;
    let account = this.getSimAccountState(cfg);
    const wasPaused = Boolean(account.tradingPaused);
    const observedSignals = [];

    for (const pos of open) {
      const signal = await this.getMarketSignal({ chain: pos.chain, contract: pos.contract || pos.token });
      observedSignals.push(signal);

      const currentPrice = Number(signal.price || pos.currentPrice || pos.entryPrice);
      const ageMin = (Date.now() - new Date(pos.openedAt).getTime()) / 60000;

      const slipBps = this.estimateExecutionSlippageBps({
        notionalUsdc: pos.notionalUsdc,
        liquidityUsd: signal.liquidityUsd,
        cfg
      });
      const exitExecPrice = currentPrice * (1 - slipBps / 10_000);
      const exitNotionalUsdc = pos.quantity * exitExecPrice;
      const exitFeeUsdc = exitNotionalUsdc * ((Number(pos.feeBps || cfg?.simulation?.takerFeeBps || 10)) / 10_000);
      const grossPnlUsdc = exitNotionalUsdc - pos.notionalUsdc;
      const netPnlUsdc = grossPnlUsdc - Number(pos.entryFeeUsdc || 0) - exitFeeUsdc;
      const pnlPct = pos.notionalUsdc > 0 ? (netPnlUsdc / pos.notionalUsdc) * 100 : 0;

      pos.currentPrice = round(currentPrice, 8);
      pos.currentExecPrice = round(exitExecPrice, 8);
      pos.currentSlippageBps = round(slipBps, 4);
      pos.estExitFeeUsdc = round(exitFeeUsdc, 6);
      pos.pnlPct = round(pnlPct, 4);
      pos.pnlUsdc = round(netPnlUsdc, 6);
      pos.lastSignal = signal;

      let closeReason = null;
      if (pnlPct <= pos.stopLossPct) closeReason = 'STOP_LOSS';
      else if (pnlPct >= pos.takeProfitPct) closeReason = 'TAKE_PROFIT';
      else if (ageMin >= pos.maxHoldMinutes) closeReason = 'MAX_HOLD';
      else if (signal.riskScore >= cfg.simulation.riskExitScore) closeReason = 'RISK_EXIT';

      if (closeReason) {
        pos.status = 'CLOSED';
        pos.closedAt = nowIso();
        pos.closeReason = closeReason;
        pos.exitFeeUsdc = round(pos.estExitFeeUsdc || 0, 6);
        pos.totalFeesUsdc = round(Number(pos.entryFeeUsdc || 0) + Number(pos.exitFeeUsdc || 0), 6);

        account = settleClose(account, pos.pnlUsdc, pos.notionalUsdc, cfg);

        db.pushEvent('SIM_POSITION_CLOSED', {
          positionId: pos.id,
          token: pos.token,
          closeReason,
          pnlPct: pos.pnlPct,
          pnlUsdc: pos.pnlUsdc,
          entryFeeUsdc: pos.entryFeeUsdc,
          exitFeeUsdc: pos.exitFeeUsdc,
          totalFeesUsdc: pos.totalFeesUsdc,
          avgSlippageBps: round((Number(pos.entrySlippageBps || 0) + Number(pos.currentSlippageBps || 0)) / 2, 4),
          availableUsdc: account.availableUsdc,
          equityUsdc: account.equityUsdc
        });
      }

      changed = true;
    }

    if (changed) db.write('sim_positions', positions);

    const yieldOrders = db.read('yield_orders');
    if (yieldOrders.some((o) => o && o.active)) {
      const decisionsById = new Map(db.read('vote_decisions').map((d) => [d.id, d]));
      const signalCache = new Map();
      const marketSignalsByOrder = {};

      let fallbackRiskSignal = observedSignals
        .slice()
        .sort((a, b) => Number(b?.riskScore || 0) - Number(a?.riskScore || 0))[0];

      if (!fallbackRiskSignal) {
        fallbackRiskSignal = db.latest('snapshots', 1)[0]?.signal || null;
      }

      for (const order of yieldOrders) {
        if (!order?.active) continue;

        const decision = decisionsById.get(order.decisionId) || null;
        const chain = String(order.chain || decision?.chain || 'sol').toLowerCase();
        const contract = String(order.contract || decision?.contract || '').trim();

        if (contract && !String(contract).startsWith('synthetic_')) {
          const key = `${chain}::${contract}`;
          if (!signalCache.has(key)) {
            try {
              const sig = await this.getMarketSignal({ chain, contract });
              signalCache.set(key, sig);
            } catch (err) {
              signalCache.set(key, null);
              db.pushEvent('YIELD_SIGNAL_FETCH_FAILED', {
                orderId: order.id,
                chain,
                contract,
                error: err.message
              });
            }
          }

          const sig = signalCache.get(key);
          if (sig) {
            marketSignalsByOrder[order.id] = sig;
          }

          if (!order.chain) order.chain = chain;
          if (!order.contract) order.contract = contract;
          if (!order.riskMonitor || !Number.isFinite(Number(order.riskMonitor?.baselineRiskScore))) {
            order.riskMonitor = {
              ...(order.riskMonitor || {}),
              baselineRiskScore: Number(decision?.marketAtDecision?.riskScore ?? order.riskScore ?? 0),
              consecutiveRiskHits: Number(order?.riskMonitor?.consecutiveRiskHits || 0),
              lastRiskScore: Number(order?.riskMonitor?.lastRiskScore || 0),
              lastCheckedAt: nowIso()
            };
          }
        } else if (fallbackRiskSignal) {
          marketSignalsByOrder[order.id] = fallbackRiskSignal;
        }
      }

      const riskCheck = runYieldRiskCheck({
        cfg,
        activeOrders: yieldOrders,
        marketSignal: fallbackRiskSignal,
        marketSignalsByOrder
      });

      db.write('yield_orders', riskCheck.remaining);
      if (riskCheck.closed.length) {
        for (const ord of riskCheck.closed) {
          db.pushEvent('YIELD_AUTO_EXIT', {
            orderId: ord.id,
            protocol: ord.protocol,
            reason: ord.closeReason,
            closeMeta: ord.closeMeta || null
          });
        }
      }
    }

    const recomputed = recomputeFromPositions(account, positions, cfg);
    this.updateSimAccountState(recomputed, cfg);

    if (recomputed.tradingPaused && !wasPaused) {
      db.pushEvent('SIM_ACCOUNT_PAUSED', {
        reason: recomputed.pauseReason,
        availableUsdc: recomputed.availableUsdc,
        equityUsdc: recomputed.equityUsdc,
        maxDrawdownPct: recomputed.maxDrawdownPct,
        consecutiveLosses: recomputed.consecutiveLosses
      });
    }
  }

  async collectMarketSnapshot() {
    const cfg = this.getConfig();
    const collectorCfg = cfg?.runtime?.collector || {};
    const collectorChain = 'sol';
    const dynamicEnabled = collectorCfg.dynamic !== false;
    const fallbackTargets = Array.isArray(collectorCfg.fallbackTargets) && collectorCfg.fallbackTargets.length
      ? collectorCfg.fallbackTargets
      : ['SOL', 'BONK', 'WIF'];

    let targets = [];
    let targetSource = 'fallback';

    if (dynamicEnabled) {
      try {
        const candidateLimit = Math.max(1, Math.min(10, Number(collectorCfg.candidatesPerRun || 5)));
        const fetchLimit = Math.max(candidateLimit, Number(collectorCfg.launchpadFetchLimit || 40));
        const scan = await this.getSolLaunchpadScan({
          limit: fetchLimit,
          ageMaxSec: Number(collectorCfg.ageMaxSec ?? 7200),
          minLiquidityUsd: Number(collectorCfg.minLiquidityUsd ?? 0),
          hideHighRisk: collectorCfg.hideHighRisk ? 1 : 0,
          keyword: ''
        });

        const seen = new Set();
        targets = (scan.items || [])
          .filter((row) => row && row.contract && !String(row.contract).startsWith('synthetic_'))
          .filter((row) => String(row.chain || 'sol').toLowerCase() === collectorChain)
          .sort((a, b) => Number(b.liquidityUsd || 0) - Number(a.liquidityUsd || 0))
          .filter((row) => {
            const key = `${collectorChain}::${String(row.contract).toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, candidateLimit)
          .map((row) => ({
            token: String(row.symbol || row.contract),
            contract: String(row.contract),
            chain: collectorChain
          }));

        if (targets.length) {
          targetSource = scan.degraded ? 'launchpad_degraded' : 'launchpad';
        }
      } catch (err) {
        db.pushEvent('COLLECTOR_DYNAMIC_TARGETS_ERROR', { error: err.message });
      }
    }

    if (!targets.length) {
      targets = fallbackTargets.map((token) => ({
        token: String(token),
        contract: String(token),
        chain: collectorChain
      }));
      targetSource = 'fallback';
    }

    for (const item of targets) {
      const signal = await this.getMarketSignal({ chain: item.chain, contract: item.contract });
      db.append('snapshots', {
        id: id('snap'),
        ts: nowIso(),
        token: item.token,
        chain: item.chain,
        contract: item.contract,
        signal,
        source: `scheduled_collector:${targetSource}`
      });
    }

    db.upsertRuntime({
      lastCollectorAt: nowIso(),
      bitgetHealth: this.bitget.getHealth()
    });
    db.pushEvent('COLLECTOR_RUN', {
      count: targets.length,
      source: targetSource,
      targets: targets.map((t) => t.token)
    });
  }

  runEvolution() {
    const cfg = this.getConfig();
    const outputs = db.read('agent_outputs');
    const verifications = db.read('verify_results');
    const decisions = db.read('vote_decisions');

    const memoryState = this.getAgentMemoryState();
    const agentGenerationByName = getAgentGenerationByName(memoryState, AGENTS);

    const result = computeFitness({
      agentOutputs: outputs,
      verifications,
      decisions,
      includeSynthetic: Boolean(cfg?.evolution?.includeSyntheticInFitness),
      agentGenerationByName,
      agents: AGENTS
    });

    const maintenance = summarizeAndMaintain({
      state: memoryState,
      cfg,
      fitness: result,
      agentOutputs: outputs,
      verifications,
      agents: AGENTS
    });

    this.updateAgentMemoryState(maintenance.state);

    if (maintenance.summaryEvents.length) {
      for (const s of maintenance.summaryEvents) {
        db.pushEvent('AGENT_SUMMARY_WRITTEN', {
          agent: s.agent,
          generation: s.generation,
          text: s.text
        });
      }
    }

    if (maintenance.retired.length) {
      const prunedOutputs = pruneRetiredAgentOutputs(outputs, maintenance.retired);
      if (prunedOutputs.length !== outputs.length) {
        db.write('agent_outputs', prunedOutputs);
      }
      for (const r of maintenance.retired) {
        db.pushEvent('AGENT_REPLACED', {
          agent: r.agent,
          retiredGeneration: r.retiredGeneration,
          newGeneration: r.newGeneration
        });
      }
    }

    db.append('agent_fitness', result);
    db.pushEvent('EVOLUTION_RUN', {
      evoId: result.id,
      topAgent: result.ranking[0]?.agent,
      weakest: result.replacementSuggestion?.weakest || null,
      scoringMode: result.scoringMode,
      excludedSyntheticTotal: result.excludedSyntheticTotal,
      replaced: maintenance.retired.map((r) => `${r.agent}#${r.retiredGeneration}->#${r.newGeneration}`)
    });
    return result;
  }

  buildYieldSummary(orders = []) {
    const rows = Array.isArray(orders) ? orders : [];
    const active = rows.filter((o) => o && o.active);

    const yearMs = 365 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    let principalUsdc = 0;
    let estimatedAccruedUsdc = 0;
    let weightedApySum = 0;

    for (const o of active) {
      const amount = Number(o.amountUsdc || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      const apyPct = Number(o.apyPct || 0);
      const openedMs = new Date(o.openedAt || 0).getTime();
      const elapsedMs = Number.isFinite(openedMs) && openedMs > 0 ? Math.max(0, now - openedMs) : 0;

      principalUsdc += amount;
      weightedApySum += amount * apyPct;

      const accrued = amount * (apyPct / 100) * (elapsedMs / yearMs);
      estimatedAccruedUsdc += Number.isFinite(accrued) ? accrued : 0;
    }

    const weightedApyPct = principalUsdc > 0 ? weightedApySum / principalUsdc : 0;
    const estimatedBalanceUsdc = principalUsdc + estimatedAccruedUsdc;
    const estimatedDailyYieldUsdc = principalUsdc * (weightedApyPct / 100) / 365;

    return {
      activeOrders: active.length,
      totalOrders: rows.length,
      principalUsdc: round(principalUsdc, 6),
      estimatedAccruedUsdc: round(estimatedAccruedUsdc, 6),
      estimatedBalanceUsdc: round(estimatedBalanceUsdc, 6),
      weightedApyPct: round(weightedApyPct, 4),
      estimatedDailyYieldUsdc: round(estimatedDailyYieldUsdc, 6),
      computedAt: nowIso()
    };
  }

  buildRewardSummary(rewards = []) {
    const rows = Array.isArray(rewards) ? rewards : [];
    const settled = rows.filter((r) => ['SETTLED_ONCHAIN', 'SETTLED_SIMULATED'].includes(String(r.status || '').toUpperCase()));
    const totalRewardUsdc = settled.reduce((acc, r) => acc + Number(r.amountUsdc || 0), 0);

    return {
      totalRewards: rows.length,
      settledRewards: settled.length,
      totalRewardUsdc: round(totalRewardUsdc, 6),
      lastRewardAt: rows.length ? rows[rows.length - 1].ts : null
    };
  }

  buildNoTradeReasonSummary(decisions = [], limit = 20) {
    const rows = Array.isArray(decisions) ? decisions.slice(0, Math.max(1, Number(limit || 20))) : [];
    const noTrades = rows.filter((d) => String(d?.decision || '').toUpperCase() === 'NO_TRADE');
    const map = new Map();

    for (const d of noTrades) {
      const reason = String(d.hardFilter || 'VOTE_REJECT').trim() || 'VOTE_REJECT';
      map.set(reason, (map.get(reason) || 0) + 1);
    }

    const reasons = [...map.entries()]
      .map(([reason, count]) => ({
        reason,
        count,
        ratePct: noTrades.length ? round((count / noTrades.length) * 100, 2) : 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    return {
      windowSize: rows.length,
      noTradeCount: noTrades.length,
      reasons
    };
  }

  buildDashboardKpis({ backtest, simAccount, bitgetHealth, noTradeSummary, runtime, counts }) {
    const startedAtMs = runtime?.startedAt ? new Date(runtime.startedAt).getTime() : 0;
    const uptimeMinutes = startedAtMs > 0 ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 60000)) : 0;

    return {
      rugCatchRatePct: Number(backtest?.noTradeRugCatchRate ?? 0),
      rugCatchSamples: Number(backtest?.noTradeCount || 0),
      simBuySafetyRatePct: Number(backtest?.simBuySafetyRate ?? 0),
      simBuySamples: Number(backtest?.simBuyCount || 0),
      avgDrawdownPct: Number(backtest?.avgDrawdownPct ?? 0),
      marketDataSuccessRatePct: Number(bitgetHealth?.market?.successRate ?? 0),
      launchpadDataSuccessRatePct: Number(bitgetHealth?.launchpad?.successRate ?? 0),
      openPositions: Number(counts?.openPositions || 0),
      tradingPaused: Boolean(simAccount?.tradingPaused),
      topNoTradeReason: noTradeSummary?.reasons?.[0]?.reason || null,
      topNoTradeReasonRatePct: Number(noTradeSummary?.reasons?.[0]?.ratePct || 0),
      uptimeMinutes
    };
  }

  getState() {
    const runtime = db.read('runtime');
    const config = db.read('config');
    const autoAnalyzeCfg = this.getAutoAnalyzeConfig(config);
    const latestDecision = db.latest('vote_decisions', 1)[0] || null;
    const latestFitness = db.latest('agent_fitness', 1)[0] || null;
    const latestAgentOutputs = latestDecision
      ? db.read('agent_outputs')
        .filter((row) => row.decisionId === latestDecision.id)
        .sort((a, b) => String(a.agent).localeCompare(String(b.agent)))
      : [];

    const rowLimit = 20;
    const positions = db.read('sim_positions');
    const openPositions = positions
      .filter((p) => p.status === 'OPEN')
      .sort((a, b) => Number(new Date(b.openedAt || 0).getTime()) - Number(new Date(a.openedAt || 0).getTime()))
      .slice(0, rowLimit);
    const closedPositions = positions.filter((p) => p.status === 'CLOSED').slice(-rowLimit).reverse();

    const events = db.latest('events', rowLimit);
    const agentMemory = this.getAgentMemoryState();
    const agentMemoryOverview = buildAgentMemoryOverview(agentMemory, AGENTS);
    const agentMemoryLifecycle = Array.isArray(agentMemory.lifecycle)
      ? agentMemory.lifecycle.slice(-rowLimit).reverse()
      : [];
    const simAccount = recomputeFromPositions(this.getSimAccountState(config), positions, config);
    const bitgetHealth = this.bitget.getHealth();
    const backtest = runBacktestSummary({
      decisions: db.read('vote_decisions'),
      verifications: db.read('verify_results'),
      limit: 100,
      includeSynthetic: Boolean(config?.evolution?.includeSyntheticInFitness)
    });

    const allYieldOrders = db.read('yield_orders');
    const allRewards = db.read('x402_rewards');
    const yieldSummary = this.buildYieldSummary(allYieldOrders);
    const rewardSummary = this.buildRewardSummary(allRewards);

    const recentDecisions = db.latest('vote_decisions', rowLimit);
    const noTradeReasonSummary = this.buildNoTradeReasonSummary(recentDecisions, rowLimit);

    const fraudFingerprints = db.latest('fraud_fingerprints', rowLimit);
    const fraudFingerprintStats = summarizeFraudFingerprints(db.read('fraud_fingerprints').slice(-300));
    const shadowGraphSummary = summarizeShadowEntityGraph(this.getShadowEntityGraph());

    const counts = {
      snapshots: db.read('snapshots').length,
      decisions: db.read('vote_decisions').length,
      openPositions: positions.filter((p) => p.status === 'OPEN').length,
      verifications: db.read('verify_results').length,
      fraudFingerprints: db.read('fraud_fingerprints').length,
      shadowProfiles: Object.keys(this.getShadowEntityGraph()?.tokenProfiles || {}).length,
      rewards: allRewards.length,
      yieldOrders: allYieldOrders.length,
      agentMemoryEvents: Array.isArray(agentMemory.lifecycle) ? agentMemory.lifecycle.length : 0,
      simAccountPaused: Boolean(simAccount.tradingPaused)
    };

    const kpis = this.buildDashboardKpis({
      backtest,
      simAccount,
      bitgetHealth,
      noTradeSummary: noTradeReasonSummary,
      runtime,
      counts
    });

    return {
      app: config.app.name,
      runtime: {
        ...runtime,
        bitgetHealth,
        autoAnalyze: {
          enabled: autoAnalyzeCfg.enabled,
          intervalMs: autoAnalyzeCfg.intervalMs,
          candidatesPerRun: autoAnalyzeCfg.candidatesPerRun,
          ...runtime.autoAnalyze,
          running: this.autoAnalyzeRunning
        }
      },
      config,
      latestDecision,
      latestFitness,
      latestAgentOutputs,
      agentMemoryOverview,
      agentMemoryLifecycle,
      simAccount,
      backtest,
      kpis,
      yieldSummary,
      rewardSummary,
      noTradeReasonSummary,
      recentDecisions,
      fraudFingerprints,
      fraudFingerprintStats,
      shadowGraphSummary,
      regression: regressionChecks({ state: { latestAgentOutputs, simAccount } }),
      counts,
      openPositions,
      closedPositions,
      verifyResults: db.latest('verify_results', rowLimit),
      rewards: allRewards.slice(-rowLimit).reverse(),
      yieldOrders: allYieldOrders.slice(-rowLimit).reverse(),
      events
    };
  }

  shouldLogSchedulerSkip(task, cooldownMs = 60_000) {
    const key = String(task || 'unknown');
    const now = Date.now();
    const last = Number(this.schedulerSkipLogAt[key] || 0);
    if (now - last < cooldownMs) return false;
    this.schedulerSkipLogAt[key] = now;
    return true;
  }

  async runScheduledTask(task, fn) {
    const key = String(task || 'unknown');
    if (!this.schedulerLocks[key]) this.schedulerLocks[key] = false;

    if (this.schedulerLocks[key]) {
      if (this.shouldLogSchedulerSkip(key)) {
        db.pushEvent('SCHEDULER_TICK_SKIPPED', {
          task: key,
          reason: 'PREVIOUS_TICK_RUNNING'
        });
      }
      return;
    }

    this.schedulerLocks[key] = true;
    try {
      return await fn();
    } finally {
      this.schedulerLocks[key] = false;
    }
  }

  startSchedulers() {
    const cfg = this.getConfig();

    this.recomputeAndPersistSimAccount(cfg);

    const collector = setInterval(() => {
      this.runScheduledTask('collector', () => this.collectMarketSnapshot())
        .catch((err) => db.pushEvent('COLLECTOR_ERROR', { error: err.message }));
    }, cfg.runtime.collectorIntervalMs);

    const monitor = setInterval(() => {
      this.runScheduledTask('monitor', () => this.monitorPositions())
        .catch((err) => db.pushEvent('POSITION_MONITOR_ERROR', { error: err.message }));
    }, cfg.runtime.positionWatchIntervalMs);

    const evo = setInterval(() => {
      this.runScheduledTask('evolution', async () => {
        this.runEvolution();
      }).catch((err) => db.pushEvent('EVOLUTION_ERROR', { error: err.message }));
    }, cfg.runtime.evolutionIntervalMs);

    const autoAnalyzeTickMs = this.getAutoAnalyzeConfig(cfg).tickMs;
    const autoAnalyzeTimer = setInterval(() => {
      this.runScheduledTask('autoAnalyze', () => this.autoAnalyzeTick())
        .catch((err) => db.pushEvent('AUTO_ANALYZE_TICK_ERROR', { error: err.message }));
    }, autoAnalyzeTickMs);

    this.intervals.push(collector, monitor, evo, autoAnalyzeTimer);
    db.pushEvent('SCHEDULERS_STARTED', {
      collectorMs: cfg.runtime.collectorIntervalMs,
      monitorMs: cfg.runtime.positionWatchIntervalMs,
      evolutionMs: cfg.runtime.evolutionIntervalMs,
      autoAnalyzeTickMs
    });
  }

  stopSchedulers() {
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
  }
}

module.exports = { RugSenseEngine };
