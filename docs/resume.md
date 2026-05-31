# Resuming a halted run

When `app-factory build` halts mid-WBS — most commonly because a step
threw `PortalRequiredError` (e.g. A4 / B6 hitting the Entra portal
fallback) — you do **not** have to start over. The orchestrator writes a
checkpoint after every successful step to:

    <workdir>/state.json

where `<workdir>` defaults to `<cwd>/.app-factory/<runId>`.

## When to resume

- A live step opened a portal URL (the run printed `→ Open portal: ...`).
- A network blip killed a long-running provisioning step.
- You deliberately Ctrl+C'd to inspect partial state and want to pick up
  where you left off.

**Don't** resume if:

- You changed answers (brand name, KB sources, region, subscription).
  Start a fresh run instead — the existing checkpoint encodes the
  previous answers in its `stepArtifacts`.
- The run already completed past its publish step. The publish steps
  themselves are idempotent on the CLI side, but downstream
  `*-emit-secrets` always re-runs to refresh the paste bundle.

## How

    # First run halts at A4 because the Entra portal must be opened:
    app-factory build --recipe copilot-studio-support-bot \
      --answer name=Acme --answer environment=new

    # → Run aborted, error reports runId `Yr_8aL3xPq`.
    # Complete the portal step, then:
    app-factory build --recipe copilot-studio-support-bot --resume Yr_8aL3xPq

The doctor preflight is skipped on `--resume` — we assume the same
machine ran the original invocation, and a missing tool would already
have failed there. Pass `--skip-doctor` on the first run if you want
parity.

## What's persisted

`state.json` is intentionally small. Per step id, only the ctx fields
that downstream steps need to see:

| Step                  | Persisted in `stepArtifacts[step]`            |
| --------------------- | --------------------------------------------- |
| `A2-resolve-environment` | `{ environment: { id, displayName, url, ... } }` |
| `A3-solution-skeleton`   | `{ solutionDir, solutionZip, agentDef }`         |
| `A9-publish`             | `{ agentRecordId, invokeUrl }`                   |
| `B2-scaffold`            | `{ project: { projectPath, appName } }`          |
| `B3-azure-rg`            | `{ azure: { subscriptionId, resourceGroup, region } }` |
| `B4-sp`                  | `{ sp: { appId, objectId, secret } }`            |
| `B6-registrations`       | `{ entra: { appId, ... }, bot: { botId, ... } }` |
| `B7-provision` … `B11-publish` | `{ done: true }` (boolean done markers)    |

`completedStepIds` records the full set of finished step ids, so the
WBS executor skips them on resume.

**Not persisted** (intentionally):

- Transient log lines and `span` telemetry.
- Smoke-test results (`A10`, `B12`) — these are cheap to re-run and
  capture freshness data.
- Judge panel outputs (`A11`, `B13`) — same rationale.
- Secrets (`*-emit-secrets`) — the keyring is already the source of
  truth; resuming re-runs the emit step to regenerate the paste bundle.

## Limitations

- **Resume after a publish step is effectively a no-op for the
  upstream WBS.** B11 / A9 already shipped the app; the resume will run
  the unpersisted tail (smoke tests, judges, secrets emit) and exit.
- **No multi-machine resume.** The checkpoint encodes local paths
  (workdir, solutionDir) that won't make sense on a different host.
- **Checkpoint format is private.** Don't hand-edit `state.json` — if
  it's corrupt, the CLI throws `CHECKPOINT_CORRUPT`. Delete the file
  and start a fresh run.
- **Service principal / Entra secrets are NOT in the checkpoint.** The
  `secret` fields in `B4-sp` / `B6-registrations` are written to
  `state.json` so the resumed run sees them; the file lives under
  `.app-factory/` which is gitignored, but treat the workdir as
  sensitive (chmod 700 if you're on a shared box).

## Listing resumable runs

`app-factory list-runs` is the planned UX for discovering
`<cwd>/.app-factory/*/state.json` files. Until it lands, just:

    ls .app-factory/*/state.json
