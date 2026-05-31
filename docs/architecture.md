# Architecture

The App Factory is a pnpm + Turborepo monorepo. Each package owns one
runtime concern; the CLI wires them together per recipe target.

## Component map

```
                       +----------------------------+
                       |  @app-factory/cli          |
                       |  bin: app-factory          |
                       |  (packages/cli)            |
                       +-------------+--------------+
                                     |
              dispatch by recipe.target ('copilot-studio' | 'teams')
                                     |
        +----------------------------+----------------------------+
        v                                                         v
+------------------------+                              +------------------------+
| @app-factory/          |                              | @app-factory/          |
| copilot-studio         |                              | teams-app              |
| (WBS A2..A12)          |                              | (WBS B2..B14)          |
| runCopilotStudio()     |                              | runTeamsApp()          |
+-----------+------------+                              +-----------+------------+
            |                                                       |
            |             both call execute(steps, ctx)             |
            +---------------------+---------------------------------+
                                  v
                  +------------------------------------+
                  | @app-factory/orchestrator          |
                  |  - execute()  (WBS DAG runner)     |
                  |  - spawn()    (tmux worker pool)   |
                  |  - WorkerHandle.{send,capture,     |
                  |    waitFor,kill}                   |
                  +------+----------------------+------+
                         |                      |
                         v                      v
              +----------------------+    +-------------------------+
              | tmux session         |    | @app-factory/judge-panel|
              | "app-factory"        |    |  JudgePanel.review()    |
              | one window per       |    |  autoImprove()          |
              | worker               |    |                         |
              +----------------------+    |  judges:                |
                                          |   - claude   (SDK)      |
                                          |   - copilot  (gh CLI    |
                                          |               via tmux) |
                                          |   - cs       (Direct    |
                                          |               Line)     |
                                          +-------------------------+

                                  ^
                                  |  vetoOn: ['security'] by default
                                  |  policy.tieBreaker: majority |
                                  |                    architect |
                                  |                    unanimous
                                  |
+-----------------------------+   |   +-------------------------------+
| @app-factory/auth-broker    |   |   | @app-factory/portal-automation|
|  getCredential({mode})      |   |   |  withFallback({primary,       |
|   - interactive             |   |   |                playwright,    |
|   - sp (ClientSecret)       |   |   |                computerUse})  |
|   - chained                 |   |   |  --                            |
|     ChainedTokenCredential( |   |   |  Catches PortalRequiredError, |
|       ClientSecret? ,       |   |   |  then tries Playwright pages, |
|       Interactive | Device  |   |   |  then computer-use, then      |
|     )                       |   |   |  PORTAL_FALLBACK_EXHAUSTED.   |
+-----------------------------+   |   +-------------------------------+
                                  |
                                  v
                  +-------------------------------+
                  | @app-factory/secret-store     |
                  |  SecretStore.set/get          |
                  |   - @napi-rs/keyring          |
                  |     (libsecret/Keychain/CredM)|
                  |   - in-memory fallback        |
                  |     (gated by env opt-in)     |
                  |   - optional KeyVaultAdapter  |
                  |     wrapping @azure/keyvault- |
                  |     secrets SecretClient      |
                  |                                |
                  |  buildPasteBundle()           |
                  +-------------------------------+
```

## Master orchestrator

`packages/orchestrator/src/wbs.ts` exports `execute(steps, ctx, opts)`. It
runs a list of `Step<C>` objects with `id`, `dependsOn`, and optional
`parallelGroup`. Each tick collects ready steps (all `dependsOn` complete),
buckets them by `parallelGroup`, and runs one bucket via `Promise.all`. If
no step is ready and not all are done, it raises
`AppFactoryError('WBS_DEADLOCK')`.

`opts.planOnly` short-circuits the loop and just logs every step. The CLI
wires plan mode through `FactoryContext.planOnly`.

## Tmux workers

`packages/orchestrator/src/tmux.ts` is the worker pool. `ensureSession()`
opens (or reuses) a tmux session named `app-factory`. `spawn(command, opts)`
creates a new window in that session and returns a `WorkerHandle`:

- `send(keys, enter?)` — `tmux send-keys`.
- `capture(lines?)` — `tmux capture-pane -p -S -<lines>` (default 500).
- `waitFor(pattern, { timeoutMs, pollMs })` — polls `capture(2000)` until
  the regex matches; defaults to 120s timeout, 1s poll. Throws
  `AppFactoryError('TMUX_WAIT_TIMEOUT')` on timeout.
- `kill()` — `tmux kill-window`.

The GH Copilot judge (`packages/judge-panel/src/judges/copilot.ts`) is the
main consumer: it spawns `gh copilot suggest -t shell <<EOF ... EOF` in a
tmux window and waits for output before parsing the verdict.

## Judge panel

`packages/judge-panel/src/panel.ts` defines `JudgePanel`. Construction
requires at least one judge (else `AppFactoryError('JUDGE_PANEL_EMPTY')`).
`review(artifact)`:

1. `Promise.allSettled` over all judges in parallel.
2. For each rejected promise: if the error is an `AppFactoryError` with
   `recoverable: true`, the judge is recorded as `<id>:unavailable` with a
   synthetic verdict (approved=false, score=0). Otherwise, the original
   error propagates.
3. `tally()` (`voting.ts`) computes vetoed / approvals / rejections /
   repairNotes under the configured `VotingPolicy`.

`reviewOrThrow()` raises `JudgeVetoError` when `result.vetoed` is true.

Default policy: `vetoOn: ['security']`, `tieBreaker: 'majority'`, quorum
defaulting to `ceil(judges/2)`. WBS steps `A11` (Copilot Studio) and `B13`
(Teams) instantiate the panel with four personas (architect, security,
cost, ux) wired to all three judge backends.

`autoImprove()` (`auto-improve.ts`) re-runs the panel after a regenerate
callback for up to `maxRounds` iterations, raising `JudgeVetoError` if it
never converges.

See [judge-panel.md](./judge-panel.md).

## Secret store

`packages/secret-store/src/index.ts` exports `SecretStore`. `set(scope,
name, value)` writes via `@napi-rs/keyring` first
(`service = "app-factory:<scope>"`, `account = <name>`), and optionally
mirrors to a `KeyVaultAdapter`. If the OS keyring is unreachable, `set`
throws `AppFactoryError('SECRET_STORE_UNAVAILABLE')` unless the operator
opts into an ephemeral in-memory fallback via
`APP_FACTORY_ALLOW_MEMORY_SECRETS=1`. `azureKeyVaultAdapter`
wraps a `SecretClient` from `@azure/keyvault-secrets`; KV names are
sanitised to `[A-Za-z0-9-]`.

`buildPasteBundle` (`./paste.ts`) assembles a Markdown blob with secrets,
artifacts, warnings, and optional cost suggestions; both `runCopilotStudio`
and `runTeamsApp` return one as `RunResult.pasteBundle`.

## Portal automation `withFallback`

`packages/portal-automation/src/fallback.ts`:

```
withFallback({ primary, playwright?, computerUse?, label? })
  -> try primary()
  -> on PortalRequiredError: try playwright(), then computerUse()
  -> if both miss/fail: throw AppFactoryError('PORTAL_FALLBACK_EXHAUSTED')
                         with the original PortalRequiredError as cause
  -> any other error from primary(): rethrow verbatim
```

Use this anywhere an API path may need a portal click-through. The
Copilot Studio `pac` wrapper (`packages/copilot-studio/src/pac.ts`) raises
`PortalRequiredError` with the relevant make.powerautomate.com URL when
`pac` is not authenticated or rejects ServicePrincipal auth in a way that
requires browser consent. The OpenAPI v3 downgrade path
(`packages/copilot-studio/src/index.ts` step A7) similarly raises
`PortalRequiredError('https://make.powerautomate.com/connectors')`.

## Auth broker

`packages/auth-broker/src/index.ts` exports `getCredential(opts)`:

- `interactive`: `InteractiveBrowserCredential`, or `DeviceCodeCredential`
  if `preferDeviceCode` is set. Device-code uses Azure CLI's well-known
  client id `04b07795-8ddb-461a-bbee-02f9e1bf7b46`.
- `sp`: `ClientSecretCredential(tenantId, clientId, clientSecret)`. If
  either id is missing it falls back to `AZURE_CLIENT_ID` /
  `AZURE_CLIENT_SECRET`. Throws `AuthError` when neither is available.
- `chained`: builds a `ChainedTokenCredential` with `ClientSecretCredential`
  first (only if both env vars are present), then the interactive (or
  device-code) credential. This is the default `FactoryContext.auth.mode`.

It also exposes `adminConsentUrl()` for non-interactive consent flows.

See [auth-and-secrets.md](./auth-and-secrets.md).

## Where the WBS lives

- Copilot Studio steps: `packages/copilot-studio/src/index.ts`, `steps`
  array (exported as `copilotStudioSteps`). Ids `A2-resolve-environment`
  through `A12-emit-secrets`.
- Teams app steps: `packages/teams-app/src/index.ts`, `steps` array
  (exported as `teamsAppSteps`). Ids `B2-scaffold` through
  `B14-emit-secrets`.

Both step lists are introspected by the CLI plan-mode renderer to produce
the WBS section of `plan.md`.
