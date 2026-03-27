#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${RUGSENSE_BASE_URL:-http://127.0.0.1:3781}"
OUT_DIR="${RUGSENSE_DEMO_OUT:-./demo-artifacts}"
mkdir -p "$OUT_DIR"

ts="$(date +%Y%m%d-%H%M%S)"

echo "[demo] Base URL: $BASE_URL"

echo "[demo] Health check..."
curl -fsS "$BASE_URL/api/health" | tee "$OUT_DIR/health-$ts.json" >/dev/null

echo "[demo] Enable demo mode..."
curl -fsS -X POST "$BASE_URL/api/demo-mode" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' | tee "$OUT_DIR/demo-mode-on-$ts.json" >/dev/null

echo "[demo] Run end-to-end demo..."
curl -fsS -X POST "$BASE_URL/api/demo/run" | tee "$OUT_DIR/demo-run-$ts.json" >/dev/null

echo "[demo] Export reports..."
curl -fsS "$BASE_URL/api/report?format=json" > "$OUT_DIR/report-$ts.json"
curl -fsS "$BASE_URL/api/report?format=md" > "$OUT_DIR/report-$ts.md"

echo "[demo] Snapshot state/events..."
curl -fsS "$BASE_URL/api/state" > "$OUT_DIR/state-$ts.json"
curl -fsS "$BASE_URL/api/events?limit=50" > "$OUT_DIR/events-$ts.json"

echo "[demo] Done. Artifacts stored in: $OUT_DIR"
ls -la "$OUT_DIR" | sed 's/^/[demo] /'
