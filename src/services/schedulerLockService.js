const fs = require('fs');
const os = require('os');
const path = require('path');
const { nowIso } = require('../utils/helpers');

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLock(lockPath) {
  const payload = {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: nowIso()
  };
  fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { flag: 'wx' });
  return payload;
}

function ensureDirFor(lockPath) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function acquireSchedulerLock(lockPath) {
  ensureDirFor(lockPath);

  try {
    const payload = writeLock(lockPath);
    return { leader: true, payload };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    const current = readLock(lockPath);
    if (!current || !isPidAlive(current.pid)) {
      try { fs.unlinkSync(lockPath); } catch {}
      const payload = writeLock(lockPath);
      return { leader: true, payload, recoveredStale: true };
    }

    return { leader: false, holder: current };
  }
}

function releaseSchedulerLock(lockPath) {
  const current = readLock(lockPath);
  if (!current) return { released: false, reason: 'NO_LOCK' };

  if (Number(current.pid) !== Number(process.pid)) {
    return { released: false, reason: 'NOT_OWNER', holder: current };
  }

  try {
    fs.unlinkSync(lockPath);
    return { released: true };
  } catch (err) {
    return { released: false, reason: err.message };
  }
}

module.exports = {
  acquireSchedulerLock,
  releaseSchedulerLock,
  isPidAlive
};
