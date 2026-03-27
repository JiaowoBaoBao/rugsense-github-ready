# QUICKSTART (5 Minutes)

This guide gets RugSense running quickly for reviewers and first-time users.

## 1) Prerequisites

- Node.js `>= 18` (recommended: Node 20+)
- npm
- macOS/Linux/WSL

Check:

```bash
node -v
npm -v
```

## 2) Install & Run

```bash
npm install
npm run dev
```

Open:

- Dashboard: `http://localhost:3781`
- Health check: `http://localhost:3781/api/health`

## 3) Run a full demo flow

In the dashboard:

1. Click **Toggle Demo Mode** (switch to `DEMO MODE`)
2. Click **Run Demo E2E**
3. Observe results in:
   - Latest Decision
   - Verifications
   - Reward Events
   - Yield Agent

## 4) Export demo evidence

Use dashboard buttons:

- **Export Report JSON**
- **Export Report MD**

Or via API:

```bash
curl -s http://localhost:3781/api/report?format=json
curl -s http://localhost:3781/api/report?format=md
```

## 5) Optional CLI demo shortcut

```bash
bash scripts/demo.sh
```

## 6) Reset back to safety mode

- Click **Toggle Demo Mode** again (switch to `SAFE MODE`), or

```bash
curl -s -X POST http://localhost:3781/api/demo-mode \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
```
