# Agent 365 path

The `teams-agent-365` recipe drives the Microsoft Agent 365 CLI
(`agent365`) instead of the Teams Toolkit CLI (`atk`). This document
explains what the path does, its prerequisites, the recipe inputs it
honors, and where the resulting blueprint lives on disk.

The wrapper lives in `packages/agent-365/` and is consumed by
`packages/teams-app/src/index.ts` (steps `B2-scaffold` and `B11-publish`).

## What it does

When `FactoryContext.recipe === 'teams-agent-365'`, WBS B routes through
the Agent 365 CLI for the engine-specific steps and leaves all
Azure/Entra/SP/bot registration steps untouched. Concretely:

| Step               | atk path                       | Agent 365 path                            |
|--------------------|--------------------------------|-------------------------------------------|
| `B2-scaffold`      | `atk new --template <tmpl>`    | `agent365 blueprint create --name --path` |
| `B3-azure-rg`      | (unchanged)                    | (unchanged)                               |
| `B4-sp`            | (unchanged)                    | (unchanged)                               |
| `B5-pim`           | (unchanged)                    | (unchanged)                               |
| `B6-registrations` | Entra app + bot + env stamp    | Entra app + bot + env stamp               |
| `B7-provision`     | `atk provision --env <env>`    | _skipped_ (rolled into B11)               |
| `B8-deploy`        | `atk deploy --env <env>`       | _skipped_ (rolled into B11)               |
| `B9-package`       | `atk package`                  | _skipped_ (rolled into B11)               |
| `B10-validate`     | `atk validate`                 | _skipped_ (validation lives in publish)   |
| `B11-publish`      | `atk update teams-app --env`   | `agent365 publish --env <env>`            |
| `B12`–`B14`        | (unchanged)                    | (unchanged)                               |

Note that B7/B8/B9/B10 stay in the WBS graph (still emit step events for
the orchestrator) — they just log a breadcrumb and return when the
scaffold engine is Agent 365. This keeps the existing WBS contract that
downstream tooling, dashboards, and the integration-tests suite depend
on intact.

## Wrapper surface

`@app-factory/agent-365` exposes the following typed functions:

- `detectAgent365CliVersion({ exec? })` — probes `agent365 --version`,
  caches the result, and throws a `PortalRequiredError` with the
  install hint `npm i -g @microsoft/agent-365-cli` when the binary is
  missing or fails to launch.
- `agent365BlueprintCreate({ name, projectPath, kbSourcesAgent365? })`
  — runs `agent365 blueprint create --name <name> --path <projectPath>
  [--kb-sources agent-365] --non-interactive` via the
  `@app-factory/orchestrator` tmux worker so long-running scaffolds
  stream output.
- `agent365McpAdd({ projectPath, servers })` — for each
  `{ name, url }` entry, runs `agent365 mcp add --name <name> --url <url>
  --non-interactive` in the project working tree. No-ops on an empty
  list.
- `agent365Publish({ projectPath, env })` — runs `agent365 publish
  --env <env> --non-interactive` through the tmux worker.
- `agent365Clean({ projectPath })` — runs `agent365 clean
  --non-interactive` (short, direct execa call — no tmux session).

All five functions throw `PortalRequiredError` if the CLI is missing,
`AppFactoryError('AGENT365_INPUT', ...)` for malformed inputs, and
`ProvisioningError` for non-zero exits or failure markers in the CLI
output. The wrapper never raises a raw `Error`.

## Prerequisites

1. **Agent 365 CLI installed.** From a shell with Node 20+ on the path:

   ```sh
   npm i -g @microsoft/agent-365-cli
   agent365 --version
   ```

   The wrapper checks `agent365 --version`; if it fails for any reason
   (exit code, missing binary, ENOENT), the orchestrator surfaces a
   `PortalRequiredError` pointing at the
   [Agent 365 CLI install docs](https://learn.microsoft.com/microsoft-365/agents-sdk/agent-365-cli).

2. **Tenant with Microsoft 365 Copilot.** The `teams-agent-365` recipe
   asks `m365CopilotEnabled` up-front. If your tenant is _not_ licensed
   for Microsoft 365 Copilot, the blueprint will still scaffold and
   register, but `agent365 publish` will fail at publish time when it
   attempts to register the agent with the Copilot manifest. Answer
   `false` to keep the run plan-only.

3. **Same Entra/SP/bot prerequisites as the atk path.** B3–B6 still
   run, so you still need a subscription, a resource group (or the
   factory's default `rg-app-factory`), and Application Administrator
   to create the bot registration.

## Recipe inputs (`teams-agent-365`)

Defined in `packages/elicitation/src/recipes.ts`:

| id                    | prompt                                                    | kind     | required | default   |
|-----------------------|-----------------------------------------------------------|----------|----------|-----------|
| `name`                | Agent display name                                        | text     | yes      | —         |
| `purpose`             | One-line purpose                                          | text     | yes      | —         |
| `subscription`        | Azure subscription id (or `"default"`)                    | text     | yes      | `default` |
| `resourceGroup`       | Resource group name (existing or new)                     | text     | yes      | —         |
| `region`              | Azure region                                              | choice   | yes      | `eastus`  |
| `m365CopilotEnabled`  | Is M365 Copilot licensed in the target tenant?            | boolean  | yes      | `true`    |
| `kbSourcesAgent365`   | Use the Agent 365 grounding pipeline for KB sources?      | boolean  | no       | `true`    |
| `logoPath`            | Path to logo file (optional)                              | path     | no       | —         |

Note: the elicited answers for `m365CopilotEnabled` and
`kbSourcesAgent365` are not yet plumbed through `FactoryContext`
(which has no `answers` field today). For the moment B2 defaults to
`kbSourcesAgent365 = true` regardless of the answer; once the
`FactoryContext` schema grows an `answers` map, B2 will switch to
honoring the elicited value.

## Where the blueprint lives

After `B2-scaffold` succeeds you'll find the generated blueprint at:

```
<workdir>/<brand.name>/
├── agent365.yml          # blueprint manifest
├── src/                  # agent code (TypeScript)
├── manifest/             # Copilot + Teams manifest fragments
└── kb/                   # KB grounding configs (when kbSourcesAgent365=true)
```

`<workdir>` comes from `FactoryContext.workdir`, and `<brand.name>`
falls back to `teams-bot` when no brand name is supplied (same default
as the other Teams recipes).

The matching `ArtifactRef` recorded on the run has
`kind: 'teams-app'`, `id: <projectPath>`, and
`metadata.scaffold = 'agent-365'`, so the paste bundle and
integration-tests both recognize the Agent 365 path without further
schema changes.

## Example invocation

Plan only:

```sh
pnpm --filter @app-factory/cli start -- build \
  --recipe teams-agent-365 \
  --plan \
  --answer name="Helpdesk Copilot" \
  --answer purpose="Tier-1 IT support inside Microsoft 365 Copilot" \
  --answer resourceGroup=rg-helpdesk-copilot
```

Live, single subscription:

```sh
pnpm --filter @app-factory/cli start -- build \
  --recipe teams-agent-365 \
  --answer name="Helpdesk Copilot" \
  --answer purpose="Tier-1 IT support inside Microsoft 365 Copilot" \
  --answer subscription=default \
  --answer resourceGroup=rg-helpdesk-copilot \
  --answer region=eastus \
  --answer m365CopilotEnabled=true \
  --answer kbSourcesAgent365=true \
  --non-interactive
```

## Known stubs / moving parts

The Agent 365 CLI surface is still moving as of `0.2.x`. The wrapper:

- Wraps `blueprint create`, `mcp add`, `publish`, and `clean` only.
  `agent365 mcp add` is implemented in the wrapper but not yet called
  by any WBS step — once `FactoryContext` carries an MCP server list
  it will land between B2 and B7.
- Skips B7/B8/B9/B10 for the agent-365 recipe because the CLI does not
  expose free-standing `provision`/`deploy`/`package`/`validate`
  subcommands today; `agent365 publish` rolls them all up.
- Does not yet propagate the elicited `kbSourcesAgent365` answer (see
  the note above).
