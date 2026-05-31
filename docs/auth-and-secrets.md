# Auth and secrets

App Factory has one auth broker and one secret store. They work together
so the same recipe can run interactively (laptop) or unattended (CI),
without code changes.

- Auth broker: `packages/auth-broker/src/index.ts`
- Secret store: `packages/secret-store/src/index.ts`
- Factory context schema: `packages/shared/src/types.ts`

## Auth modes

`FactoryContext.auth.mode` (in `packages/shared/src/types.ts`) takes one of
three values; default is `chained`.

### `interactive`

`getCredential({ mode: 'interactive' })` returns
`InteractiveBrowserCredential` (or `DeviceCodeCredential` if
`preferDeviceCode: true`). Device-code uses Azure CLI's well-known client
id `04b07795-8ddb-461a-bbee-02f9e1bf7b46` and logs the verification URI
plus the user code through the broker's logger so they show up in the
tmux capture buffer.

Use this on a developer workstation when you want the browser prompt.

### `sp` (service principal)

`getCredential({ mode: 'sp' })` returns `ClientSecretCredential(tenantId,
clientId, clientSecret)`. The broker falls back to env vars when call
arguments are missing:

- `AZURE_TENANT_ID` (or the literal `'organizations'`)
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`

If `clientId` or `clientSecret` is still missing, it throws
`AuthError('SP mode requires clientId + clientSecret …')`.

### `chained` (default)

`getCredential({ mode: 'chained' })` builds a `ChainedTokenCredential` in
this order:

1. `ClientSecretCredential(tenantId, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)`
   — pushed only when both env vars are set.
2. `InteractiveBrowserCredential({ tenantId })` — or
   `DeviceCodeCredential` when `preferDeviceCode` is true.

The first credential that returns a token wins. This is what lets one
recipe run unattended in CI (env vars set, SP wins) and interactively
locally (env vars not set, browser wins) with no other change.

## Unattended runs

For unattended execution, set the three SP env vars and either choose
`auth.mode: 'sp'` or rely on the default `chained` behaviour:

```sh
export AZURE_TENANT_ID=<tenant-guid>
export AZURE_CLIENT_ID=<sp-app-id>
export AZURE_CLIENT_SECRET=<sp-secret>

pnpm --filter @app-factory/cli start -- build \
  --recipe teams-bot-basic \
  --answer name="HR Bot" \
  --answer purpose="Onboarding" \
  --answer subscription=default \
  --answer resourceGroup=rg-hr-bot \
  --answer region=eastus \
  --answer capabilities=bot \
  --non-interactive
```

`--non-interactive` makes the elicitation engine raise rather than block on
any missing required answer (see `defaultAsk` in `packages/cli/src/run.ts`).

The Teams WBS step `B4-sp` provisions its own per-run service principal
(`af-sp-<runId>`) via `createServicePrincipal` and grants it Contributor
on the resource group plus Application Administrator at the tenant. The
bootstrap SP supplied through env vars is only for the initial Azure ARM
calls; the per-run SP is what downstream automations consume.

## Admin consent URL

`adminConsentUrl({ tenantId, clientId, redirectUri?, scope?, state? })`
constructs the URL
`https://login.microsoftonline.com/<tenantId>/adminconsent?...` with the
standard `nativeclient` redirect and the Microsoft Graph `.default` scope.
The Teams app overlay surfaces this URL when SP-mode runs hit a
delegated-only API path.

## Secret store

`SecretStore.set(scope, name, value)` and `.get(scope, name)`:

1. Try the OS keyring via `@napi-rs/keyring` (libsecret on Linux, Keychain
   on macOS, Credential Manager on Windows). The service is
   `app-factory:<scope>`; the account is `<name>`. If the backend is
   unavailable (e.g. Linux without `libsecret`), `set` throws
   `AppFactoryError('SECRET_STORE_UNAVAILABLE')` unless the operator opts
   into the ephemeral in-memory fallback by exporting
   `APP_FACTORY_ALLOW_MEMORY_SECRETS=1`. See `docs/secret-store.md` for
   the backend matrix and the rationale behind the explicit opt-in.
2. Optionally mirror to an Azure Key Vault via a `KeyVaultAdapter`.

`azureKeyVaultAdapter(client)` wraps a `SecretClient` from
`@azure/keyvault-secrets`. KV secret names are sanitised by replacing any
character outside `[A-Za-z0-9-]` with `-`, so a `scope='copilot-studio'`,
`name='invokeUrl'` pair becomes `copilot-studio-invokeUrl`.

`FactoryContext.emit` carries flags that control which sinks are used:

```ts
emit: {
  keyring: true,       // write to OS keyring (default true)
  keyVault?: string,   // KV vault URL
  pasteBundlePath?: string,
}
```

(Note: as of Phase 2 the WBS executors always instantiate a `SecretStore`
without a vault adapter; KV mirroring is wired in `secret-store` but not
yet plumbed through `runCopilotStudio`/`runTeamsApp`. Tracked as a
follow-up.)

## What gets stored

Copilot Studio WBS A12 (`packages/copilot-studio/src/index.ts`) stores up
to five entries under scope `copilot-studio`:

- `pacAuthProfile`, `envId`, `envUrl`, `agentId`, `invokeUrl`.

Teams WBS B14 (`packages/teams-app/src/index.ts`) stores under scope
`teams-app`:

- `sp-client-secret` — per-run service principal secret.
- `entra-client-secret` — Entra app client secret.
- `identifiers` — multi-line `KEY=VALUE` blob with public identifiers
  (`AAD_APP_CLIENT_ID`, `AAD_APP_TENANT_ID`, `BOT_ID`, `SP_APP_ID`,
  `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `AZURE_REGION`,
  `TEAMS_ENV`). Treat this one as the env-var seed for downstream
  pipelines.

## Env-var population for unattended runs

The `azure-ops/env-stamp` helper writes those identifiers (no secrets)
into `<project>/env/.env.<env>` during step `B6-registrations`:

- `TEAMS_APP_ID`
- `AAD_APP_CLIENT_ID`
- `AAD_APP_OBJECT_ID`
- `AAD_APP_TENANT_ID`
- `BOT_ID`

Combined with the `identifiers` paste-bundle entry, a downstream job can
re-hydrate the run via:

```sh
eval "$(echo "$IDENTIFIERS_BLOCK" | sed 's/^/export /')"
```

## Paste bundle

Each `RunResult.pasteBundle` is a Markdown document containing:

- All secrets emitted by the run (`scope`, `name`, `value`, optional
  `description`).
- Artifacts (`kind`, `id`, `displayName`, metadata).
- Warnings collected by WBS steps.
- For Teams, an optional `costSuggestions` section from
  `optimizeCost` (`packages/azure-ops/src/cost.ts`).

When you need a one-shot copy/paste handoff to another agent or human,
pipe `result.pasteBundle` straight into your transport channel.
