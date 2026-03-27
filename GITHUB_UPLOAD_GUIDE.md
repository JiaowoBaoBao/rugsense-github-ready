# GitHub Upload Guide (Privacy-Safe)

This package was prepared for open-source upload with privacy in mind:

- No `.git` history copied
- No `node_modules/`
- No runtime `data/*.json` state
- No hardcoded private keys
- Generic keychain identifiers in config defaults
- English-only comments/content in tracked source files

## 1) Final privacy checklist

Before pushing, verify:

1. `data/` only contains `.gitkeep`
2. No personal addresses, mnemonics, API keys, or tokens in tracked files
3. No local machine paths, usernames, or private URLs in docs/config
4. `.gitignore` excludes runtime state and lock files

Quick checks:

```bash
grep -RIn "PRIVATE_KEY\|MNEMONIC\|API_KEY\|API_SECRET\|authToken\|openclaw-bitget\|openclaw.bitget" .
find data -type f
```

## 2) Initialize a new GitHub repository

```bash
cd rugsense-github-ready
git init
git add .
git commit -m "Initial public release"
```

Create a new empty repo on GitHub, then:

```bash
git remote add origin <YOUR_GITHUB_REPO_URL>
git branch -M main
git push -u origin main
```

## 3) Recommended public repo settings

- Enable branch protection for `main`
- Enable Dependabot alerts
- Enable secret scanning and push protection
- Add a LICENSE file (MIT/Apache-2.0)
- Add SECURITY.md and CONTRIBUTING.md if needed

## 4) Runtime setup after cloning

```bash
npm install
npm run dev
```

Then configure `data/config.json` locally (do not commit secrets).
