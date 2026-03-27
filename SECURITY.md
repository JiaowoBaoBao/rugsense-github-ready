# Security Notes

## 1) Threat model (high level)

RugSense is a simulation-first system with optional settlement integrations.
Primary risks:
- accidental secret exposure
- unsafe config changes
- external API instability
- over-privileged runtime environments

## 2) Secret handling

- Never commit private keys, mnemonics, API keys, or auth tokens.
- Use environment variables (`.env` locally, never committed).
- Keep `.env.example` placeholders only.

## 3) Runtime data hygiene

- Runtime state under `data/*.json` is excluded from Git.
- Public repo should keep `data/.gitkeep` only.

## 4) Network and execution safety

- Default mode is simulation.
- Keep direct transfer in `dryRun=true` unless explicitly required.
- Validate external endpoints before enabling strict settlement mode.

## 5) Principle of least privilege

- Restrict wallet permissions and key scope.
- Use dedicated low-balance demo wallets for integration tests.
- Separate demo infrastructure from production infrastructure.

## 6) Operational controls

- Use one running server process per environment.
- Monitor `/api/health` and dashboard data-quality indicators.
- Keep versioned backups of `data/config.json` (without secrets).

## 7) Responsible disclosure

If you discover a security issue, do not publish exploit details publicly.
Share a private report with reproduction steps and impact summary.
