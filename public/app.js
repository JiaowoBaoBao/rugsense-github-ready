const $ = (id) => document.getElementById(id);

let latestState = null;
let toastSeq = 0;
const ROW_LIMIT = 20;

function ensureToastRoot() {
  let root = document.getElementById('topToastRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'topToastRoot';
    root.className = 'top-toast-root';
    document.body.appendChild(root);
  }
  return root;
}

function showToast(message, type = 'info', durationMs = 3000) {
  if (!message) return;
  const root = ensureToastRoot();
  const id = `toast_${Date.now()}_${toastSeq++}`;

  const toast = document.createElement('div');
  toast.id = id;
  toast.className = `top-toast ${type}`;
  toast.textContent = String(message);
  root.appendChild(toast);

  setTimeout(() => {
    const el = document.getElementById(id);
    if (el?.parentNode) {
      el.parentNode.removeChild(el);
    }
  }, Math.max(800, Number(durationMs) || 3000));
}

function badge(text, cls = 'ok') {
  return `<span class="badge ${cls}">${text}</span>`;
}

function fmt(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return Number(v).toFixed(4);
  return String(v);
}

function pct01(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '-';
  return `${(Number(v) * 100).toFixed(digits)}%`;
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function looksLikeContract(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  if (s.startsWith('synthetic_')) return false;
  if (/^0x[a-fA-F0-9]{20,}$/.test(s)) return true;
  if (/pump$/i.test(s)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return true;
  return false;
}

function resolveContract(row, tokenKey = 'token') {
  const direct = [
    row?.contract,
    row?.contractAddress,
    row?.tokenContract,
    row?.address,
    row?.ca
  ].find((x) => String(x || '').trim());

  if (direct) return String(direct).trim();

  const fromToken = row?.[tokenKey];
  if (looksLikeContract(fromToken)) return String(fromToken).trim();

  return '';
}

function renderTokenCell(row, tokenKey = 'token') {
  const token = String(row?.[tokenKey] || '').trim() || '-';
  const contract = resolveContract(row, tokenKey);

  if (!contract) return escapeHtml(token);

  if (String(contract).startsWith('synthetic_')) {
    return `<span class="symbol-chip synthetic" title="Synthetic fallback data">${escapeHtml(token)}</span>`;
  }

  return `<button type="button" class="copy-symbol-btn" data-symbol="${escapeHtml(token)}" data-contract="${escapeHtml(contract)}" title="Copy contract address">${escapeHtml(token)}</button>`;
}

function renderDecision(decision, agentOutputs = []) {
  if (!decision) return '<div class="small">No decision yet.</div>';

  const cls = decision.decision === 'SIM_BUY' ? 'ok' : 'warn';
  const voteLine = `Final decision: ${decision.decision === 'SIM_BUY' ? 'Simulated BUY is allowed' : 'NO_TRADE (do not buy now)'}. ${decision.buyVotes}/5 votes are BUY.`;
  const riskLine = `Estimated rug risk: 5m ${fmt(decision.weightedRug?.p5)}%, 10m ${fmt(decision.weightedRug?.p10)}%, 15m ${fmt(decision.weightedRug?.p15)}%.`;

  const hf = decision.hardFilterMeta || decision.hardFilter || null;
  const slippageObs = Number(hf?.syntheticSlippagePct ?? decision?.marketAtDecision?.syntheticSlippagePct);
  const slippageCap = Number(hf?.maxSlippagePct);
  const liqMin = Number(hf?.minLiquidityUsd);

  const filterLine = decision.hardFilter
    ? `Hard filter triggered: ${decision.hardFilter}.${Number.isFinite(slippageObs) ? ` observed slippage=${fmt(slippageObs)}%` : ''}${Number.isFinite(slippageCap) ? ` vs cap=${fmt(slippageCap)}%` : ''}${Number.isFinite(liqMin) ? ` | min liquidity=${fmt(liqMin)} USD` : ''}.`
    : `No hard filter was triggered.${Number.isFinite(slippageObs) ? ` observed slippage=${fmt(slippageObs)}%` : ''}${Number.isFinite(slippageCap) ? ` (cap=${fmt(slippageCap)}%)` : ''}${Number.isFinite(liqMin) ? ` | min liquidity=${fmt(liqMin)} USD` : ''}`;

  const perAgent = agentOutputs.length
    ? `<ul class="agent-reasons">${agentOutputs
      .map((a) => {
        const peerBuy = Number(a?.peerPrediction?.peerBuyProb);
        const peerLine = Number.isFinite(peerBuy)
          ? `Predicted peer BUY: ${(peerBuy * 100).toFixed(1)}%`
          : 'Predicted peer BUY: -';
        const debateLine = a?.debate?.challenger
          ? `Debate vs ${a.debate.challenger}: ${a.debate.rebuttal || a.debate.challenge}`
          : 'No debate data';
        return `<li><b>${a.agent}</b>: vote=${a.vote}, reason=${a.reason}. Warning: ${a.key_warning}. Confidence ${fmt(a.confidence)}%. ${peerLine}. ${debateLine}</li>`;
      })
      .join('')}</ul>`
    : '<div class="small">No per-agent details yet.</div>';

  const exp = decision.explanation || null;
  const evidence = exp?.evidenceWeights
    ? `<div class="small">Evidence weights — risk: ${fmt(exp.evidenceWeights.risk)}%, liquidity: ${fmt(exp.evidenceWeights.liquidity)}%, momentum: ${fmt(exp.evidenceWeights.momentum)}%, flow: ${fmt(exp.evidenceWeights.flow)}%.</div>`
    : '';
  const conflicts = Array.isArray(exp?.conflicts) && exp.conflicts.length
    ? `<ul class="agent-reasons">${exp.conflicts.map((c) => `<li><b>${c.type}</b>: ${c.detail}</li>`).join('')}</ul>`
    : '<div class="small">No conflict signals in this round.</div>';

  const btsLine = exp?.bts
    ? `<div class="small">${exp.bts.protocol} | peer-buy mean=${fmt(exp.bts.peerBuyPredictionMean)} | dispersion=${fmt(exp.bts.peerBuyPredictionDispersion)} | top contrarian=${exp.bts.topContrarianRiskAgent?.agent || '-'}</div>`
    : '';

  const debateLine = exp?.debate
    ? `<div class="small">Debate rounds=${fmt(exp.debate.rounds)} | engaged agents=${fmt(exp.debate.engagedAgents)} | challengers=${(exp.debate.challengers || []).join(', ') || '-'}</div>`
    : '';

  const decisionToken = renderTokenCell({ token: decision.token, contract: decision.contract });

  const qualityBadge = renderDataQualityBadge(decision.marketAtDecision || {});

  return `
    <div>${badge(decision.decision, cls)} ${badge(`BUY votes: ${decision.buyVotes}`, 'ok')} ${qualityBadge}</div>
    <div class="small">Token: ${decisionToken} | Time: ${decision.ts}</div>
    <p>${voteLine}</p>
    <p>${riskLine}</p>
    <p>${filterLine}</p>
    ${evidence}
    ${btsLine}
    ${debateLine}
    <h4>Decision conflicts</h4>
    ${conflicts}
    <h4>Per-agent reasons</h4>
    ${perAgent}
  `;
}

function renderNoTradeReasonSummary(summary = {}, cfg = {}) {
  const reasons = Array.isArray(summary?.reasons) ? summary.reasons : [];
  const noTradeCount = Number(summary?.noTradeCount || 0);
  const windowSize = Number(summary?.windowSize || 0);

  if (!reasons.length) {
    return `<div class="small">No-trade reasons (latest ${windowSize || ROW_LIMIT}): no NO_TRADE samples yet.</div>`;
  }

  const top = reasons.slice(0, 3)
    .map((r) => `${r.reason} ${fmt(r.count)} (${fmt(r.ratePct)}%)`)
    .join(' | ');

  const topReason = reasons[0];
  let suggestion = 'Current thresholds look balanced.';

  if (topReason?.reason === 'SLIPPAGE_TOO_HIGH' && Number(topReason.ratePct || 0) >= 60) {
    const solCap = Number(cfg?.simulation?.maxSlippagePctByChain?.sol ?? cfg?.simulation?.maxSlippagePct ?? 3);
    suggestion = `Suggestion: SLIPPAGE dominates (${fmt(topReason.ratePct)}%). For demo mode, raise SOL slippage cap from ${fmt(solCap)}% to ${fmt(solCap + 3)}% and compare outcome.`;
  } else if (topReason?.reason === 'LIQUIDITY_TOO_LOW' && Number(topReason.ratePct || 0) >= 60) {
    const solLiq = Number(cfg?.simulation?.minLiquidityUsdByChain?.sol ?? cfg?.simulation?.minLiquidityUsd ?? 1000);
    suggestion = `Suggestion: LIQUIDITY dominates (${fmt(topReason.ratePct)}%). For demo mode, lower SOL min-liquidity from ${fmt(solLiq)} to ${fmt(Math.max(200, solLiq / 2))} and verify risk impact.`;
  }

  return `<div class="small">No-trade reasons (latest ${windowSize} decisions, NO_TRADE=${noTradeCount}): ${top}<br/>${suggestion}</div>`;
}

function renderKpis(kpis = {}) {
  return [
    badge(`Rug Catch ${fmt(kpis.rugCatchRatePct)}% (n=${fmt(kpis.rugCatchSamples)})`, 'ok'),
    badge(`SIM_BUY Safety ${fmt(kpis.simBuySafetyRatePct)}% (n=${fmt(kpis.simBuySamples)})`, 'ok'),
    badge(`Avg DD ${fmt(kpis.avgDrawdownPct)}%`, 'warn'),
    badge(`Market OK ${fmt(kpis.marketDataSuccessRatePct)}%`, 'ok'),
    badge(`Launchpad OK ${fmt(kpis.launchpadDataSuccessRatePct)}%`, 'ok'),
    badge(`Open ${fmt(kpis.openPositions)}`, kpis.openPositions > 0 ? 'ok' : 'warn'),
    badge(`Top NO_TRADE ${kpis.topNoTradeReason || '-'} (${fmt(kpis.topNoTradeReasonRatePct)}%)`, 'warn'),
    badge(`Uptime ${fmt(kpis.uptimeMinutes)}m`, 'ok')
  ].join(' ');
}

function renderDataQualityBadge(signal = {}) {
  if (!signal || typeof signal !== 'object') return badge('quality: unknown', 'warn');

  if (signal.synthetic) return badge('quality: synthetic', 'bad');
  if (signal.stale) return badge('quality: stale', 'warn');

  const q = String(signal.dataQuality || '').toLowerCase();
  if (q === 'real') return badge('quality: real', 'ok');
  if (q.includes('partial')) return badge('quality: partial', 'warn');
  return badge(`quality: ${q || 'unknown'}`, 'warn');
}

function renderTable(rows, cols) {
  if (!rows || !rows.length) return '<div class="small">No data.</div>';
  const head = cols.map((c) => `<th>${c.label}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${cols.map((c) => {
      const cell = typeof c.render === 'function' ? c.render(row) : fmt(row[c.key]);
      return `<td>${cell}</td>`;
    }).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function fmtAge(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return '-';
  const s = Number(sec);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function renderFitnessNarrative(latestFitness, agentMemoryOverview = []) {
  const ranking = Array.isArray(latestFitness?.ranking) ? latestFitness.ranking : [];
  if (!ranking.length) return '<div class="small">No evolution ranking yet.</div>';

  const leader = ranking[0];
  const weakest = ranking[ranking.length - 1];

  const memoryByAgent = Object.fromEntries((agentMemoryOverview || []).map((x) => [x.agent, x]));

  const lines = ranking.map((r, idx) => {
    const m = memoryByAgent[r.agent] || {};
    return `<li><b>#${idx + 1} ${r.agent}</b> (${m.instanceId || `${r.agent}#1`}): fitness ${pct01(r.fitness)}, directional accuracy ${pct01(r.directionAcc)}, calibration ${pct01(r.calibration)}, stability ${pct01(r.stability)}, BTS accuracy ${pct01(r.btsAccuracy)}, contrarian hit ${pct01(r.contrarianRate)}, samples ${fmt(r.sampleCount)}, excluded synthetic ${fmt(r.excludedSynthetic || 0)}.</li>`;
  }).join('');

  const suggestion = latestFitness?.replacementSuggestion
    ? `System suggestion: review ${latestFitness.replacementSuggestion.weakest}. ${latestFitness.replacementSuggestion.reason}. ${latestFitness.replacementSuggestion.suggestion}`
    : 'No replacement suggestion at this time.';

  return `
    <div class="small">Latest evolution evaluation time: ${latestFitness.ts || '-'} | scoring mode: ${latestFitness.scoringMode || 'real-only'} | excluded synthetic samples: ${fmt(latestFitness.excludedSyntheticTotal || 0)} | protocol: ${latestFitness.votingProtocol || 'BTS-lite'}</div>
    <p>Top performer is <b>${leader.agent}</b> (fitness ${pct01(leader.fitness)}). Current weakest is <b>${weakest.agent}</b> (fitness ${pct01(weakest.fitness)}).</p>
    <ul class="agent-reasons">${lines}</ul>
    <p>${suggestion}</p>
  `;
}

function renderFraudFingerprintStats(stats = {}) {
  const topTags = Array.isArray(stats.topTags) ? stats.topTags : [];
  const topIds = Array.isArray(stats.topFingerprintIds) ? stats.topFingerprintIds : [];
  const headline = `<div class="small">total=${fmt(stats.total)} | rugged=${fmt(stats.rugged)} (${fmt(stats.ruggedRatePct)}%) | synthetic=${fmt(stats.synthetic)} (${fmt(stats.syntheticRatePct)}%) | dominant taxonomy=${stats.dominantTaxonomy || '-'}(${fmt(stats.dominantTaxonomyPct)}%)</div>`;
  const taxonomy = stats.taxonomyAvg || {};
  const taxonomyLine = `<div class="small">Rug taxonomy mix: H=${fmt(taxonomy.H)}% | L=${fmt(taxonomy.L)}% | M=${fmt(taxonomy.M)}% | S=${fmt(taxonomy.S)}%</div>`;

  const tagsTable = renderTable(topTags, [
    { key: 'tag', label: 'Fingerprint Tag' },
    { key: 'count', label: 'Hits' },
    { key: 'rugRatePct', label: 'Rug Rate %' }
  ]);

  const idTable = renderTable(topIds, [
    { key: 'fingerprintId', label: 'Fingerprint ID (Pattern)' },
    { key: 'count', label: 'Hits' },
    { key: 'rugRatePct', label: 'Rug Rate %' }
  ]);

  return `${headline}${taxonomyLine}<h4>Top Tags</h4>${tagsTable}<h4>Top Fingerprint IDs</h4>${idTable}`;
}

function renderShadowEntityGraph(summary = {}) {
  const topFunders = Array.isArray(summary.topFunders) ? summary.topFunders.slice(0, ROW_LIMIT) : [];
  const highRiskTokens = Array.isArray(summary.highRiskTokens) ? summary.highRiskTokens.slice(0, ROW_LIMIT) : [];
  const incidents = Array.isArray(summary.incidents) ? summary.incidents.slice(0, ROW_LIMIT) : [];
  const tax = summary.taxonomyAvg || {};

  return `
    <div class="small">profiles=${fmt(summary.profileCount)} | entities=${fmt(summary.entityCount)} | edges=${fmt(summary.edgeCount)} | dominant taxonomy=${summary.dominantTaxonomy || '-'}(${fmt(summary.dominantTaxonomyPct)}%)</div>
    <div class="small">Shadow taxonomy average: H=${fmt(tax.H)}% | L=${fmt(tax.L)}% | M=${fmt(tax.M)}% | S=${fmt(tax.S)}%</div>
    <h4>Top suspicious funders</h4>
    ${renderTable(topFunders, [
      { key: 'label', label: 'Funder Cluster' },
      { key: 'total', label: 'Cases' },
      { key: 'rugged', label: 'Rugged' },
      { key: 'rugRatePct', label: 'Rug Rate %' },
      { key: 'linkedTokens', label: 'Linked Tokens' }
    ])}
    <h4>High-risk lineage tokens</h4>
    ${renderTable(highRiskTokens, [
      { key: 'token', label: 'Token', render: (row) => renderTokenCell(row, 'token') },
      { key: 'lineageRiskScore', label: 'Lineage Risk' },
      { key: 'lineageLabel', label: 'Cluster Label' },
      { key: 'dominantTaxonomy', label: 'Taxonomy' },
      { key: 'latestFingerprintId', label: 'Fingerprint ID' }
    ])}
    <h4>Recent lineage incidents</h4>
    ${renderTable(incidents, [
      { key: 'ts', label: 'Time' },
      { key: 'token', label: 'Token', render: (row) => renderTokenCell(row, 'token') },
      { key: 'lineageRiskScore', label: 'Risk' },
      { key: 'lineageLabel', label: 'Label' },
      { key: 'dominantTaxonomy', label: 'Taxonomy' },
      { key: 'fingerprintId', label: 'FP ID' }
    ])}
  `;
}

function renderAgentEvolutionBoard(overview = [], lifecycle = []) {
  const byAgent = Array.isArray(overview) ? overview : [];
  const life = Array.isArray(lifecycle) ? lifecycle : [];

  const summaryRows = byAgent.map((x) => ({
    agent: x.agent,
    instance: x.instanceId,
    generation: x.generation,
    experiences: x.experiences,
    summaries: x.summaries,
    longTerm: x.longTerm,
    replacements: x.replacements
  }));

  const lifecycleRows = life.slice(0, ROW_LIMIT).map((x) => ({
    ts: x.ts,
    type: x.type,
    agent: x.agent,
    generation: x.generation || x.newGeneration || x.retiredGeneration,
    reason: x.reason || '-'
  }));

  return `
    <h4>Agent evolution board</h4>
    ${renderTable(summaryRows, [
      { key: 'agent', label: 'Agent' },
      { key: 'instance', label: 'Instance' },
      { key: 'generation', label: 'Gen' },
      { key: 'experiences', label: 'Experiences' },
      { key: 'summaries', label: 'Summaries' },
      { key: 'longTerm', label: 'Long-term' },
      { key: 'replacements', label: 'Replacements' }
    ])}
    <h4>Recent lifecycle events</h4>
    ${renderTable(lifecycleRows, [
      { key: 'ts', label: 'Time' },
      { key: 'type', label: 'Event' },
      { key: 'agent', label: 'Agent' },
      { key: 'generation', label: 'Gen' },
      { key: 'reason', label: 'Reason' }
    ])}
  `;
}

async function copyText(text) {
  const value = String(text || '').trim();
  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function downloadTextFile(filename, content, mimeType = 'text/plain') {
  const blob = new Blob([String(content || '')], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function launchpadFilters() {
  return {
    limit: Number($('lpLimit')?.value || 20),
    ageMaxSec: Number($('lpAgeMaxSec')?.value || 7200),
    minLiquidityUsd: Number($('lpMinLiquidityUsd')?.value || 0),
    hideHighRisk: $('lpHideHighRisk')?.checked ? 1 : 0,
    keyword: String($('lpKeyword')?.value || '').trim()
  };
}

async function refreshLaunchpad(options = {}) {
  if (!$('launchpadSection')) return;
  const notify = Boolean(options.notify);
  const f = launchpadFilters();
  const qs = new URLSearchParams({
    limit: String(f.limit),
    ageMaxSec: String(f.ageMaxSec),
    minLiquidityUsd: String(f.minLiquidityUsd),
    hideHighRisk: String(f.hideHighRisk),
    keyword: f.keyword
  });

  try {
    const r = await fetch(`/api/launchpad-sol?${qs.toString()}`);
    const out = await r.json();
    if (!out.ok) {
      $('launchpadStatus').textContent = `Scanner error: ${out.error || 'unknown error'}`;
      $('launchpadSection').innerHTML = '<div class="small">Failed to load launchpad data.</div>';
      if (notify) showToast(`Launchpad scanner failed: ${out.error || 'unknown error'}`, 'error');
      return;
    }

    $('launchpadStatus').textContent = out.degraded
      ? `Degraded mode (${out.error || 'upstream unavailable'}) · updated ${out.ts}`
      : `Live mode · ${out.count} matched · updated ${out.ts}`;

    if (notify) {
      showToast(`Launchpad scanner refreshed: ${out.count} result(s)`, out.degraded ? 'warn' : 'success');
    }

    const rows = (out.items || []).map((x) => {
      const isSynthetic = String(x.contract || '').startsWith('synthetic_');

      return {
        age: fmtAge(x.ageSec),
        symbol: x.symbol,
        name: x.name,
        contract: x.contract,
        platform: x.platform,
        liquidityUsd: x.liquidityUsd,
        marketCapUsd: x.marketCapUsd,
        volumeUsd: x.volumeUsd,
        holders: x.holders,
        risk: isSynthetic ? `${x.riskLevel} (synthetic)` : x.riskLevel
      };
    });

    $('launchpadSection').innerHTML = renderTable(rows, [
      { key: 'age', label: 'Age' },
      { key: 'symbol', label: 'Symbol', render: (row) => renderTokenCell(row, 'symbol') },
      { key: 'name', label: 'Name', render: (row) => renderTokenCell(row, 'name') },
      { key: 'platform', label: 'Platform' },
      { key: 'liquidityUsd', label: 'Liquidity USD' },
      { key: 'marketCapUsd', label: 'Market Cap USD' },
      { key: 'volumeUsd', label: 'Volume USD' },
      { key: 'holders', label: 'Holders' },
      { key: 'risk', label: 'Risk' }
    ]);
  } catch (err) {
    $('launchpadStatus').textContent = `Scanner error: ${err.message || 'request failed'}`;
    $('launchpadSection').innerHTML = '<div class="small">Failed to load launchpad data.</div>';
    if (notify) showToast(`Launchpad scanner failed: ${err.message || 'request failed'}`, 'error');
  }
}

function render(state) {
  latestState = state;

  const degraded = state.runtime?.degradedMarketMode ? badge('Degraded Market Mode', 'warn') : badge('Live Market Mode', 'ok');
  const lpMode = state.runtime?.degradedLaunchpadMode ? badge('Launchpad Degraded', 'warn') : badge('Launchpad Live', 'ok');
  const ks = state.config?.yield?.killSwitch ? badge('KILL SWITCH ON', 'bad') : badge('Kill Switch Off', 'ok');
  const demoMode = state.config?.runtime?.demoMode ? badge('DEMO MODE', 'warn') : badge('SAFE MODE', 'ok');
  const paused = state.simAccount?.tradingPaused ? badge(`Trading Paused: ${state.simAccount.pauseReason || 'RISK'}`, 'bad') : badge('Trading Active', 'ok');
  const balanceLine = `available=${fmt(state.simAccount?.availableUsdc)} USDC equity=${fmt(state.simAccount?.equityUsdc)} DD=${fmt(state.simAccount?.maxDrawdownPct)}%`;

  $('statusBar').innerHTML = `${degraded} ${lpMode} ${demoMode} ${ks} ${paused} <span class="small">${balanceLine} | snapshots=${state.counts.snapshots} decisions=${state.counts.decisions}</span>`;

  if ($('kpiBar')) {
    $('kpiBar').innerHTML = renderKpis(state.kpis || {});
  }

  const auto = state.runtime?.autoAnalyze || {};
  if ($('autoAnalyzeStatus')) {
    $('autoAnalyzeStatus').textContent = `Auto Analyze: ${auto.enabled ? 'ON' : 'OFF'} · interval=${fmt((Number(auto.intervalMs || 0) / 60000))}m · perRun=${fmt(auto.candidatesPerRun)} · lastRun=${auto.lastRunAt || '-'} · lastCount=${fmt(auto.analyzedCount || 0)}${auto.skipped ? ` · lastSkip=${auto.skipped}` : ''}${auto.error ? ` · error=${auto.error}` : ''}`;
  }

  $('latestDecision').innerHTML = renderDecision(state.latestDecision, state.latestAgentOutputs || []);
  if ($('noTradeSummary')) {
    $('noTradeSummary').innerHTML = renderNoTradeReasonSummary(state.noTradeReasonSummary || {}, state.config || {});
  }

  $('openPositions').innerHTML = renderTable((state.openPositions || []).slice(0, ROW_LIMIT), [
    { key: 'id', label: 'ID' },
    { key: 'token', label: 'Token', render: (row) => renderTokenCell(row, 'token') },
    { key: 'entryPrice', label: 'Entry Exec' },
    { key: 'currentExecPrice', label: 'Current Exec' },
    { key: 'currentSlippageBps', label: 'Slip bps' },
    { key: 'entryFeeUsdc', label: 'Entry Fee' },
    { key: 'estExitFeeUsdc', label: 'Est Exit Fee' },
    { key: 'pnlPct', label: 'PnL %' },
    { key: 'pnlUsdc', label: 'PnL USDC' }
  ]);

  $('closedPositions').innerHTML = renderTable((state.closedPositions || []).slice(0, ROW_LIMIT), [
    { key: 'id', label: 'ID' },
    { key: 'token', label: 'Token', render: (row) => renderTokenCell(row, 'token') },
    { key: 'pnlPct', label: 'PnL %' },
    { key: 'pnlUsdc', label: 'PnL USDC' },
    { key: 'totalFeesUsdc', label: 'Total Fees' },
    { key: 'closeReason', label: 'Reason' },
    { key: 'closedAt', label: 'Closed At' }
  ]);

  const verifyRows = (state.verifyResults || []).slice(0, ROW_LIMIT).map((r) => ({
    ...r,
    quality: `${String(r?.signalAtVerify?.dataQuality || (r?.signalAtVerify?.synthetic ? 'synthetic' : 'unknown'))}${r?.signalAtVerify?.stale ? ' (stale)' : ''}`
  }));

  $('verifyResults').innerHTML = renderTable(verifyRows, [
    { key: 'decisionId', label: 'Decision' },
    { key: 'token', label: 'Token', render: (row) => renderTokenCell(row, 'token') },
    { key: 'verdict', label: 'Verdict' },
    { key: 'quality', label: 'Data Quality' },
    { key: 'drawdownPct', label: 'Drawdown %' },
    { key: 'ts', label: 'Time' }
  ]);

  $('rewardResults').innerHTML = renderTable((state.rewards || []).slice(0, ROW_LIMIT), [
    { key: 'id', label: 'Reward ID' },
    { key: 'decisionId', label: 'Decision' },
    { key: 'amountUsdc', label: 'USDC' },
    { key: 'status', label: 'Status' },
    { key: 'ts', label: 'Time' }
  ]);

  if ($('fraudFingerprintStats')) {
    $('fraudFingerprintStats').innerHTML = renderFraudFingerprintStats(state.fraudFingerprintStats || {});
  }
  if ($('fraudFingerprintList')) {
    const fpRows = (state.fraudFingerprints || []).slice(0, ROW_LIMIT).map((r) => ({
      ...r,
      tags: (r.tags || []).join(', '),
      instructionSequence: (r.instructionSequence || []).join(' > '),
      taxonomyMix: r.taxonomy?.mix ? `H ${fmt(r.taxonomy.mix.H)} / L ${fmt(r.taxonomy.mix.L)} / M ${fmt(r.taxonomy.mix.M)} / S ${fmt(r.taxonomy.mix.S)}` : '-',
      taxonomyDominant: r.taxonomy ? `${r.taxonomy.dominantClass} (${fmt(r.taxonomy.dominantPct)}%)` : '-',
      similar: (r.similarCases || []).map((x) => `${x.token || '-'}${x.fingerprintId ? ` ${x.fingerprintId}` : ''}(${fmt(x.scorePct)}%)`).join(' ; ') || '-',
      similarExplanation: r.similarExplanation || '-'
    }));

    $('fraudFingerprintList').innerHTML = renderTable(fpRows, [
      { key: 'ts', label: 'Time' },
      { key: 'id', label: 'Case ID' },
      { key: 'token', label: 'Token', render: (row) => renderTokenCell(row, 'token') },
      { key: 'verdict', label: 'Verdict' },
      { key: 'fingerprintId', label: 'Fingerprint ID (Pattern)' },
      { key: 'taxonomyDominant', label: 'Dominant Taxonomy' },
      { key: 'cause', label: 'Cause' },
      { key: 'fingerprintScore', label: 'Score' },
      { key: 'instructionSequence', label: 'Instruction Sequence' },
      { key: 'taxonomyMix', label: 'Taxonomy Mix' },
      { key: 'tags', label: 'Tags' },
      { key: 'similar', label: 'Top Similar Cases' },
      { key: 'similarExplanation', label: 'Hit Explanation' }
    ]);
  }

  if ($('shadowGraphSection')) {
    $('shadowGraphSection').innerHTML = renderShadowEntityGraph(state.shadowGraphSummary || {});
  }

  const ys = state.yieldSummary || {};
  const rs = state.rewardSummary || {};
  $('yieldSection').innerHTML = `
    <div class="small">minAPY=${state.config.yield.minApyPct}% | singleCap=${state.config.yield.singleOrderCapPct}% | dailyCap=${state.config.yield.dailyNewExposureCapPct}% | protocolCap=${state.config.yield.perProtocolExposureCapPct}%</div>
    <div class="small">allocation=${state.config.yield.allocationMode || 'reward_only'} | balanceReinvestPct=${fmt(state.config.yield.balanceReinvestPct)}% | balanceReinvestCapPct=${fmt(state.config.yield.balanceReinvestCapPct)}%</div>
    <div class="small">Yield balance: principal=${fmt(ys.principalUsdc)} USDC | est. accrued=${fmt(ys.estimatedAccruedUsdc)} USDC | est. total=${fmt(ys.estimatedBalanceUsdc)} USDC</div>
    <div class="small">Yield rate: weighted APY=${fmt(ys.weightedApyPct)}% | est. daily yield=${fmt(ys.estimatedDailyYieldUsdc)} USDC/day | active orders=${fmt(ys.activeOrders)} | updated=${ys.computedAt || '-'}</div>
    <div class="small">Reward summary: total rewards=${fmt(rs.totalRewards)} | settled=${fmt(rs.settledRewards)} | cumulative reward=${fmt(rs.totalRewardUsdc)} USDC | last reward=${rs.lastRewardAt || '-'} | payout mode=micro-incentive(0.001 USDC)</div>
    ${renderTable((state.yieldOrders || []).slice(0, ROW_LIMIT).map((o) => ({
      ...o,
      allocationMode: o?.allocationMeta?.mode || '-',
      balanceComponentUsdc: o?.allocationMeta?.balanceComponentUsdc ?? 0
    })), [
      { key: 'id', label: 'Order ID' },
      { key: 'protocol', label: 'Protocol' },
      { key: 'amountUsdc', label: 'Amount' },
      { key: 'apyPct', label: 'APY%' },
      { key: 'allocationMode', label: 'Allocation Mode' },
      { key: 'balanceComponentUsdc', label: 'Balance Component' },
      { key: 'productSource', label: 'Source' },
      { key: 'active', label: 'Active' },
      { key: 'openedAt', label: 'Opened' }
    ])}
  `;

  const fitnessText = state.latestFitness
    ? renderFitnessNarrative(state.latestFitness, state.agentMemoryOverview || [])
    : '<div class="small">No evolution run yet.</div>';
  const backtest = state.backtest
    ? `<div class="small">Backtest(100, ${state.backtest.scoringMode || 'real-only'}): verified=${fmt(state.backtest.verified)}, excluded synthetic=${fmt(state.backtest.excludedSynthetic || 0)}, no-trade rug catch=${fmt(state.backtest.noTradeRugCatchRate)}%, sim-buy safety=${fmt(state.backtest.simBuySafetyRate)}%, avg drawdown=${fmt(state.backtest.avgDrawdownPct)}%.</div>`
    : '';
  const regression = state.regression?.ok
    ? '<div class="small">Regression checks: PASS</div>'
    : `<div class="small">Regression checks: FAIL (${(state.regression?.failures || []).join('; ')})</div>`;
  const evolutionBoard = renderAgentEvolutionBoard(state.agentMemoryOverview || [], state.agentMemoryLifecycle || []);
  $('fitnessSection').innerHTML = `${fitnessText}${backtest}${regression}${evolutionBoard}`;

  $('eventList').innerHTML = renderTable((state.events || []).slice(0, ROW_LIMIT), [
    { key: 'ts', label: 'Time' },
    { key: 'type', label: 'Type' }
  ]);
}

async function refresh() {
  const r = await fetch('/api/state');
  const data = await r.json();
  render(data);
}

function startSSE() {
  const es = new EventSource('/api/stream');
  es.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    render(data);
  };
  es.onerror = () => {
    // fallback polling
    setTimeout(refresh, 3000);
  };
}

$('analyzeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    token: $('token').value,
    chain: $('chain').value,
    orderPct: Number($('orderPct').value || 1),
    userVotes: [$('userVote1').value, $('userVote2').value]
  };

  try {
    const r = await fetch('/api/analyze-and-vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const out = await r.json();
    if (!out.ok) {
      showToast(out.error || 'Analyze failed', 'error');
    } else {
      showToast(`Analyze finished: ${out.decision?.decision || 'done'}`, 'success');
    }
    refresh();
  } catch (err) {
    showToast(`Analyze request failed: ${err.message || 'network error'}`, 'error');
  }
});

$('runEvolutionBtn').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/run-evolution', { method: 'POST' });
    const out = await r.json();
    showToast(out.ok ? 'Evolution run completed' : (out.error || 'Evolution run failed'), out.ok ? 'success' : 'error');
    refresh();
  } catch (err) {
    showToast(`Evolution request failed: ${err.message || 'network error'}`, 'error');
  }
});

$('toggleKillBtn').addEventListener('click', async () => {
  const enabled = !latestState?.config?.yield?.killSwitch;
  try {
    const r = await fetch('/api/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const out = await r.json();
    showToast(out.ok ? `Kill switch ${out.killSwitch ? 'enabled' : 'disabled'}` : (out.error || 'Kill switch update failed'), out.ok ? 'warn' : 'error');
    refresh();
  } catch (err) {
    showToast(`Kill switch update failed: ${err.message || 'network error'}`, 'error');
  }
});

$('toggleAutoAnalyzeBtn')?.addEventListener('click', async () => {
  const enabled = !latestState?.runtime?.autoAnalyze?.enabled;
  try {
    const r = await fetch('/api/auto-analyze/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const out = await r.json();
    showToast(out.ok ? `Auto Analyze ${enabled ? 'enabled' : 'disabled'}` : (out.error || 'Auto Analyze toggle failed'), out.ok ? 'success' : 'error');
    refresh();
  } catch (err) {
    showToast(`Auto Analyze toggle failed: ${err.message || 'network error'}`, 'error');
  }
});

$('runAutoAnalyzeBtn')?.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/auto-analyze/run', { method: 'POST' });
    const out = await r.json();
    if (!out.ok) {
      showToast(out.error || 'Auto Analyze run failed', 'error');
      return;
    }

    const analyzedCount = Array.isArray(out.analyzed) ? out.analyzed.length : 0;
    showToast(`Auto Analyze run completed: ${analyzedCount} token(s) analyzed`, analyzedCount > 0 ? 'success' : 'warn');
    refresh();
  } catch (err) {
    showToast(`Auto Analyze run failed: ${err.message || 'network error'}`, 'error');
  }
});

$('toggleDemoModeBtn')?.addEventListener('click', async () => {
  const enabled = !latestState?.config?.runtime?.demoMode;
  try {
    const r = await fetch('/api/demo-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const out = await r.json();
    if (!out.ok) {
      showToast(out.error || 'Demo mode update failed', 'error');
      return;
    }

    showToast(`Mode switched to ${out.demoMode?.mode || (enabled ? 'demo' : 'safe')} (SOL slippage cap=${fmt(out.demoMode?.solMaxSlippagePct)}%)`, 'success');
    refresh();
  } catch (err) {
    showToast(`Demo mode update failed: ${err.message || 'network error'}`, 'error');
  }
});

$('runDemoScenarioBtn')?.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/demo/run', { method: 'POST' });
    const out = await r.json();
    if (!out.ok) {
      showToast(out.error || 'Demo scenario failed', 'error');
      return;
    }

    const sel = out.selected || {};
    showToast(`Demo run done: ${sel.token || '-'} | ${sel.decision || '-'} | verify=${sel.verifyVerdict || '-'}${sel.rewardId ? ' | reward triggered' : ''}`, sel.rewardId ? 'success' : 'warn', 5500);
    refresh();
  } catch (err) {
    showToast(`Demo scenario failed: ${err.message || 'network error'}`, 'error');
  }
});

$('exportReportJsonBtn')?.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/report?format=json');
    const out = await r.json();
    if (!out.ok) {
      showToast(out.error || 'Report export failed', 'error');
      return;
    }
    downloadTextFile(`rugsense-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(out.report, null, 2), 'application/json');
    showToast('Report JSON exported', 'success');
  } catch (err) {
    showToast(`Report export failed: ${err.message || 'network error'}`, 'error');
  }
});

$('exportReportMdBtn')?.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/report?format=md');
    const md = await r.text();
    downloadTextFile(`rugsense-report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`, md, 'text/markdown');
    showToast('Report markdown exported', 'success');
  } catch (err) {
    showToast(`Report export failed: ${err.message || 'network error'}`, 'error');
  }
});

$('topupBtn')?.addEventListener('click', async () => {
  const amountUsdc = Number($('topupAmountUsdc')?.value || 0);
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    showToast('Please enter a positive top-up amount', 'warn');
    return;
  }

  try {
    const r = await fetch('/api/sim-account/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountUsdc })
    });
    const out = await r.json();
    if (!out.ok) {
      showToast(out.error || 'Top-up failed', 'error');
      return;
    }

    $('topupAmountUsdc').value = '';
    showToast(`Top-up successful: +${amountUsdc} USDC`, 'success');
    refresh();
  } catch (err) {
    showToast(`Top-up failed: ${err.message || 'network error'}`, 'error');
  }
});

$('lpRefreshBtn')?.addEventListener('click', () => refreshLaunchpad({ notify: true }));
['lpLimit', 'lpAgeMaxSec', 'lpMinLiquidityUsd', 'lpHideHighRisk', 'lpKeyword'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  const evt = id === 'lpKeyword' ? 'input' : 'change';
  el.addEventListener(evt, () => {
    refreshLaunchpad();
  });
});

document.addEventListener('click', async (e) => {
  const synthetic = e.target.closest('.symbol-chip.synthetic');
  if (synthetic) {
    showToast('Synthetic fallback row: no real contract address to copy', 'warn');
    return;
  }

  const btn = e.target.closest('.copy-symbol-btn');
  if (!btn) return;

  const contract = btn.getAttribute('data-contract') || '';
  const symbol = btn.getAttribute('data-symbol') || 'token';
  const ok = await copyText(contract);
  showToast(
    ok ? `Copied ${symbol} contract` : `Copy failed: ${contract}`,
    ok ? 'success' : 'error'
  );
});

refresh();
refreshLaunchpad();
setInterval(refreshLaunchpad, 30000);
startSSE();
