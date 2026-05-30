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

export const allRecipes = [copilotStudioSupportBot, teamsBotBasic];

export function getRecipe(id: string): Recipe | undefined {
  return allRecipes.find((r) => r.id === id);
}
