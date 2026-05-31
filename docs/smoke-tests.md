# Smoke tests (live tenant)

`@app-factory/integration-tests` covers the work-breakdown structure (WBS)
with **mocks** — it runs as part of `pnpm test` and never makes network
calls. The complementary `@app-factory/smoke-tests` package is a small set
of **scripts** that exercise the same `runCopilotStudio()` / `runTeamsApp()`
entry points against a **real** Azure subscription, Power Platform
environment, and Teams tenant. It is **manual** by design: nothing in CI
runs it automatically, and every script refuses to start without explicit
opt-in via env vars.

Use the smoke suite before a release, after a non-trivial WBS change, or
when triaging a tenant-specific bug.

## Prerequisites

You will need:

- A **service principal** with `Contributor` (or tighter) on
  `APP_FACTORY_TEST_RG` and `Application Administrator` (or equivalent)
  on the Entra tenant for app-registration steps.
- A **Power Platform environment** the SP has admin access to. Either pre-
  create it or pass the literal string `new` to `APP_FACTORY_TEST_PP_ENV`
  to have the orchestrator create + select a Sandbox env.
- A **Teams tenant** with permission to side-load custom apps for the
  Teams smoke (the `atk` toolchain registers a bot).
- A **logo file** (PNG ≥ 192×192 or SVG) reachable from an absolute path.
- The `az`, `pac`, and `atk` CLIs on `PATH` on whatever host runs the
  scripts.
- (Optional) An Azure Key Vault URL — when supplied the emitted secrets
  bundle is written to the vault instead of (or in addition to) the
  paste-blob report.

## Env-var schema

Every script in `packages/smoke-tests/scripts/` reads the same schema. If
any required variable is missing the script writes a clear error to
stderr and exits with status `2`.

| Variable                       | Required | Description                                                       |
| ------------------------------ | -------- | ----------------------------------------------------------------- |
| `AZURE_TENANT_ID`              | yes      | Entra tenant GUID for the test SP.                                |
| `AZURE_SUBSCRIPTION_ID`        | yes      | Subscription that owns `APP_FACTORY_TEST_RG`.                     |
| `AZURE_CLIENT_ID`              | yes      | Service principal application id.                                 |
| `AZURE_CLIENT_SECRET`          | yes      | Service principal client secret.                                  |
| `APP_FACTORY_TEST_RG`          | yes      | Pre-created resource group the SP has `Contributor` on.           |
| `APP_FACTORY_TEST_REGION`      | yes      | Azure region for net-new resources (e.g. `eastus`).               |
| `APP_FACTORY_TEST_PP_ENV`      | yes      | Power Platform environment id, display name, or `new` to create. |
| `APP_FACTORY_TEST_LOGO`        | yes      | Absolute path to a PNG/SVG logo for the brand step.               |
| `APP_FACTORY_KEY_VAULT_URL`    | no       | When set, emitted secrets are written to this Key Vault.          |

All scripts also honour the standard `APP_FACTORY_LOG_LEVEL`
(`debug`/`info`/`warn`) used everywhere else in the repo.

## Run-id and cleanup discoverability

Every script generates a deterministic prefix —
`smoke-<UTC-YYYYMMDD>-<base36 random4>` — and threads it through
`FactoryContext.runId`. Provisioned artefacts (resource group children,
Entra app `displayName`, Copilot Studio solution `uniquename`) all carry
that prefix so `smoke:cleanup` can match and remove them later. **Do not**
edit the prefix manually; the cleanup script keys off the literal
`smoke-` string.

## Invocation order

Run the scripts in this order; each step is cheaper than the next and
fails fast on misconfiguration:

```sh
# 1) Validate env + plan rendering (no provisioning calls, ~5s)
pnpm --filter @app-factory/smoke-tests smoke:dry

# 2) Live Copilot Studio run end-to-end
pnpm --filter @app-factory/smoke-tests smoke:cs

# 3) Live Teams app run end-to-end
pnpm --filter @app-factory/smoke-tests smoke:teams

# 4) Best-effort tear-down of resources matching the smoke-* prefix
pnpm --filter @app-factory/smoke-tests smoke:cleanup
```

From the repo root, `pnpm smoke` is an alias for step 1 (the cheap sanity
check).

## What each script does

### `smoke:dry` (`scripts/dry-run.ts`)

Calls both `runCopilotStudio()` and `runTeamsApp()` with `planOnly: true`.
This:

- exercises the env-var loader (any missing var aborts before any network
  call);
- builds a real `FactoryContext` with the SP, subscription, RG, region,
  and PP env from the env;
- runs the orchestrator plan path — schemas validate, WBS steps register,
  and the plan markdown is rendered to a workdir under
  `$RUNNER_TEMP/app-factory-smoke/<runId>/`;
- prints a one-line summary per run (`ok`, artefact count, warning count,
  error count).

No `pac`, `atk`, Graph, ARM, or Direct Line calls are made. Cost: zero.

### `smoke:cs` (`scripts/run-copilot-studio.ts`)

Full Copilot Studio WBS (A2 → A12) against the live tenant. Provisioned:
PP environment selection, Dataverse solution, Entra app placeholder,
agent definition, KB ingest (no-op when no sources configured), brand
upload (uses `APP_FACTORY_TEST_LOGO`), solution import + publish, judge
panel review, secrets emission.

### `smoke:teams` (`scripts/run-teams-app.ts`)

Full Teams app WBS against the live tenant: `atk new`, Azure ops (RG +
SP + Entra app), bot registration, packaging, and judge review.

### `smoke:cleanup` (`scripts/cleanup.ts`)

Logs into `az` with the SP, lists resources under `APP_FACTORY_TEST_RG`
whose name starts with `smoke-`, and deletes them. Lists Entra apps
whose display name starts with `App Factory Smoke ` and deletes them.
Never auto-runs; never fails the workflow even on partial errors.
Power Platform solutions still need manual `pac solution delete`.

## Interpreting results

A passing smoke run prints (per script):

```text
INFO smoke:cs: smoke cs complete  ok=true runId=smoke-20260530-abcd
  artifacts=N secrets=M warnings=0 errors=0
```

`ok: true` with `errors=0` is a clean pass. **Warnings are expected** for
deferred WBS steps (e.g. Entra app provisioning is owned by `teams-app`
in the CS path and emits a placeholder ref). Compare against the prior
run's warning list when triaging — a brand-new warning category is the
usual signal that something regressed.

A failure surfaces as:

- exit code `2` — env-var validation failed (operator error);
- exit code `1` — orchestrator returned `ok: false` or threw;
- non-zero with `errors=[]` — process-level fatal (network, auth, CLI
  missing); the log line above the exit shows the original error.

After a failure: re-run `smoke:cleanup` to remove any half-provisioned
resources, fix the root cause, and re-run from `smoke:dry`.

## GitHub Actions

The workflow `.github/workflows/smoke-tests.yml` is `workflow_dispatch`
only and is gated by the `smoke` environment so it requires manual
approval before any secrets are exposed. It reads the same env-var
schema from GitHub Secrets (`AZURE_*` and `APP_FACTORY_TEST_*`) and
executes the four scripts in order.
