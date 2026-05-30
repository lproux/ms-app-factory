#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '@app-factory/shared';

const log = createLogger('skill-adapter:claude');

export const SKILL_BODY = `---
name: app-factory
description: Provision Copilot Studio agents and Microsoft Teams apps end-to-end via the App Factory monorepo. Use when the user asks to build, create, scaffold, or publish a Copilot Studio agent or Teams app, when they ask to wire up an agent with a knowledge base, when they say "make a bot", or any time the work is fundamentally about producing a Copilot/Teams artifact (not editing one).
---

# App Factory

A unified factory that drives Copilot Studio + Teams app provisioning from a single command. Knows how to:

- Elicit purpose, audience, brand, KB sources, channels
- Resolve Power Platform environment / Azure subscription + RG
- Provision Entra app, bot registration, Dataverse solution, Azure resources
- Ingest KB from local files, SharePoint, URLs, GitHub, AWS, GCP, Foundry, M365 Admin
- Brand with provided or generated logo
- Publish to Teams / web / M365 Copilot channels
- Run a multi-model judge panel before marking done
- Emit secrets to OS keyring + clipboard-paste blob for copy-paste

## Usage

Plan-only (recommended first run):

\`\`\`sh
app-factory build --recipe copilot-studio-support-bot --plan \
  --answer name="Acme Support" --answer purpose="Triage L1 support" \
  --answer audience="Internal users" --answer environment=new
\`\`\`

Full run:

\`\`\`sh
app-factory build --recipe teams-bot-basic \
  --answer name="HelpDesk Bot" --answer subscription=<id> \
  --answer resourceGroup=rg-helpdesk --answer region=eastus
\`\`\`

List recipes:

\`\`\`sh
app-factory list-recipes
\`\`\`

## Notes

- Authentication is hybrid: SP for unattended ops, interactive (device-code) for admin consent + PIM elevation.
- Secrets default to OS keyring; pass APP_FACTORY_KEY_VAULT_URL to mirror into an Azure Key Vault.
- Orchestrator launches worker terminals in a tmux session named \`app-factory\` — attach with \`tmux attach -t app-factory\` to watch live.
- Plan mode never touches Azure / Power Platform / Teams. Safe to run anywhere.
`;

export interface InstallOptions {
  skillsDir?: string;
  factoryBinPath?: string;
}

export async function installClaudeSkill(opts: InstallOptions = {}): Promise<string> {
  const skillsDir = opts.skillsDir ?? path.join(os.homedir(), '.claude', 'skills', 'app-factory');
  await fs.mkdir(skillsDir, { recursive: true });
  const skillFile = path.join(skillsDir, 'SKILL.md');
  await fs.writeFile(skillFile, SKILL_BODY, 'utf8');
  log.info({ skillFile }, 'Claude skill installed');
  return skillFile;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  installClaudeSkill()
    .then((p) => console.log(`installed: ${p}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
