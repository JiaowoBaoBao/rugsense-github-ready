const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function id(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, digits = 4) {
  const p = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * p) / p;
}

function hashToUnit(str) {
  const hash = crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 8);
  const intVal = parseInt(hash, 16);
  return (intVal % 10000) / 10000;
}

function pick(arr = []) {
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

module.exports = {
  nowIso,
  nowMs,
  id,
  clamp,
  round,
  hashToUnit,
  pick
};
