# Troubleshooting

Every internal failure raises an `AppFactoryError` (or a subclass) with a
stable string `code`. The list below covers the codes most likely to
surface during a real run, sourced from `packages/shared/src/errors.ts`
and the packages that throw them.

## How to read the error

The CLI prints the full stack trace of any uncaught error and exits
non-zero. Captured (per-step) errors appear in the JSON summary as
`errors[]`; non-fatal issues become `warnings[]`. Inside the run, the
WBS executor logs each step start / done / fail via the `onStep` hook.

For an error you want to identify in code, match on `err instanceof
AppFactoryError && err.code === '<CODE>'`. `recoverable: true` errors
are the ones the judge panel turns into synthetic `:unavailable`
verdicts; everywhere else, the WBS step that threw will halt.

## Failure modes

### 1. `AUTH` — auth broker rejected the request

Source: `packages/auth-broker/src/index.ts`. Raised as `AuthError` when
`mode: 'sp'` is requested but `clientId` / `clientSecret` (or
`AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`) is missing, or an unknown auth
mode is passed.

Recovery:

- Export `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
- Or switch to `mode: 'interactive'` / `'chained'` (the default).
- See [auth-and-secrets.md](./auth-and-secrets.md).

### 2. `PORTAL_REQUIRED` — API path needs a browser click

Source: `PortalRequiredError` in `packages/shared/src/errors.ts`. The
copilot-studio `pac` wrapper raises this when `pac` is not authenticated
or rejects ServicePrincipal auth in a recoverable way, and the OpenAPI
v3-downgrade path raises it pointing at
`https://make.powerautomate.com/connectors`. The Teams `atk` wrapper
likewise emits this for steps that need consent in the Teams Developer
Portal.

Recovery: open `err.portalUrl`, complete the action manually, re-run.
Programmatic recovery: wrap the caller in `withFallback({ primary,
playwright, computerUse })` (see [architecture.md](./architecture.md)).

### 3. `PORTAL_FALLBACK_EXHAUSTED` — no fallback succeeded

Source: `packages/portal-automation/src/fallback.ts`. The primary path
threw `PortalRequiredError`, the optional `playwright` path failed (or
was not provided), and the optional `computerUse` path also failed (or
was not provided). The original `PortalRequiredError` is attached as
`cause`.

Recovery: open `cause.portalUrl`, finish the step manually, re-run. If
the Playwright path failed because of a selector drift, file a bug
against `packages/portal-automation/src/pages/*`.

### 4. `TMUX` — `tmux` invocation failed

Source: `packages/orchestrator/src/tmux.ts`. Wraps any non-zero `tmux`
exit. Most common cause: `tmux` is not installed.

Recovery: install tmux (`apt install tmux`, `brew install tmux`, etc).
On WSL ensure it is on `PATH` for the same shell that runs `pnpm`.

### 5. `TMUX_WAIT_TIMEOUT` — worker did not produce expected output

Source: `WorkerHandle.waitFor` in `tmux.ts`. Default timeout is 120s.
The GH Copilot judge uses 60s.

Recovery: inspect the worker by attaching to the session
(`tmux attach -t app-factory`) before the window is killed; rerun the
failing step with more verbose logging; if reproducible, raise the
`timeoutMs` at the call site.

### 6. `WBS_DEADLOCK` — step dependencies cannot be resolved

Source: `packages/orchestrator/src/wbs.ts`. Raised when no step is ready
to run and not all steps are done — typically because a `dependsOn` id
does not match any step id.

Recovery: this is a bug, not a runtime configuration issue. Compare the
`dependsOn` list of the named missing step against the `id` field of
every step in the same WBS array.

### 7. `JUDGE_VETO` — judge panel vetoed the artifact

Source: `JudgeVetoError` (`packages/shared/src/errors.ts`), raised by
`JudgePanel.reviewOrThrow` and by `autoImprove` when `maxRounds` is
reached. Marked `recoverable: true`. The error carries
`votes: { judge, verdict, reason }[]`.

Recovery: review the dissenting votes; address the `repairNotes`; rerun
the recipe. The default WBS A11 / B13 steps swallow this and push it
to `ctx.warnings`, so a vetoed panel does not block secret emission
unless you wire your own gate.

### 8. `CLAUDE_JUDGE_NO_KEY` / `GH_COPILOT_UNAVAILABLE` / `CS_JUDGE_NO_SECRET`

All three are `recoverable: true`. Sources:

- `packages/judge-panel/src/judges/claude.ts` — missing
  `ANTHROPIC_API_KEY`.
- `packages/judge-panel/src/judges/copilot.ts` — `gh` not on `PATH` or
  unresponsive.
- `packages/judge-panel/src/judges/copilot-studio.ts` — missing
  `COPILOT_STUDIO_JUDGE_SECRET`.

Recovery: set the missing env var (or `gh auth login` for Copilot).
Until then the panel records the judge as `:unavailable` and keeps
going; you will likely also see a quorum warning in `repairNotes`.

### 9. `PIM_ACTIVATION` — PIM elevation did not complete in time

Source: `packages/azure-ops/src/pim.ts`. Teams WBS step `B5-pim` calls
`activatePim({ roleName: 'Application Administrator' })` best-effort,
catches anything thrown, and converts it into a warning — so this code
usually shows up in `warnings[]`, not `errors[]`.

Recovery: activate the role manually in the Entra PIM portal and re-run.

### 10. `ROLE_ASSIGNMENT` — Contributor grant failed

Source: `packages/azure-ops/src/service-principal.ts`. Raised when
`assignContributorOnResourceGroup` cannot place the role.

Recovery: confirm the bootstrap credential has Owner (or User Access
Administrator) on the target subscription / RG; check that the RG
exists and is not locked.

### 11. `NO_SUBSCRIPTION` — credential sees no usable subscription

Source: `packages/azure-ops/src/subscription.ts`. Either the credential
has no subscriptions visible, no enabled subscription, or the
`subscriptionId` hint did not match anything.

Recovery: confirm your SP / user has the right RBAC; pass `subscription`
explicitly via `--answer subscription=<guid>` or set it on the recipe.

### 12. `LOGO_PROVIDER_NOT_CONFIGURED` / `LOGO_PROVIDER_NOT_INSTALLED` / `LOGO_MISSING`

Source: `packages/logo-pipeline/src/index.ts`. These are all
`recoverable: true` and surface as warnings in Copilot Studio step A8:

- `LOGO_MISSING` — no `logoPath` and `LOGO_PROVIDER=skip` (the default).
  The run continues without a brand image.
- `LOGO_PROVIDER_NOT_CONFIGURED` — `LOGO_PROVIDER=azure-openai` or
  `openai` but the required env vars (`AZURE_OPENAI_ENDPOINT`,
  `AZURE_OPENAI_IMAGE_DEPLOYMENT`, `AZURE_OPENAI_API_KEY`, or
  `OPENAI_API_KEY`) are missing.
- `LOGO_PROVIDER_NOT_INSTALLED` — the optional `@azure/openai` /
  `openai` package is not installed.

Recovery: supply `logoPath`, or set the provider + its env vars and
install the relevant SDK.

## When in doubt

- Re-run with `--plan` first and compare the rendered WBS step list to
  the IDs in `packages/copilot-studio/src/index.ts` /
  `packages/teams-app/src/index.ts`.
- Attach to the tmux session (`tmux attach -t app-factory`) while a run
  is live — every worker is a window you can inspect.
- The paste bundle in `RunResult.pasteBundle` always includes the
  warnings list; that is usually where partial failures show up.
