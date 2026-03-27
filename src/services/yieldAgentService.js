const { id, nowIso, round } = require('../utils/helpers');

function sumActiveExposureByProtocol(activeOrders) {
  const map = {};
  for (const o of activeOrders) {
    if (!o.active) continue;
    map[o.protocol] = (map[o.protocol] || 0) + Number(o.amountUsdc || 0);
  }
  return map;
}

function canDeploy({ cfg, amountUsdc, totalCapital, activeOrders, dailyNewExposureUsdc }) {
  if (cfg.yield.killSwitch) return { ok: false, reason: 'KILL_SWITCH_ENABLED' };

  const singleCap = (cfg.yield.singleOrderCapPct / 100) * totalCapital;
  if (amountUsdc > singleCap) return { ok: false, reason: 'SINGLE_ORDER_CAP_EXCEEDED' };

  const dailyCap = (cfg.yield.dailyNewExposureCapPct / 100) * totalCapital;
  if (dailyNewExposureUsdc + amountUsdc > dailyCap) return { ok: false, reason: 'DAILY_EXPOSURE_CAP_EXCEEDED' };

  return { ok: true };
}

function pickYieldProduct(cfg, candidateProducts = null) {
  const base = Array.isArray(candidateProducts) && candidateProducts.length
    ? candidateProducts
    : cfg.yield.whitelist;

  const candidates = base.filter((w) => Number(w.apyPct || 0) >= cfg.yield.minApyPct);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => Number(b.apyPct || 0) - Number(a.apyPct || 0))[0];
}

function resolveYieldAllocation({ cfg, reward, simAccount }) {
  const mode = String(cfg?.yield?.allocationMode || 'reward_only').toLowerCase();
  const rewardAmountUsdc = Number(reward?.amountUsdc || 0);
  const availableUsdc = Number(simAccount?.availableUsdc || 0);

  const balanceReinvestPct = Math.max(0, Number(cfg?.yield?.balanceReinvestPct || 0));
  const balanceReinvestCapPct = Math.max(0, Number(cfg?.yield?.balanceReinvestCapPct || 0));

  let balanceComponentUsdc = 0;
  if (mode === 'reward_plus_balance_pct' || mode === 'balance_rebalance') {
    balanceComponentUsdc = availableUsdc * (balanceReinvestPct / 100);
    if (balanceReinvestCapPct > 0) {
      const capByTotal = Number(cfg?.simulation?.totalCapitalUsdc || 0) * (balanceReinvestCapPct / 100);
      if (Number.isFinite(capByTotal) && capByTotal > 0) {
        balanceComponentUsdc = Math.min(balanceComponentUsdc, capByTotal);
      }
    }
  }

  const baseRewardUsdc = mode === 'balance_rebalance' ? 0 : rewardAmountUsdc;
  const amountUsdc = round(Math.max(0, baseRewardUsdc + balanceComponentUsdc), 6);

  return {
    mode,
    amountUsdc,
    baseRewardUsdc: round(baseRewardUsdc, 6),
    balanceComponentUsdc: round(balanceComponentUsdc, 6),
    balanceReinvestPct: round(balanceReinvestPct, 4),
    balanceReinvestCapPct: round(balanceReinvestCapPct, 4)
  };
}

function runYieldDeployment({ cfg, reward, decision = null, simAccount = null, totalCapital, existingOrders, candidateProducts = null, candidateSource = 'static_whitelist' }) {
  const today = new Date().toISOString().slice(0, 10);
  const todays = existingOrders.filter((o) => o.openedAt?.startsWith(today));
  const dailyNewExposureUsdc = todays.reduce((s, o) => s + Number(o.amountUsdc || 0), 0);

  const allocation = resolveYieldAllocation({ cfg, reward, simAccount });

  if (allocation.amountUsdc <= 0) {
    return {
      action: 'HOLD_USDC',
      reason: 'ALLOCATION_AMOUNT_ZERO',
      allocation,
      order: null
    };
  }

  const guard = canDeploy({
    cfg,
    amountUsdc: allocation.amountUsdc,
    totalCapital,
    activeOrders: existingOrders,
    dailyNewExposureUsdc
  });

  if (!guard.ok) {
    return {
      action: 'HOLD_USDC',
      reason: guard.reason,
      allocation,
      order: null
    };
  }

  const product = pickYieldProduct(cfg, candidateProducts);
  if (!product) {
    return {
      action: 'HOLD_USDC',
      reason: 'NO_PRODUCT_ABOVE_MIN_APY',
      allocation,
      order: null
    };
  }

  if (cfg.yield.forbiddenCategories.includes(product.category)) {
    return {
      action: 'HOLD_USDC',
      reason: 'FORBIDDEN_CATEGORY',
      allocation,
      order: null
    };
  }

  const exposures = sumActiveExposureByProtocol(existingOrders);
  const thisProtocol = exposures[product.protocol] || 0;
  const protocolCap = (cfg.yield.perProtocolExposureCapPct / 100) * totalCapital;
  if (thisProtocol + allocation.amountUsdc > protocolCap) {
    return {
      action: 'HOLD_USDC',
      reason: 'PROTOCOL_EXPOSURE_CAP_EXCEEDED',
      allocation,
      order: null
    };
  }

  const order = {
    id: id('yield'),
    openedAt: nowIso(),
    active: true,
    source: 'NO_TRADE_RUG_REWARD',
    rewardId: reward.id,
    decisionId: reward.decisionId,
    token: reward.token,
    chain: decision?.chain || reward?.chain || null,
    contract: decision?.contract || reward?.contract || null,
    protocol: product.protocol,
    productId: product.id,
    category: product.category,
    apyPct: product.apyPct,
    riskScore: product.riskScore,
    amountUsdc: round(allocation.amountUsdc, 6),
    productSource: candidateSource,
    allocationMeta: allocation,
    productMeta: {
      chain: product.chain || null,
      tvlUsd: Number(product.tvlUsd || 0),
      url: product.url || null,
      pool: product.pool || null
    },
    riskMonitor: {
      baselineRiskScore: Number(decision?.marketAtDecision?.riskScore ?? product.riskScore ?? 0),
      consecutiveRiskHits: 0,
      lastRiskScore: Number(decision?.marketAtDecision?.riskScore ?? 0),
      lastCheckedAt: nowIso(),
      lastSignalChain: decision?.chain || reward?.chain || null,
      lastSignalContract: decision?.contract || reward?.contract || null
    },
    guardrailSnapshot: {
      minApyPct: cfg.yield.minApyPct,
      singleOrderCapPct: cfg.yield.singleOrderCapPct,
      dailyNewExposureCapPct: cfg.yield.dailyNewExposureCapPct,
      perProtocolExposureCapPct: cfg.yield.perProtocolExposureCapPct,
      riskTvlDropExitPct1h: cfg.yield.riskTvlDropExitPct1h,
      riskScoreJumpExit: cfg.yield.riskScoreJumpExit,
      riskAbsoluteExitScore: cfg.yield.riskAbsoluteExitScore,
      riskConsecutiveHitsExit: cfg.yield.riskConsecutiveHitsExit
    }
  };

  return {
    action: 'DEPLOYED',
    reason: 'WHITELIST_PASS',
    allocation,
    order
  };
}

function resolveOrderSignal({ order, marketSignal, marketSignalsByOrder }) {
  if (marketSignalsByOrder && typeof marketSignalsByOrder === 'object') {
    if (marketSignalsByOrder[order.id]) return marketSignalsByOrder[order.id];
    if (order.contract && marketSignalsByOrder[order.contract]) return marketSignalsByOrder[order.contract];
    if (order.decisionId && marketSignalsByOrder[order.decisionId]) return marketSignalsByOrder[order.decisionId];
  }
  return marketSignal || null;
}

function runYieldRiskCheck({ cfg, activeOrders, marketSignal, marketSignalsByOrder = null }) {
  const closed = [];
  const remaining = [];

  const absoluteExitScore = Number(cfg?.yield?.riskAbsoluteExitScore ?? 88);
  const jumpExitScore = Number(cfg?.yield?.riskScoreJumpExit ?? 20);
  const tvlDropExitPct = Number(cfg?.yield?.riskTvlDropExitPct1h ?? 20);
  const consecutiveExitHits = Math.max(1, Number(cfg?.yield?.riskConsecutiveHitsExit ?? 2));

  for (const order of activeOrders) {
    if (!order.active) {
      remaining.push(order);
      continue;
    }

    const signal = resolveOrderSignal({ order, marketSignal, marketSignalsByOrder });
    if (!signal) {
      remaining.push(order);
      continue;
    }

    const baselineRiskScore = Number(
      order?.riskMonitor?.baselineRiskScore
      ?? order?.guardrailSnapshot?.entryRiskScore
      ?? order?.riskScore
      ?? 0
    );
    const currentRiskScore = Number(signal?.riskScore || 0);
    const riskJump = currentRiskScore - baselineRiskScore;
    const tvlDrop1hPct = Number(signal?.tvlDrop1hPct || 0);

    const hitReasons = [];
    if (tvlDrop1hPct >= tvlDropExitPct) hitReasons.push('TVL_DROP');
    if (currentRiskScore >= absoluteExitScore) hitReasons.push('RISK_ABSOLUTE');
    if (riskJump >= jumpExitScore) hitReasons.push('RISK_JUMP');

    const prevHits = Number(order?.riskMonitor?.consecutiveRiskHits || 0);
    const nextHits = hitReasons.length ? prevHits + 1 : 0;

    const monitored = {
      ...order,
      riskMonitor: {
        baselineRiskScore,
        consecutiveRiskHits: nextHits,
        lastRiskScore: currentRiskScore,
        lastCheckedAt: nowIso(),
        lastSignalChain: signal?.chain || order?.chain || null,
        lastSignalContract: signal?.contract || order?.contract || null,
        lastSignalQuality: signal?.dataQuality || (signal?.synthetic ? 'synthetic' : null),
        lastSignalStale: Boolean(signal?.stale),
        lastHitReasons: hitReasons,
        thresholds: {
          tvlDropExitPct,
          absoluteExitScore,
          jumpExitScore,
          consecutiveExitHits
        }
      }
    };

    if (!hitReasons.length || nextHits < consecutiveExitHits) {
      remaining.push(monitored);
      continue;
    }

    closed.push({
      ...monitored,
      active: false,
      closedAt: nowIso(),
      closeReason: 'RISK_AUTO_EXIT',
      closeMeta: {
        reasons: hitReasons,
        tvlDrop1hPct,
        currentRiskScore,
        baselineRiskScore,
        riskJump,
        consecutiveRiskHits: nextHits,
        threshold: monitored.riskMonitor.thresholds
      }
    });
  }

  return { closed, remaining: [...remaining, ...closed] };
}

module.exports = {
  runYieldDeployment,
  runYieldRiskCheck
};
