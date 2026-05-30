# Plan — Copilot Studio — Support Bot

A Dataverse-backed support agent with knowledge base, REST tools, and Teams channel publish.

## Inputs

- **Agent display name** — `Acme`
- **One-line purpose** — `Triage`
- **Primary audience** — `Internal`
- **Power Platform environment (id or "new")** — `new`
- **Knowledge base sources (kind=local|sharepoint|url|github|aws-s3|gcp-gcs:uri, comma-separated)** — `(unset)`
- **Path to logo file (optional)** — `(unset)`
- **Publish channels** — `["teams"]`

## Target

- Engine: `copilot-studio`

## WBS — Copilot Studio (WBS A)

- `A2-resolve-environment` — Resolve target Power Platform environment via `pac env list/create`.
- `A3-solution-skeleton` — Create Dataverse solution skeleton (publisher, prefix) via `pac solution init`. _(after: A2-resolve-environment)_
- `A4-entra-app` — Provision Entra app + admin consent URL (delegates to teams-app/azure-ops). _(after: A3-solution-skeleton)_
- `A5-agent-definition` — Enrich agent topics/instructions (uses fctx.brand greeting + KB-derived fallback). _(after: A4-entra-app)_ _(group: A-build)_
- `A6-kb-ingest` — Ingest KB sources (local/SharePoint/URL/GitHub/AWS/GCP/Foundry/M365). _(after: A4-entra-app)_ _(group: A-build)_
- `A7-rest-tools` — Wire REST/OpenAPI v2 tools (only when fctx.brand.options.restSpecPath is set). _(after: A4-entra-app)_ _(group: A-build)_
- `A8-brand` — Upload logo variants + colors + greeting to the agent record. _(after: A4-entra-app)_ _(group: A-build)_
- `A9-publish` — Import solution then publish via Copilot Studio / pac. _(after: A5-agent-definition, A6-kb-ingest, A7-rest-tools, A8-brand)_
- `A10-smoke-test` — Direct Line + Copilot Studio Kit Test Automation smoke tests (Wave 2). _(after: A9-publish)_
- `A11-judge-panel` — Multi-model judge panel review (architect/security/cost/UX). _(after: A10-smoke-test)_
- `A12-emit-secrets` — Emit secrets bundle (pac auth profile, envId, agentId) to keyring + paste blob. _(after: A11-judge-panel)_