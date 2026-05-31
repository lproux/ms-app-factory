# `app-factory doctor` — preflight prerequisite checks

`doctor` probes the local environment for every prerequisite the factory expects
**before** an interactive run begins. It exists so first-run users don't get
90 seconds into a live provisioning job only to discover `pac` isn't on `PATH`.

## Usage

```sh
# Full-matrix probe — runs every check, regardless of recipe.
app-factory doctor

# Scope to a single recipe — only runs the checks that recipe needs.
app-factory doctor --recipe copilot-studio-support-bot
app-factory doctor --recipe teams-bot-basic
app-factory doctor --recipe-file ./my-custom-recipe.yaml

# JSON output for scripts / CI.
app-factory doctor --json
```

Exit code is `0` if every **required** check passes, `1` otherwise. Optional
checks (currently the service-principal env vars) surface as `WARN` and never
flip the exit code.

`doctor` runs **automatically** before `app-factory build` (scoped to the
recipe being built). Pass `--skip-doctor` to bypass — the build will then throw
`AppFactoryError('DOCTOR_FAILED', ...)` if it would have failed.

```sh
app-factory build -r teams-bot-basic               # doctor runs first
app-factory build -r teams-bot-basic --skip-doctor # bypass at your own risk
```

## Probe matrix

| Tool / env var          | Required | Scoped to                              | Fix hint                                                          |
| ----------------------- | -------- | -------------------------------------- | ----------------------------------------------------------------- |
| `node >= 22`            | yes      | always                                 | Install Node 22 LTS (fnm/nvm/nodejs.org)                          |
| `pnpm`                  | yes      | always                                 | `npm install -g pnpm@11.1.3`                                      |
| `tmux`                  | yes      | always                                 | `apt-get install -y tmux` / `brew install tmux`                   |
| `gh` (GitHub CLI)       | yes      | always                                 | https://cli.github.com/                                           |
| `az` (Azure CLI)        | yes      | always                                 | https://learn.microsoft.com/cli/azure/install-azure-cli           |
| `pac` (Power Platform)  | yes      | `target: copilot-studio` recipes       | `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`       |
| `atk` (M365 Agents)     | yes      | `target: teams` recipes                | `npm install -g @microsoft/m365agentstoolkit-cli`                 |
| `agent365`              | yes      | `teams-agent-365` only                 | `npm install -g @microsoft/agents-cli`                            |
| `ANTHROPIC_API_KEY`     | yes      | always                                 | `export ANTHROPIC_API_KEY=sk-ant-...` (judge panel)               |
| `AZURE_TENANT_ID`       | yes      | always                                 | `export AZURE_TENANT_ID=<guid>`                                   |
| `AZURE_SUBSCRIPTION_ID` | yes      | always                                 | `export AZURE_SUBSCRIPTION_ID=<guid>`                             |
| `AZURE_CLIENT_ID`       | no       | always (INFO only)                     | Optional — pair with secret for ServicePrincipal auth             |
| `AZURE_CLIENT_SECRET`   | no       | always (INFO only)                     | Optional — pair with id for ServicePrincipal auth                 |

### Recipe → required-tools mapping

`selectToolsForRecipe()` in `packages/cli/src/doctor.ts` is the single source
of truth. Today:

- **All recipes** require the base set (`node`, `pnpm`, `tmux`, `gh`, `az` and
  the required env vars).
- **`target: 'copilot-studio'`** recipes additionally require `pac`.
- **`target: 'teams'`** recipes additionally require `atk`.
- The **`teams-agent-365`** recipe additionally requires the `agent365` CLI.

A `teams-bot-basic` doctor run therefore does **not** probe `pac`, and a
`copilot-studio-support-bot` run does **not** probe `atk` or `agent365`.

## Sample output

```
App Factory doctor — recipe: teams-bot-basic

  OK    node >= 22                v22.14.0
  OK    pnpm                       pnpm 11.1.3
  FAIL  tmux                       not found on PATH (spawn ENOENT)
         fix: apt-get install -y tmux  (or `brew install tmux` on macOS).
  OK    atk (M365 Agents Toolkit CLI)   2.0.1
  OK    gh (GitHub CLI)            gh version 2.62.0 (2025-01-...)
  OK    az (Azure CLI)             azure-cli 2.66.0
  OK    env ANTHROPIC_API_KEY      set (108 chars)
  FAIL  env AZURE_TENANT_ID        unset
         fix: export AZURE_TENANT_ID=<tenant-guid>
  OK    env AZURE_SUBSCRIPTION_ID  set (36 chars)
  WARN  env AZURE_CLIENT_ID        unset (optional)
         fix: optional — only needed for ServicePrincipal auth; DeviceCode works without.
  WARN  env AZURE_CLIENT_SECRET    unset (optional)
         fix: optional — pairs with AZURE_CLIENT_ID for ServicePrincipal auth.

  2 required check(s) failed, 2 warning(s)
```

## Extending the probe matrix

Add a new prerequisite in three steps:

1. Add a tag to the `ToolTag` union in `packages/cli/src/doctor.ts`.
2. Add a probe definition in `buildProbes()` — set `name`, `required`,
   `fixHint`, and a `run()` returning `{ status, detail? }`. Reuse
   `probeBinary(bin, args)` for executables or `probeEnv(name, required)` for
   environment variables.
3. Decide which recipes need it and wire it into `selectToolsForRecipe()`. If
   it's universal, add it to `BASE_TOOLS`. If it's recipe-specific, branch on
   `recipe.id` or `recipe.target`.

Then add a vitest case in `packages/cli/test/doctor.test.ts` that asserts the
new probe runs only for the intended recipes.
