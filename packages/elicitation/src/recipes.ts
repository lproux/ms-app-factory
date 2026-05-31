import type { Recipe } from './schema.js';

export const copilotStudioSupportBot: Recipe = {
  id: 'copilot-studio-support-bot',
  title: 'Copilot Studio — Support Bot',
  description: 'A Dataverse-backed support agent with knowledge base, REST tools, and Teams channel publish.',
  target: 'copilot-studio',
  questions: [
    { id: 'name', prompt: 'Agent display name', kind: 'text', required: true },
    { id: 'purpose', prompt: 'One-line purpose', kind: 'text', required: true },
    { id: 'audience', prompt: 'Primary audience', kind: 'text', required: true },
    {
      id: 'environment',
      prompt: 'Power Platform environment (id or "new")',
      kind: 'text',
      required: true,
      default: 'new',
    },
    {
      id: 'kbSources',
      prompt: 'Knowledge base sources (kind=local|sharepoint|url|github|aws-s3|gcp-gcs:uri, comma-separated)',
      kind: 'text',
      required: false,
    },
    { id: 'logoPath', prompt: 'Path to logo file (optional)', kind: 'path', required: false },
    {
      id: 'channels',
      prompt: 'Publish channels',
      kind: 'multi-choice',
      required: true,
      default: ['teams'],
      options: [
        { value: 'teams', label: 'Microsoft Teams' },
        { value: 'web', label: 'Web (Direct Line)' },
        { value: 'm365-copilot', label: 'M365 Copilot agent' },
      ],
    },
  ],
};

export const copilotStudioFieldService: Recipe = {
  id: 'copilot-studio-field-service',
  title: 'Copilot Studio — Field Service Agent',
  description:
    'A Dataverse + Dynamics 365 Field Service agent that handles work orders, scheduling lookups, and technician dispatch hand-offs across Teams and web channels.',
  target: 'copilot-studio',
  questions: [
    { id: 'name', prompt: 'Agent display name', kind: 'text', required: true },
    { id: 'purpose', prompt: 'One-line purpose', kind: 'text', required: true },
    { id: 'audience', prompt: 'Primary audience (e.g. technicians, dispatchers)', kind: 'text', required: true },
    {
      id: 'environment',
      prompt: 'Power Platform environment (id or "new")',
      kind: 'text',
      required: true,
      default: 'new',
    },
    {
      id: 'dynamicsOrgUrl',
      prompt: 'Dynamics 365 organization URL (e.g. https://contoso.crm.dynamics.com)',
      kind: 'url',
      required: true,
    },
    {
      id: 'kbSources',
      prompt: 'Knowledge base sources (kind=local|sharepoint|url|github|aws-s3|gcp-gcs:uri, comma-separated)',
      kind: 'text',
      required: false,
    },
    { id: 'logoPath', prompt: 'Path to logo file (optional)', kind: 'path', required: false },
    {
      id: 'channels',
      prompt: 'Publish channels',
      kind: 'multi-choice',
      required: true,
      default: ['teams', 'web'],
      options: [
        { value: 'teams', label: 'Microsoft Teams' },
        { value: 'web', label: 'Web (Direct Line)' },
        { value: 'm365-copilot', label: 'M365 Copilot agent' },
      ],
    },
  ],
};

export const teamsBotBasic: Recipe = {
  id: 'teams-bot-basic',
  title: 'Teams — Basic Bot',
  description: 'A Teams bot app provisioned via Agents Toolkit CLI (atk), with Entra + bot registration.',
  target: 'teams',
  questions: [
    { id: 'name', prompt: 'App name', kind: 'text', required: true },
    { id: 'purpose', prompt: 'One-line purpose', kind: 'text', required: true },
    {
      id: 'subscription',
      prompt: 'Azure subscription id (or "default")',
      kind: 'text',
      required: true,
      default: 'default',
    },
    { id: 'resourceGroup', prompt: 'Resource group name (existing or new)', kind: 'text', required: true },
    {
      id: 'region',
      prompt: 'Azure region',
      kind: 'choice',
      required: true,
      default: 'eastus',
      options: [
        { value: 'eastus', label: 'East US' },
        { value: 'westus2', label: 'West US 2' },
        { value: 'westeurope', label: 'West Europe' },
        { value: 'canadacentral', label: 'Canada Central' },
      ],
    },
    { id: 'logoPath', prompt: 'Path to logo file (optional)', kind: 'path', required: false },
    {
      id: 'capabilities',
      prompt: 'Capabilities',
      kind: 'multi-choice',
      required: true,
      default: ['bot'],
      options: [
        { value: 'bot', label: 'Conversational bot' },
        { value: 'tab', label: 'Personal tab' },
        { value: 'me', label: 'Message extension' },
      ],
    },
  ],
};

export const teamsTabBasic: Recipe = {
  id: 'teams-tab-basic',
  title: 'Teams — Personal Tab',
  description:
    'A Teams personal tab app provisioned via Agents Toolkit CLI (atk) with the `tab` template, Entra app registration, and a configurable landing route.',
  target: 'teams',
  questions: [
    { id: 'name', prompt: 'App name', kind: 'text', required: true },
    { id: 'purpose', prompt: 'One-line purpose', kind: 'text', required: true },
    {
      id: 'subscription',
      prompt: 'Azure subscription id (or "default")',
      kind: 'text',
      required: true,
      default: 'default',
    },
    { id: 'resourceGroup', prompt: 'Resource group name (existing or new)', kind: 'text', required: true },
    {
      id: 'region',
      prompt: 'Azure region',
      kind: 'choice',
      required: true,
      default: 'eastus',
      options: [
        { value: 'eastus', label: 'East US' },
        { value: 'westus2', label: 'West US 2' },
        { value: 'westeurope', label: 'West Europe' },
        { value: 'canadacentral', label: 'Canada Central' },
      ],
    },
    {
      id: 'tabRoute',
      prompt: 'Default tab route (relative path served by the tab)',
      kind: 'text',
      required: true,
      default: '/',
    },
    { id: 'logoPath', prompt: 'Path to logo file (optional)', kind: 'path', required: false },
  ],
};

export const teamsMessageExtension: Recipe = {
  id: 'teams-message-extension',
  title: 'Teams — Message Extension',
  description:
    'A Teams message-extension app provisioned via Agents Toolkit CLI (atk) with the `messageExtension` template, Entra registration, and a configurable command id.',
  target: 'teams',
  questions: [
    { id: 'name', prompt: 'App name', kind: 'text', required: true },
    { id: 'purpose', prompt: 'One-line purpose', kind: 'text', required: true },
    {
      id: 'subscription',
      prompt: 'Azure subscription id (or "default")',
      kind: 'text',
      required: true,
      default: 'default',
    },
    { id: 'resourceGroup', prompt: 'Resource group name (existing or new)', kind: 'text', required: true },
    {
      id: 'region',
      prompt: 'Azure region',
      kind: 'choice',
      required: true,
      default: 'eastus',
      options: [
        { value: 'eastus', label: 'East US' },
        { value: 'westus2', label: 'West US 2' },
        { value: 'westeurope', label: 'West Europe' },
        { value: 'canadacentral', label: 'Canada Central' },
      ],
    },
    {
      id: 'meCommandId',
      prompt: 'Message-extension command id (alphanumeric, no spaces)',
      kind: 'text',
      required: true,
      default: 'searchCmd',
    },
    { id: 'logoPath', prompt: 'Path to logo file (optional)', kind: 'path', required: false },
  ],
};

export const teamsAgent365: Recipe = {
  id: 'teams-agent-365',
  title: 'Teams — Agent 365',
  description:
    'A Microsoft 365 Copilot agent (Agent 365) scaffolded via the Agent 365 CLI path. KB sources default to the Agent 365 grounding pipeline.',
  target: 'teams',
  questions: [
    { id: 'name', prompt: 'Agent display name', kind: 'text', required: true },
    { id: 'purpose', prompt: 'One-line purpose', kind: 'text', required: true },
    {
      id: 'subscription',
      prompt: 'Azure subscription id (or "default")',
      kind: 'text',
      required: true,
      default: 'default',
    },
    { id: 'resourceGroup', prompt: 'Resource group name (existing or new)', kind: 'text', required: true },
    {
      id: 'region',
      prompt: 'Azure region',
      kind: 'choice',
      required: true,
      default: 'eastus',
      options: [
        { value: 'eastus', label: 'East US' },
        { value: 'westus2', label: 'West US 2' },
        { value: 'westeurope', label: 'West Europe' },
        { value: 'canadacentral', label: 'Canada Central' },
      ],
    },
    {
      id: 'm365CopilotEnabled',
      prompt: 'Is M365 Copilot licensed in the target tenant?',
      kind: 'boolean',
      required: true,
      default: true,
    },
    {
      id: 'kbSourcesAgent365',
      prompt: 'Use the Agent 365 grounding pipeline for KB sources?',
      kind: 'boolean',
      required: false,
      default: true,
    },
    { id: 'logoPath', prompt: 'Path to logo file (optional)', kind: 'path', required: false },
  ],
};

export const allRecipes = [
  copilotStudioSupportBot,
  copilotStudioFieldService,
  teamsBotBasic,
  teamsTabBasic,
  teamsMessageExtension,
  teamsAgent365,
];

export function getRecipe(id: string): Recipe | undefined {
  return allRecipes.find((r) => r.id === id);
}
