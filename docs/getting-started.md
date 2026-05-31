# Getting started

This guide walks through the first end-to-end run: install dependencies,
configure Azure credentials, generate a plan, then provision live.

## Prerequisites

- Node.js `>=22.0.0` (the repo declares this in root `package.json`).
- `pnpm@11.1.3` (declared via `packageManager`).
- `tmux` available on `PATH` — the orchestrator spawns workers in tmux windows.
- `pac` (Power Platform CLI) for Copilot Studio recipes; `atk` (Microsoft 365
  Agents Toolkit CLI) for Teams recipes.
- `gh` (GitHub CLI) if you want the GH Copilot judge.

## 1. Clone and install

The repo lives at:

```
/mnt/c/Users/lproux/OneDrive - Microsoft/bkp/Desktop/App Factory
```

This is a Windows-synced OneDrive folder. OneDrive will try to sync every
file under `node_modules/` which is slow and noisy. Exclude it once after
install:

- Right-click `node_modules/` in Explorer → uncheck **Always keep on this
  device**, or
- Open OneDrive Settings → **Sync and backup** → **Manage backup** /
  **Choose folders** and exclude `node_modules`.

Then install:

```sh
pnpm install
pnpm build
```

`pnpm build` runs `turbo run build` across the workspace (see root
`package.json`). Each package emits `dist/` via `tsup`.

## 2. Configure Azure credentials

App Factory uses a hybrid auth broker (`packages/auth-broker`) with three
modes: `interactive`, `sp`, and `chained` (default). See
[auth-and-secrets.md](./auth-and-secrets.md) for the full credential chain.

For a first run with a service principal, set:

```sh
export AZURE_TENANT_ID=<tenant-guid>
export AZURE_CLIENT_ID=<sp-app-id>
export AZURE_CLIENT_SECRET=<sp-secret>
```

In `chained` mode the broker prefers `ClientSecretCredential` when both
`AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` are present, and falls back to
`InteractiveBrowserCredential` otherwise.

For interactive-only use, omit those env vars; a browser window will open
when an Azure call needs a token.

## 3. List the built-in recipes

```sh
pnpm --filter @app-factory/cli start -- list-recipes
```

This calls `app-factory list-recipes` (see `packages/cli/src/cli.ts`) and
prints each recipe id, target engine, and title. There are two built-ins
today; see [recipes.md](./recipes.md) for the full table.

## 4. Plan mode

Plan mode writes a Markdown plan to disk and exits without any side effects.
Always do this first.

```sh
pnpm --filter @app-factory/cli start -- build \
  --recipe copilot-studio-support-bot \
  --plan \
  --answer name="Support Bot" \
  --answer purpose="Tier-1 internal support" \
  --answer audience="employees"
```

What you get:

- A run id (10-char nanoid).
- A working directory at `.app-factory/<runId>/` containing `plan.md`.
- A rendered WBS step list (Copilot Studio: A2..A12; Teams: B2..B14).
- The same plan text echoed to stdout under `--- paste bundle ---`.

The recipe id `copilot-studio-support-bot` is defined in
`packages/elicitation/src/recipes.ts`. Required answers without defaults are
`name`, `purpose`, `audience` (plus `environment` and `channels`, which both
have defaults).

## 5. Live run

Drop the `--plan` flag to provision for real. For unattended (CI) runs add
`--non-interactive`; this fails fast on any required answer that is missing
and has no default.

```sh
pnpm --filter @app-factory/cli start -- build \
  --recipe copilot-studio-support-bot \
  --answer name="Support Bot" \
  --answer purpose="Tier-1 internal support" \
  --answer audience="employees" \
  --answer environment=new \
  --non-interactive
```

The CLI prints a JSON summary (`runId`, `ok`, `warnings`, `errors`, `log`)
and a paste bundle with all secrets and identifiers produced by the run.
Exit code is `0` on success, `1` on any captured error.

## 6. Loading a recipe from YAML

The `recipes/` directory contains thin YAML recipe stubs. You can pass one
directly:

```sh
pnpm --filter @app-factory/cli start -- build \
  --recipe-file recipes/teams-bot-basic.yaml \
  --recipe teams-bot-basic \
  --plan
```

`--recipe-file` takes priority over the built-in registry; `--recipe` is
still required because the CLI declares it as a required option.

## Next

- Confirm the credential chain you want: [auth-and-secrets.md](./auth-and-secrets.md).
- Understand the runtime: [architecture.md](./architecture.md).
- When a run fails: [troubleshooting.md](./troubleshooting.md).
