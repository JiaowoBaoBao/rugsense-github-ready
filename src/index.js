const express = require('express');
const path = require('path');
const defaultConfig = require('./config/default');
const db = require('./store/db');
const { RugSenseEngine } = require('./engine/rugsenseEngine');
const { createApiRouter } = require('./routes/api');
const { acquireSchedulerLock, releaseSchedulerLock } = require('./services/schedulerLockService');

async function bootstrap() {
  db.ensureFiles();
  const config = db.read('config') || defaultConfig;

  const app = express();
  const engine = new RugSenseEngine();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.use('/api', createApiRouter(engine));

  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const push = () => {
      try {
        const payload = engine.getState();
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (e) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
      }
    };

    push();
    const interval = setInterval(push, config.runtime.sseIntervalMs || 5000);

    req.on('close', () => {
      clearInterval(interval);
      res.end();
    });
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });

  const port = config.app.port;
  const lockPath = path.join(process.cwd(), 'data', '.scheduler.leader.lock');

  let isSchedulerLeader = false;
  let leaderProbeTimer = null;

  const markRuntimeScheduler = (patch = {}) => {
    db.upsertRuntime({
      scheduler: {
        leader: isSchedulerLeader,
        lockPath,
        pid: process.pid,
        checkedAt: new Date().toISOString(),
        ...patch
      }
    });
  };

  const startLeaderSchedulers = async (meta = {}) => {
    if (isSchedulerLeader) return;
    isSchedulerLeader = true;

    engine.startSchedulers();
    await engine.collectMarketSnapshot().catch(() => null);

    markRuntimeScheduler({
      leader: true,
      holderPid: process.pid,
      holderHost: meta.host || null,
      recoveredStale: Boolean(meta.recoveredStale)
    });

    db.pushEvent('SCHEDULER_LEADER_ACQUIRED', {
      pid: process.pid,
      lockPath,
      recoveredStale: Boolean(meta.recoveredStale)
    });
  };

  const attemptLeadership = async () => {
    const result = acquireSchedulerLock(lockPath);
    if (result.leader) {
      await startLeaderSchedulers({
        host: result.payload?.host,
        recoveredStale: result.recoveredStale
      });
      return true;
    }

    markRuntimeScheduler({
      leader: false,
      holderPid: result.holder?.pid || null,
      holderHost: result.holder?.host || null,
      holderAcquiredAt: result.holder?.acquiredAt || null
    });
    return false;
  };

  const hasLeader = await attemptLeadership();

  if (!hasLeader) {
    db.pushEvent('SCHEDULER_FOLLOWER_MODE', { pid: process.pid, lockPath });
    leaderProbeTimer = setInterval(() => {
      if (isSchedulerLeader) return;
      attemptLeadership().catch((err) => {
        db.pushEvent('SCHEDULER_LEADER_PROBE_ERROR', { error: err.message });
      });
    }, 60_000);
  }

  const server = app.listen(port, () => {
    db.pushEvent('SERVER_STARTED', { port, schedulerLeader: isSchedulerLeader });
    console.log(`[RugSense] running on http://localhost:${port}`);
  });

  const shutdown = () => {
    if (leaderProbeTimer) {
      clearInterval(leaderProbeTimer);
      leaderProbeTimer = null;
    }

    if (isSchedulerLeader) {
      engine.stopSchedulers();
      const released = releaseSchedulerLock(lockPath);
      db.pushEvent('SCHEDULER_LEADER_RELEASED', {
        pid: process.pid,
        lockPath,
        released: Boolean(released.released)
      });
    }

    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
