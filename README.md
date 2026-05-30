# App Factory

A unified factory for provisioning **Copilot Studio agents** and **Microsoft Teams apps** end-to-end. Runnable as a skill from Claude Code or GitHub Copilot CLI.

## Status

Phase 1 — foundations. See [plan](/home/lproux/.claude/plans/i-want-to-delightful-orbit.md).

## Layout

- `packages/shared` — types, logger, errors
- `packages/auth-broker` — MSAL chained credentials (interactive + SP)
- `packages/secret-store` — keytar + optional Azure Key Vault
- `packages/orchestrator` — tmux-based worker session pool
- `packages/elicitation` — interview engine + recipes
- `packages/copilot-studio` — WBS A executor
- `packages/teams-app` — WBS B executor
- `packages/judge-panel` — multi-model reviewer
- `packages/portal-automation` — Playwright + computer-use fallback
- `packages/skill-adapters/claude` — Claude Code skill installer
- `packages/skill-adapters/copilot-cli` — `gh` extension
- `packages/cli` — `app-factory` bin

## Quick start

```sh
pnpm install
pnpm build
pnpm --filter @app-factory/cli start -- --recipe copilot-studio-support-bot --plan
```
