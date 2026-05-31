# App Factory — Documentation

A unified factory for provisioning Copilot Studio agents and Microsoft Teams
apps end-to-end. These docs are written to be read in order.

## Read in order

1. [Getting started](./getting-started.md) — install, configure Azure, run the
   first recipe in plan mode, then live.
2. [Architecture](./architecture.md) — master orchestrator, tmux workers, judge
   panel, secret store, portal-automation fallback.
3. [Recipes](./recipes.md) — every built-in recipe with inputs, target engine,
   and example invocations.
4. [Auth and secrets](./auth-and-secrets.md) — hybrid interactive + service
   principal auth, `ChainedTokenCredential` resolution, secret storage
   (keytar + Key Vault), unattended runs.
5. [Judge panel](./judge-panel.md) — three judges (Claude / GH Copilot /
   Copilot Studio), voting, tie-breakers, `autoImprove`.
6. [Troubleshooting](./troubleshooting.md) — failure modes from
   `packages/shared/src/errors.ts` and downstream packages with recovery steps.

## Operator / contributor extras

- [CI](./ci.md) — GitHub Actions workflows and lint / typecheck / test gates.
- [Multi-terminal demo](./multi-terminal-demo.md) — driving the tmux
  orchestrator interactively.

## Reference

- Root README: [`../README.md`](../README.md)
- Repo path on disk:
  `/mnt/c/Users/lproux/OneDrive - Microsoft/bkp/Desktop/App Factory`
- Plan: `~/.claude/plans/i-want-to-delightful-orbit.md`
