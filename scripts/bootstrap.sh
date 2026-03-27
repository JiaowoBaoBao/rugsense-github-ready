#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[bootstrap] Working directory: $ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[bootstrap] ERROR: node is required but not found"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[bootstrap] ERROR: npm is required but not found"
  exit 1
fi

echo "[bootstrap] Node version: $(node -v)"
echo "[bootstrap] NPM version:  $(npm -v)"

echo "[bootstrap] Installing dependencies..."
npm install

echo "[bootstrap] Preparing runtime data directory..."
mkdir -p data
[ -f data/.gitkeep ] || touch data/.gitkeep

echo "[bootstrap] Creating local .env from .env.example (if missing)..."
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "[bootstrap] .env created. Fill secrets locally if needed."
fi

echo "[bootstrap] Done. Start server with: npm run dev"
