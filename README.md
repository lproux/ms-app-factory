# App Factory

A unified factory for provisioning **Copilot Studio agents** and
**Microsoft Teams apps** end-to-end. Runs as a CLI, or as a skill from
Claude Code and the GitHub Copilot CLI.

One recipe in, one provisioned app + secret bundle out. Hybrid auth
(interactive locally, service principal in CI), a tmux-backed worker
orchestrator, a three-judge review panel, and `withFallback` portal
automation so an API path can degrade to Playwright or computer-use
without changing the caller.

## Quick start

Repo lives in OneDrive at:
`/mnt/c/Users/lproux/OneDrive - Microsoft/bkp/Desktop/App Factory`.
Exclude `node_modules/` from OneDrive sync before you install
(Settings → Sync and backup → Manage backup).

```sh
pnpm install
pnpm build
pnpm --filter @app-factory/cli start -- list-recipes
pnpm --filter @app-factory/cli start -- build \
  --recipe copilot-studio-support-bot --plan \
  --answer name="Support Bot" \
  --answer purpose="Tier-1 support" \
  --answer audience="employees"
```

Drop `--plan` to provision live. Add `--non-interactive` for CI.
Full walkthrough: [`docs/getting-started.md`](docs/getting-started.md).

## Documentation

Read in order:

1. [`docs/getting-started.md`](docs/getting-started.md)
2. [`docs/architecture.md`](docs/architecture.md)
3. [`docs/recipes.md`](docs/recipes.md)
4. [`docs/auth-and-secrets.md`](docs/auth-and-secrets.md)
5. [`docs/judge-panel.md`](docs/judge-panel.md)
6. [`docs/troubleshooting.md`](docs/troubleshooting.md)

Index: [`docs/README.md`](docs/README.md).

## Layout

- `packages/shared` — types, logger, errors
- `packages/auth-broker` — MSAL chained credentials (interactive + SP)
- `packages/secret-store` — keytar + optional Azure Key Vault
- `packages/orchestrator` — tmux-based worker session pool + WBS runner
- `packages/elicitation` — interview engine + recipes
- `packages/copilot-studio` — WBS A executor
- `packages/teams-app` — WBS B executor
- `packages/azure-ops` — Azure / Entra / PIM / cost helpers
- `packages/judge-panel` — multi-model reviewer (Claude / GH Copilot / Copilot Studio)
- `packages/portal-automation` — Playwright + computer-use `withFallback`
- `packages/logo-pipeline` — brand asset rendering (sharp + optional image-gen)
- `packages/skill-adapters/claude` — Claude Code skill installer
- `packages/skill-adapters/copilot-cli` — `gh` extension
- `packages/cli` — `app-factory` bin

## Status

Phase 2 shipped. Plan: `~/.claude/plans/i-want-to-delightful-orbit.md`.
Requirements: Node `>=22`, `pnpm@11.1.3`, `tmux`, plus `pac` / `atk`
as needed per recipe.
