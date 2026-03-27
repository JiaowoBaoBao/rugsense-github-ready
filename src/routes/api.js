const express = require('express');
const db = require('../store/db');
const { handleX402RewardRequest } = require('../services/x402ReceiverService');

function createApiRouter(engine) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  router.get('/state', (req, res) => {
    res.json(engine.getState());
  });

  router.get('/positions', (req, res) => {
    const rows = db.read('sim_positions');
    res.json({
      open: rows.filter((r) => r.status === 'OPEN'),
      closed: rows.filter((r) => r.status === 'CLOSED').slice(-50).reverse()
    });
  });

  router.get('/launchpad-sol', async (req, res) => {
    try {
      const out = await engine.getSolLaunchpadScan(req.query || {});
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/events', (req, res) => {
    res.json(db.latest('events', Number(req.query.limit || 100)));
  });

  router.get('/agent-memory', (req, res) => {
    const memory = db.read('agent_memory');
    res.json({ ok: true, memory });
  });

  router.get('/sim-account', (req, res) => {
    const state = engine.getState();
    res.json({ ok: true, simAccount: state.simAccount, backtest: state.backtest, regression: state.regression });
  });

  router.post('/sim-account/topup', (req, res) => {
    try {
      const amountUsdc = Number(req.body?.amountUsdc);
      const simAccount = engine.topUpSimAccount(amountUsdc);
      res.json({ ok: true, simAccount });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/auto-analyze/toggle', (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      const autoAnalyze = engine.toggleAutoAnalyze(enabled);
      res.json({ ok: true, autoAnalyze });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/auto-analyze/run', async (req, res) => {
    try {
      const out = await engine.runAutoAnalyzeCycle({ manual: true });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/demo-mode', (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      const mode = engine.setDemoMode(enabled);
      res.json({ ok: true, demoMode: mode });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/demo/run', async (req, res) => {
    try {
      const out = await engine.runDemoScenario();
      res.json(out);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/report', (req, res) => {
    try {
      const report = engine.buildDemoReport();
      const format = String(req.query.format || 'json').toLowerCase();
      if (format === 'md' || format === 'markdown') {
        const lines = [
          `# RugSense Demo Report`,
          ``,
          `- Generated: ${report.generatedAt}`,
          `- Mode: ${report.mode}`,
          ``,
          `## KPIs`,
          `- Rug Catch Rate: ${report.kpis?.rugCatchRatePct ?? '-'}%`,
          `- SIM_BUY Safety Rate: ${report.kpis?.simBuySafetyRatePct ?? '-'}%`,
          `- Avg Drawdown: ${report.kpis?.avgDrawdownPct ?? '-'}%`,
          `- Market Data Success: ${report.kpis?.marketDataSuccessRatePct ?? '-'}%`,
          `- Launchpad Data Success: ${report.kpis?.launchpadDataSuccessRatePct ?? '-'}%`,
          ``,
          `## NO_TRADE Diagnostics`,
          ...(Array.isArray(report.noTradeReasonSummary?.reasons) && report.noTradeReasonSummary.reasons.length
            ? report.noTradeReasonSummary.reasons.map((r) => `- ${r.reason}: ${r.count} (${r.ratePct}%)`)
            : ['- No NO_TRADE reasons in current window']),
          ``,
          `## Reward Summary`,
          `- Total rewards: ${report.rewardSummary?.totalRewards ?? 0}`,
          `- Settled rewards: ${report.rewardSummary?.settledRewards ?? 0}`,
          `- Total reward (USDC): ${report.rewardSummary?.totalRewardUsdc ?? 0}`,
          `- Last reward at: ${report.rewardSummary?.lastRewardAt || '-'}`,
          ``,
          `## Latest Decision`,
          `\`\`\`json`,
          JSON.stringify(report.latestDecision || null, null, 2),
          `\`\`\``
        ];

        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        return res.send(lines.join('\n'));
      }

      return res.json({ ok: true, report });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/upstream-health', (req, res) => {
    const state = engine.getState();
    res.json({ ok: true, bitgetHealth: state.runtime?.bitgetHealth || null });
  });

  router.get('/fraud-fingerprints', (req, res) => {
    const state = engine.getState();
    res.json({ ok: true, stats: state.fraudFingerprintStats, rows: state.fraudFingerprints });
  });

  router.get('/shadow-graph', (req, res) => {
    const state = engine.getState();
    res.json({ ok: true, summary: state.shadowGraphSummary });
  });

  router.post('/analyze-and-vote', async (req, res) => {
    try {
      const out = await engine.analyzeAndVote(req.body || {});
      res.json({ ok: true, ...out });
    } catch (err) {
      db.pushEvent('ANALYZE_ERROR', { error: err.message });
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/config', (req, res) => {
    try {
      const cfg = engine.setConfig(req.body || {});
      res.json({ ok: true, config: cfg });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/kill-switch', (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    const cfg = engine.setKillSwitch(enabled);
    res.json({ ok: true, killSwitch: cfg.yield.killSwitch });
  });

  router.post('/run-verification/:decisionId', async (req, res) => {
    try {
      const out = await engine.runVerification(req.params.decisionId);
      res.json({ ok: true, verification: out });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/run-evolution', (req, res) => {
    try {
      const out = engine.runEvolution();
      res.json({ ok: true, evolution: out });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/x402/reward', async (req, res) => {
    try {
      return await handleX402RewardRequest(req, res, engine.getConfig());
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createApiRouter };
