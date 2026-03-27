const { nowIso, round } = require('../utils/helpers');

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function createSimAccount(cfg) {
  const capital = n(cfg?.simulation?.totalCapitalUsdc, 10_000);
  return {
    startedAt: nowIso(),
    updatedAt: nowIso(),
    startingBalanceUsdc: round(capital, 6),
    availableUsdc: round(capital, 6),
    openExposureUsdc: 0,
    unrealizedPnlUsdc: 0,
    realizedPnlUsdc: 0,
    equityUsdc: round(capital, 6),
    peakEquityUsdc: round(capital, 6),
    maxDrawdownPct: 0,
    consecutiveLosses: 0,
    totalClosed: 0,
    tradingPaused: false,
    pauseReason: null
  };
}

function ensureSimAccount(account, cfg) {
  if (!account || typeof account !== 'object') {
    return createSimAccount(cfg);
  }

  const base = createSimAccount(cfg);
  const out = {
    ...base,
    ...account
  };

  out.startingBalanceUsdc = n(out.startingBalanceUsdc, base.startingBalanceUsdc);
  out.availableUsdc = n(out.availableUsdc, base.availableUsdc);
  out.openExposureUsdc = n(out.openExposureUsdc, 0);
  out.unrealizedPnlUsdc = n(out.unrealizedPnlUsdc, 0);
  out.realizedPnlUsdc = n(out.realizedPnlUsdc, 0);
  out.equityUsdc = n(out.equityUsdc, out.availableUsdc);
  out.peakEquityUsdc = Math.max(n(out.peakEquityUsdc, out.equityUsdc), out.equityUsdc);
  out.maxDrawdownPct = n(out.maxDrawdownPct, 0);
  out.consecutiveLosses = Math.max(0, Math.floor(n(out.consecutiveLosses, 0)));
  out.totalClosed = Math.max(0, Math.floor(n(out.totalClosed, 0)));
  out.updatedAt = nowIso();

  return out;
}

function recomputeFromPositions(account, positions, cfg) {
  const open = (positions || []).filter((p) => p.status === 'OPEN');
  const openExposureUsdc = open.reduce((acc, p) => acc + n(p.notionalUsdc), 0);
  const unrealizedPnlUsdc = open.reduce((acc, p) => acc + n(p.pnlUsdc), 0);

  const out = {
    ...account,
    openExposureUsdc: round(openExposureUsdc, 6),
    unrealizedPnlUsdc: round(unrealizedPnlUsdc, 6)
  };

  out.equityUsdc = round(out.availableUsdc + out.openExposureUsdc + out.unrealizedPnlUsdc, 6);
  out.peakEquityUsdc = round(Math.max(n(out.peakEquityUsdc), out.equityUsdc), 6);

  const dd = out.peakEquityUsdc > 0
    ? ((out.peakEquityUsdc - out.equityUsdc) / out.peakEquityUsdc) * 100
    : 0;
  out.maxDrawdownPct = round(Math.max(n(out.maxDrawdownPct), dd), 4);

  const paused = applyPauseRules(out, cfg);
  out.tradingPaused = paused.paused;
  out.pauseReason = paused.reason;
  out.updatedAt = nowIso();

  return out;
}

function applyPauseRules(account, cfg) {
  const maxLosses = n(cfg?.simulation?.maxConsecutiveLossesPause, 4);
  const maxDd = n(cfg?.simulation?.maxDrawdownPausePct, 35);
  const equityStopPct = n(cfg?.simulation?.equityStopPct, 30);
  const equityFloor = n(account.startingBalanceUsdc) * (equityStopPct / 100);

  if (account.availableUsdc <= 0) {
    return { paused: true, reason: 'BALANCE_DEPLETED' };
  }
  if (account.maxDrawdownPct >= maxDd) {
    return { paused: true, reason: 'MAX_DRAWDOWN_REACHED' };
  }
  if (account.consecutiveLosses >= maxLosses) {
    return { paused: true, reason: 'CONSECUTIVE_LOSSES_LIMIT' };
  }
  if (account.equityUsdc <= equityFloor) {
    return { paused: true, reason: 'EQUITY_STOP_TRIGGERED' };
  }

  return { paused: false, reason: null };
}

function canOpen(account, notionalUsdc, cfg) {
  const minNotional = n(cfg?.simulation?.minOrderNotionalUsdc, 25);
  if (account.tradingPaused) {
    return { ok: false, reason: account.pauseReason || 'TRADING_PAUSED' };
  }
  if (notionalUsdc < minNotional) {
    return { ok: false, reason: 'ORDER_NOTIONAL_TOO_SMALL' };
  }
  if (account.availableUsdc <= 0) {
    return { ok: false, reason: 'NO_AVAILABLE_BALANCE' };
  }
  if (account.availableUsdc < notionalUsdc) {
    return { ok: false, reason: 'INSUFFICIENT_AVAILABLE_BALANCE' };
  }
  return { ok: true };
}

function reserveForOpen(account, notionalUsdc) {
  const out = { ...account };
  out.availableUsdc = round(out.availableUsdc - notionalUsdc, 6);
  out.updatedAt = nowIso();
  return out;
}

function settleClose(account, pnlUsdc, notionalUsdc, cfg) {
  const out = { ...account };
  out.availableUsdc = round(out.availableUsdc + notionalUsdc + pnlUsdc, 6);
  out.realizedPnlUsdc = round(out.realizedPnlUsdc + pnlUsdc, 6);
  out.totalClosed = Math.max(0, Math.floor(n(out.totalClosed)) + 1);

  if (pnlUsdc < 0) out.consecutiveLosses = Math.max(0, Math.floor(n(out.consecutiveLosses)) + 1);
  else out.consecutiveLosses = 0;

  const paused = applyPauseRules(out, cfg);
  out.tradingPaused = paused.paused;
  out.pauseReason = paused.reason;
  out.updatedAt = nowIso();

  return out;
}

module.exports = {
  createSimAccount,
  ensureSimAccount,
  recomputeFromPositions,
  canOpen,
  reserveForOpen,
  settleClose
};
