# Index Protocol Monorepo

This repository keeps the full stack in one place:

- `programs/`: Anchor/Solana on-chain program
- `app/`: Next.js frontend (deploy to Vercel)
- `bot/`: off-chain automation/keeper scripts
- `scripts/`, `config/`, `docs/`: shared operational code and docs

## Why One Repo

This codebase is currently tightly coupled by:

- shared program ID and IDL flow
- shared RPC/network assumptions
- coordinated release changes across app, bot, and program

A monorepo keeps versioning, review, and CI consistent while the project is still evolving quickly.

## Local Commands

Run from repo root:

```bash
# program checks
cargo check --workspace --locked

# anchor build artifact generation
anchor build
```

Run frontend checks:

```bash
cd app
npm ci
npm run lint
npm run build
```

Run bot checks:

```bash
cd bot
npm ci
npx tsc --noEmit -p tsconfig.json
```

## CI Layout

GitHub Actions are split by path so only relevant jobs run:

- `.github/workflows/frontend-ci.yml`
- `.github/workflows/bot-ci.yml`
- `.github/workflows/program-ci.yml`

## Publish To GitHub

If remote is not added yet:

```bash
git remote add origin <your-github-repo-url>
```

Then publish:

```bash
git add .
git commit -m "Initial monorepo import"
git branch -M main
git push -u origin main
```

## When To Split Later

Split into separate repositories only when one of these becomes true:

- different teams need different access controls
- release cadence diverges and causes CI/deploy friction
- one component must be open-source while others stay private
- strict compliance boundaries require separate secret scopes
