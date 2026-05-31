# Recipes

Recipes are declarative inputs for the factory. Each recipe carries a
target engine (Copilot Studio or Teams), a list of typed questions, and an
optional `defaults` block. The CLI elicits answers, then dispatches to the
matching WBS executor.

Source of truth: `packages/elicitation/src/recipes.ts`. Schema:
`packages/elicitation/src/schema.ts` (`Recipe`, `Question`).

## Listing recipes

```sh
pnpm --filter @app-factory/cli start -- list-recipes
```

Implementation: `packages/cli/src/cli.ts`, `list-recipes` command, imports
`allRecipes` from `@app-factory/elicitation`.

## Question kinds

From `Question.kind`: `text`, `choice`, `multi-choice`, `path`, `url`,
`boolean`. The elicitation engine
(`packages/elicitation/src/engine.ts`) merges in this order:
`recipe.defaults`, `--answer key=value` CLI flags, per-question `default`,
custom `infer` callback, then `ask()` for required+missing answers.

---

## `copilot-studio-support-bot`

- **Title:** Copilot Studio — Support Bot
- **Target engine:** `copilot-studio` (runs WBS A via
  `runCopilotStudio` in `packages/copilot-studio/src/index.ts`)
- **Description:** A Dataverse-backed support agent with knowledge base,
  REST tools, and Teams channel publish.

### Inputs

| id           | prompt                                                                                            | kind          | required | default     |
|--------------|---------------------------------------------------------------------------------------------------|---------------|----------|-------------|
| `name`       | Agent display name                                                                                | text          | yes      | —           |
| `purpose`    | One-line purpose                                                                                  | text          | yes      | —           |
| `audience`   | Primary audience                                                                                  | text          | yes      | —           |
| `environment`| Power Platform environment (id or `"new"`)                                                        | text          | yes      | `new`       |
| `kbSources`  | Knowledge base sources (`kind=local|sharepoint|url|github|aws-s3|gcp-gcs:uri`, comma-separated)   | text          | no       | —           |
| `logoPath`   | Path to logo file (optional)                                                                      | path          | no       | —           |
| `channels`   | Publish channels (`teams`, `web`, `m365-copilot`)                                                 | multi-choice  | yes      | `['teams']` |

Note: the registered `kbSources` prompt lists `local|sharepoint|url|github|aws-s3|gcp-gcs`,
but the underlying `KbSourceKind` enum
(`packages/shared/src/types.ts`) also accepts `foundry` and `m365-admin`.
The CLI parser (`parseKbSources` in `packages/cli/src/run.ts`) passes
whatever kind you supply straight through.

### Example invocations

Plan only:

```sh
pnpm --filter @app-factory/cli start -- build \
  --recipe copilot-studio-support-bot \
  --plan \
  --answer name="Helpdesk Bot" \
  --answer purpose="Tier-1 IT support" \
  --answer audience="employees"
```

Live, single KB source, web + Teams channels:

```sh
pnpm --filter @app-factory/cli start -- build \
  --recipe copilot-studio-support-bot \
  --answer name="Helpdesk Bot" \
  --answer purpose="Tier-1 IT support" \
  --answer audience="employees" \
  --answer environment=new \
  --answer 'kbSources=sharepoint:https://contoso.sharepoint.com/sites/it-kb' \
  --answer channels=teams,web \
  --non-interactive
```

---

## `teams-bot-basic`

- **Title:** Teams — Basic Bot
- **Target engine:** `teams` (runs WBS B via `runTeamsApp` in
  `packages/teams-app/src/index.ts`)
- **Description:** A Teams bot app provisioned via Agents Toolkit CLI
  (`atk`), with Entra + bot registration.

### Inputs

| id              | prompt                                       | kind         | required | default              |
|-----------------|----------------------------------------------|--------------|----------|----------------------|
| `name`          | App name                                     | text         | yes      | —                    |
| `purpose`       | One-line purpose                             | text         | yes      | —                    |
| `subscription`  | Azure subscription id (or `"default"`)       | text         | yes      | `default`            |
| `resourceGroup` | Resource group name (existing or new)        | text         | yes      | — (recipe default: `rg-app-factory`) |
| `region`        | Azure region                                 | choice       | yes      | `eastus`             |
| `logoPath`      | Path to logo file (optional)                 | path         | no       | —                    |
| `capabilities`  | Capabilities (`bot`, `tab`, `me`)            | multi-choice | yes      | `['bot']`            |

Region choices: `eastus`, `westus2`, `westeurope`, `canadacentral`.
Capability choices: `bot` (Conversational bot), `tab` (Personal tab), `me`
(Message extension).

The YAML stub at `recipes/teams-bot-basic.yaml` supplies the
`resourceGroup` default `rg-app-factory`; the in-code question has no
default, but the WBS B step `B3-azure-rg` falls back to `rg-app-factory`
internally when none is set (see `DEFAULT_RG`).

### Example invocations

Plan only:

```sh
pnpm --filter @app-factory/cli start -- build \
  --recipe teams-bot-basic \
  --plan \
  --answer name="HR Bot" \
  --answer purpose="Onboarding helper" \
  --answer resourceGroup=rg-hr-bot
```

Live, using `default` subscription:

```sh
pnpm --filter @app-factory/cli start -- build \
  --recipe teams-bot-basic \
  --answer name="HR Bot" \
  --answer purpose="Onboarding helper" \
  --answer subscription=default \
  --answer resourceGroup=rg-hr-bot \
  --answer region=eastus \
  --answer capabilities=bot \
  --non-interactive
```

---

## Recipe YAML stubs

`recipes/copilot-studio-support-bot.yaml` and `recipes/teams-bot-basic.yaml`
are thin stubs (no `questions` array) that the CLI accepts via
`--recipe-file <path>`. Because the CLI requires `--recipe` even with
`--recipe-file`, pass both. The recipe is parsed with
`Recipe.parse` (`packages/elicitation/src/schema.ts`); a stub without
`questions` will fail validation, so prefer in-code recipes for full runs
and use the YAML stubs as templates.
