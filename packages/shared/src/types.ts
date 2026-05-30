import { z } from 'zod';

export const RecipeKind = z.enum([
  'copilot-studio-support-bot',
  'copilot-studio-field-service',
  'copilot-studio-custom',
  'teams-bot-basic',
  'teams-tab-basic',
  'teams-message-extension',
  'teams-agent-365',
]);
export type RecipeKind = z.infer<typeof RecipeKind>;

export const KbSourceKind = z.enum([
  'local',
  'sharepoint',
  'url',
  'github',
  'aws-s3',
  'gcp-gcs',
  'foundry',
  'm365-admin',
]);
export type KbSourceKind = z.infer<typeof KbSourceKind>;

export const KbSource = z.object({
  kind: KbSourceKind,
  uri: z.string(),
  options: z.record(z.unknown()).optional(),
});
export type KbSource = z.infer<typeof KbSource>;

export const AuthMode = z.enum(['interactive', 'sp', 'chained']);
export type AuthMode = z.infer<typeof AuthMode>;

export const FactoryContext = z.object({
  runId: z.string(),
  recipe: RecipeKind,
  planOnly: z.boolean().default(false),
  workdir: z.string(),
  brand: z
    .object({
      name: z.string(),
      logoPath: z.string().optional(),
      primaryColor: z.string().optional(),
      greeting: z.string().optional(),
    })
    .optional(),
  kbSources: z.array(KbSource).default([]),
  tenant: z
    .object({
      tenantId: z.string().optional(),
      subscriptionId: z.string().optional(),
      resourceGroup: z.string().optional(),
      powerPlatformEnvironment: z.string().optional(),
      region: z.string().optional(),
    })
    .optional(),
  auth: z
    .object({
      mode: AuthMode.default('chained'),
      spClientId: z.string().optional(),
    })
    .default({ mode: 'chained' }),
  emit: z
    .object({
      keyring: z.boolean().default(true),
      keyVault: z.string().optional(),
      pasteBundlePath: z.string().optional(),
    })
    .default({ keyring: true }),
});
export type FactoryContext = z.infer<typeof FactoryContext>;

export interface ArtifactRef {
  kind: 'entra-app' | 'bot' | 'azure-resource' | 'cs-agent' | 'teams-app' | 'sp' | 'role-assignment';
  id: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface SecretRef {
  scope: string;
  name: string;
  description?: string;
}

export interface RunResult {
  ok: boolean;
  runId: string;
  artifacts: ArtifactRef[];
  secrets: SecretRef[];
  pasteBundle: string;
  log: string;
  warnings: string[];
  errors: string[];
}
