const fs = require('fs');
const path = require('path');
const defaultConfig = require('../config/default');
const { nowIso } = require('../utils/helpers');
const { deepMerge } = require('../utils/merge');

const DATA_DIR = path.join(process.cwd(), 'data');

const TABLES = {
  snapshots: [],
  agent_outputs: [],
  vote_decisions: [],
  sim_positions: [],
  sim_account: null,
  verify_results: [],
  fraud_fingerprints: [],
  shadow_entity_graph: {
    version: 1,
    updatedAt: nowIso(),
    entities: {},
    edges: {},
    tokenProfiles: {},
    incidents: []
  },
  x402_rewards: [],
  yield_orders: [],
  agent_fitness: [],
  agent_memory: {
    version: 1,
    updatedAt: nowIso(),
    agents: {},
    lifecycle: []
  },
  events: [],
  runtime: { startedAt: nowIso(), degradedMarketMode: false, lastCollectorAt: null },
  config: defaultConfig,
  metadata: { createdAt: nowIso(), version: '3.1.0' }
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function ensureFiles() {
  ensureDir();
  for (const [name, seed] of Object.entries(TABLES)) {
    const fp = filePath(name);
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, JSON.stringify(seed, null, 2));
    }
  }
}

function read(name) {
  ensureFiles();
  const raw = JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  if (name === 'config') {
    return deepMerge(defaultConfig, raw || {});
  }
  return raw;
}

function write(name, value) {
  ensureFiles();
  fs.writeFileSync(filePath(name), JSON.stringify(value, null, 2));
}

function append(name, item) {
  const arr = read(name);
  if (!Array.isArray(arr)) throw new Error(`${name} is not array table`);
  arr.push(item);
  write(name, arr);
  return item;
}

function updateWhere(name, predicateFn, mapFn) {
  const rows = read(name);
  const updated = rows.map((row) => (predicateFn(row) ? mapFn(row) : row));
  write(name, updated);
  return updated;
}

function upsertRuntime(patch) {
  const current = read('runtime');
  const next = deepMerge(current, patch);
  write('runtime', next);
  return next;
}

function updateConfig(patch) {
  const current = read('config');
  const next = deepMerge(current, patch);
  write('config', next);
  return next;
}

function pushEvent(type, payload = {}) {
  const event = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: nowIso(),
    type,
    payload
  };
  append('events', event);
  return event;
}

function latest(name, n = 20) {
  const rows = read(name);
  if (!Array.isArray(rows)) return rows;
  return rows.slice(-n).reverse();
}

module.exports = {
  ensureFiles,
  read,
  write,
  append,
  updateWhere,
  upsertRuntime,
  updateConfig,
  pushEvent,
  latest
};
