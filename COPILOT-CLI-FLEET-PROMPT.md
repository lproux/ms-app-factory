# Paste into GitHub Copilot CLI — App Factory fleet build

> **How to use**
>
> 1. Open a Copilot CLI session in a fresh terminal.
> 2. Paste the entire block below as a single message.
> 3. Let it run. The master Claude Code session in WSL watches `.fleet-status.jsonl` for updates.
>
> The prompt insists on the **maximum number of agents** the CLI can spawn and **maximum (extra-high) reasoning** for every agent.

---

```text
/fleet max /swarm max

# IMPORTANT — agent count + reasoning budget
- Spawn the MAXIMUM number of agents this account and tier allow. Do not
  conserve. If the tool exposes a "/fleet N" or "/swarm N" syntax, use the
  largest N the tier permits (32, 64, 128, whatever the cap is). If no cap is
  exposed, request "/fleet max /swarm max" and assume unlimited until the
  service rejects.
- Set every agent's reasoning effort to the HIGHEST tier available
  ("high"/"extra-high"/"max"/"thinking-high" — whatever name the CLI uses).
  Set `--reasoning high` or equivalent flag on every spawn. Never use medium
  or low.
- Use the most capable underlying model offered (e.g. GPT-5 / GPT-5-Codex /
  Claude Opus 4.7 / o5 reasoning — whichever the CLI exposes at the top of
  its model list).
- Token budgets per agent: as high as the tier allows. Do not self-cap.
- Parallelism: every bucket below should be claimed concurrently. Do not
  serialize unless an acceptance criterion depends on a prior bucket.

# Mission
Build the App Factory monorepo to a deployable state. The monorepo is a
single-binary factory that provisions Copilot Studio agents AND Microsoft
Teams apps end-to-end, runnable as a skill from both Claude Code and GitHub
Copilot CLI.

# Single source of truth (read these BEFORE coding)
- Plan file (read in full):
    Linux:   /home/lproux/.claude/plans/i-want-to-delightful-orbit.md
    Windows: \\wsl.localhost\Ubuntu\home\lproux\.claude\plans\i-want-to-delightful-orbit.md
- Repo root (canonical):
    WSL:     /mnt/c/Users/lproux/OneDrive\ -\ Microsoft/bkp/Desktop/App\ Factory
    Windows: C:\Users\lproux\OneDrive - Microsoft\bkp\Desktop\App Factory
  Owner requested the OneDrive-synced location; node_modules/ is ignored from
  OneDrive client (exclude via Settings → Sync and backup).
- Stack: TypeScript + Node.js 22, ESM only, pnpm 11 workspaces + turbo +
  tsup + biome + vitest. TS strict, noUncheckedIndexedAccess ON.
- Package naming: @app-factory/<short-name>; workspace deps via "workspace:*".

# Locked decisions (DO NOT relitigate — debate ends now)
- Scope: Copilot Studio AND Teams in parallel — both ship together.
- Auth: hybrid — InteractiveBrowser/DeviceCode for admin consent + PIM,
  ClientSecret SP for resource ops. Use ChainedTokenCredential.
- Secrets: keytar primary, optional Azure Key Vault adapter.
- Orchestrator: tmux session named `app-factory`; every long-running CLI
  invocation goes through @app-factory/orchestrator spawn().
- KB sources accepted: local, sharepoint, url, github, aws-s3, gcp-gcs,
  foundry, m365-admin. Design the connector contract as extensible.
- Logo: user-provided file preferred; image-model fallback (provider
  selected by LOGO_PROVIDER env: azure-openai|openai|skip).
- Autonomy: fully autonomous, no confirmation gates anywhere.
- Judge panel: multi-model — Claude (via @anthropic-ai/sdk) + GitHub Copilot
  (via a tmux worker running `gh copilot`) + Copilot Studio judge (via
  Direct Line API).

# Phase 1 (already shipped by the master orchestrator — DO NOT REWRITE)
Files exist at the paths below. Read them; do not regenerate.
- packages/shared              types/log/errors/telemetry
- packages/auth-broker         getCredential() + adminConsentUrl()
- packages/secret-store        keytar + KV adapter + buildPasteBundle()
- packages/orchestrator        tmux session pool + WBS executor
- packages/elicitation         engine + schema + two recipes
- packages/copilot-studio      WBS A skeleton (placeholders A2–A12)
- packages/teams-app           WBS B skeleton (placeholders B2–B14)
- packages/skill-adapters/claude         SKILL.md installer
- packages/skill-adapters/copilot-cli    `gh` extension installer
- packages/cli                 commander-based bin (build, list-recipes, --plan)
- recipes/                     two starter YAML recipes
- Root: package.json, pnpm-workspace.yaml (onlyBuiltDependencies set),
  turbo.json, biome.json, tsconfig.base.json, .gitignore, .nvmrc, README.md

# Phase 2 — your work (8 buckets — claim ALL of them concurrently)

Each agent claims one bucket. Open a branch `feat/<bucket-id>`. Land working
slices on `main` continuously; do not wait for an end-of-bucket PR.

### A1 — Copilot Studio: `pac` wrapper + env/solution lifecycle
Replace placeholders A2, A3, A9 in packages/copilot-studio/src/index.ts.
Write packages/copilot-studio/src/pac.ts: typed execa wrapper around `pac
env list/create`, `pac solution init/add-reference/import/export`,
`pac auth create`. Use `--json` outputs where pac supports them.
First-use UX: if `pac` is missing, print exact install command
(`dotnet tool install --global Microsoft.PowerApps.CLI.Tool`) and throw
`PortalRequiredError`.
ACCEPTANCE:
- `app-factory build -r copilot-studio-support-bot --plan` lists the real
  pac commands.
- Full run creates a Dataverse solution in a dev environment and prints the
  solution + env id.

### A2 — Copilot Studio: agent definition + KB ingest
Build packages/copilot-studio/src/agent-definition.ts (topics, instructions,
generative answers config as Dataverse XML/JSON inside a solution zip).
Build packages/copilot-studio/src/kb-upload.ts dispatching by KbSource.kind:
  local → SharePoint doc-lib upload via Graph SDK
  sharepoint → Copilot Studio Kit File Sync record via Dataverse Web API
  url → Playwright crawl → MD → SharePoint
  github → simple-git clone → docs/code → SharePoint
  aws-s3, gcp-gcs, foundry, m365-admin → connector stubs with TODO + warn
Wire A5 + A6.
ACCEPTANCE:
- `--answer kbSources="local:./samples/docs,url:https://example.com/docs"`
  uploads content and creates the File Sync record.

### A3 — Copilot Studio: REST tools + branding + publish
A7: Custom Connector from OpenAPI v2 (auto-downgrade v3 → v2).
A8: NEW packages/logo-pipeline — sharp resize to 192×192 + 32×32; upload via
Dataverse Web API. Fallback uses LOGO_PROVIDER env.
A9: `pac solution import --activate-plugins` + Copilot Studio publish.
ACCEPTANCE:
- Published agent visible in Copilot Studio with logo/color/greeting, can
  be invoked from Teams test panel.

### B1 — Teams: Azure ops + Entra + bot registrations
NEW packages/azure-ops: subscription/RG via @azure/arm-resources; SP + role
assign via @azure/arm-authorization; PIM activation via `az` CLI in a worker
tmux session (interactive for the elevation prompt).
Wire B3, B4, B5 in packages/teams-app/src/index.ts.
B6: Entra app + bot registration via @microsoft/microsoft-graph-client;
stamp env vars into env/.env.<env>.
ACCEPTANCE:
- Full run lands SP + RG + Entra app + bot reg; all IDs land in paste
  bundle.

### B2 — Teams: atk wrapper + provision/deploy/package/validate/publish
packages/teams-app/src/atk.ts: typed wrapper around
`@microsoft/m365agentstoolkit-cli` covering `atk new`, `atk provision`,
`atk deploy`, `atk package`, `atk validate`, `atk update teams-app`,
`atk preview`. Install via npm if missing; surface the required version.
Wire B2, B7, B8, B9, B10, B11.
ACCEPTANCE:
- Combined with B1: end-to-end run sideloads a Teams bot into the dev
  tenant; `teams app doctor` is clean.

### C1 — Portal automation (Playwright + computer-use fallback)
NEW packages/portal-automation: Playwright Page library for M365 admin
centre + Power Platform admin centre + Azure portal. Stable selectors only;
prefer accessible roles/names.
Provide `withFallback(primaryFn, playwrightFn, computerUseFn)` chain: on
PortalRequiredError → playwright; on playwright failure → Anthropic
computer-use task via @anthropic-ai/sdk (env ANTHROPIC_API_KEY).
ACCEPTANCE:
- Inject PortalRequiredError into A4; verify playwright fallback completes
  the Entra admin-consent screen.

### D1 — Judge panel + auto-improve loop
NEW packages/judge-panel: persona contracts (architect / security / cost /
UX). Claude judges via @anthropic-ai/sdk. GH Copilot judge via the
orchestrator's tmux running `gh copilot`. Copilot Studio judge via Direct
Line API.
Voting + tie-break + escalation. Wire into A11 + B13.
Auto-improve: on JudgeVetoError, regenerate the failing step's input using
the panel's repair notes; cap = "panel-confirmed convergence" (NO fixed
retry count, NO token cap on subagents).
ACCEPTANCE:
- Inject a KB-grounding regression in an A6 fixture; panel catches it,
  auto-improve produces a fix, second pass clears.

### E1 — Cost optimizer + paste-bundle polish
packages/azure-ops/src/cost.ts: Azure Advisor query + sku/region swap
heuristics; emit deltas.
packages/secret-store/src/paste.ts: enrich buildPasteBundle() with section
headers per artifact, a `.env`-compatible block, and a "clawpilot" copy
block (a single fenced block ready to paste back into Claude Code or
`gh copilot`).
Wire C13.
ACCEPTANCE:
- Final run report contains "Cost optimizer suggestions" with ≥1 Advisor-
  driven sku-swap delta.

# Cross-bucket conventions

- Logger: createLogger('<scope>') from @app-factory/shared. Never console.log.
- Errors: throw AppFactoryError / AuthError / ProvisioningError /
  PortalRequiredError / JudgeVetoError from @app-factory/shared. Never raw
  Error.
- Long-running CLIs: spawn through @app-factory/orchestrator into the
  `app-factory` tmux session so the master orchestrator can watch.
- Secrets: persist via SecretStore + appear in the paste bundle.
- New packages: package.json (workspace:* deps), tsconfig.json (extends
  ../../tsconfig.base.json), tsup build → ESM + dts, target node22.
- Tests: vitest. Happy-path + one failure-path per public function.
- TS: noUncheckedIndexedAccess is ON. Handle undefined explicitly.
- Format/lint: biome (`pnpm lint && pnpm typecheck && pnpm build`).
- Run THESE three commands clean before declaring any slice done:
    pnpm install
    pnpm typecheck
    pnpm build

# Sync protocol with the master Claude Code session

Append one JSON object per update to /mnt/c/Users/lproux/OneDrive\ -\ Microsoft/bkp/Desktop/App\ Factory/.fleet-status.jsonl:
  {"ts":"<iso>","bucket":"A1","status":"in_progress|done|blocked",
   "notes":"<one-liner>"}

For decisions requiring master input, write to .fleet-questions.jsonl:
  {"ts","bucket","question","options"}
The master will reply in .fleet-answers.jsonl.

Trunk-based development; commit every working slice. If you break the
build, your bucket goes red and you fix forward — never disable a test, a
lint rule, or a strict TS flag to make red go green.

# Right now (do these in this order, then start your bucket)

1. cd /mnt/c/Users/lproux/OneDrive\ -\ Microsoft/bkp/Desktop/App\ Factory && pnpm install && pnpm typecheck && pnpm build
   — verify Phase 1 still builds.
2. Read the plan file in full.
3. Read each Phase 1 package's src/ in full — understand the shared types
   and orchestrator API before extending them.
4. Claim a bucket by appending your first .fleet-status.jsonl entry.
5. Work. Push. Repeat. Maximum reasoning, maximum agents, no self-throttling.
```

---

**Important addenda for the user (you):**

- This prompt assumes Copilot CLI exposes `/fleet` and `/swarm` slash commands or equivalent multi-agent constructs. If your version doesn't recognize those literal commands, the prose still instructs the model to "spawn the maximum number of agents this account and tier allow" so it'll do the right thing with whatever multi-agent feature is available.
- It explicitly forbids self-throttling on tokens, agents, or reasoning effort — matches your "no token limit or subagent limit" requirement.
- The sync files (`.fleet-status.jsonl`, `.fleet-questions.jsonl`, `.fleet-answers.jsonl`) will appear at `/mnt/c/Users/lproux/OneDrive\ -\ Microsoft/bkp/Desktop/App\ Factory/` once any fleet agent starts work. The master Claude session can `tail -F` those.
- If you want to add more buckets (e.g., a `F1 — judge-panel: image judge for logo`), just append them with the same shape and re-paste.
