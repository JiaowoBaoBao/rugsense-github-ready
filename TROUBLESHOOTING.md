# Troubleshooting

## 1) Server does not start / `/api/health` fails

Symptoms:
- `curl: (7) Failed to connect`

Fix:

```bash
pkill -f "node src/index.js" || true
npm run dev
```

Then verify:

```bash
curl -s http://127.0.0.1:3781/api/health
```

---

## 2) Multiple Node processes are running

Symptoms:
- inconsistent dashboard state
- duplicate scheduler behavior

Check:

```bash
pgrep -af "node src/index.js"
```

Fix:

```bash
pkill -f "node src/index.js" || true
npm run dev
```

---

## 3) Demo E2E returns `ok:false`

Common causes:
- temporary upstream data fetch failure
- no valid launchpad candidate in current window

Fix:
1. wait 5-15 seconds
2. run again
3. if still failing, switch mode once:

```bash
curl -s -X POST http://localhost:3781/api/demo-mode -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -s -X POST http://localhost:3781/api/demo-mode -H 'Content-Type: application/json' -d '{"enabled":true}'
```

---

## 4) Yield shows `Active=false` after reward

Possible reason:
- reward exists but deployment was held (`YIELD_HOLD_USDC`) by guardrails (e.g., no product above min APY).

Check recent events:

```bash
curl -s "http://localhost:3781/api/events?limit=30"
```

---

## 5) Dashboard data looks stale

The UI uses SSE stream updates.

Fix:
- hard refresh browser
- verify `/api/stream` reachable
- check server logs

---

## 6) Port conflict on 3781

Either stop conflicting process or change `app.port` in `data/config.json`.

---

## 7) Report export fails

Check endpoint manually:

```bash
curl -s "http://localhost:3781/api/report?format=json"
curl -s "http://localhost:3781/api/report?format=md"
```

If API responds, issue is browser download permission.
