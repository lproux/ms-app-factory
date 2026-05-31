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

/**
 * Configurable judge-panel fan-out shape. See `docs/judge-panel-shapes.md`
 * for the cost/coverage trade-offs and how to pick a shape per recipe.
 *
 * - `compact`     — one judge per model, each prompted with ALL personas in a
 *                   single round-trip. 3 LLM calls per panel review.
 * - `cross-model` — current default: every persona × every model. 12 calls.
 * - `full`        — every persona × every registered judge factory; reserved
 *                   for security-sensitive or extensible deployments.
 */
export const JudgePanelShape = z.enum(['compact', 'cross-model', 'full']);
export type JudgePanelShape = z.infer<typeof JudgePanelShape>;

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
      revealSecrets: z.boolean().default(false),
    })
    .default({ keyring: true, revealSecrets: false }),
  judge: z
    .object({
      shape: JudgePanelShape.default('cross-model'),
      maxRounds: z.number().int().min(1).max(10).default(3),
    })
    .default({ shape: 'cross-model', maxRounds: 3 }),
  /**
   * Optional resume marker. When set, `runCopilotStudio`/`runTeamsApp` will
   * seed the WBS executor's `done` set with the listed step ids and skip
   * those step `run` callbacks; the workers hydrate ctx fields from
   * `stepArtifacts` before the WBS executes. Set by the CLI's
   * `--resume <runId>` flag — runtime callers normally leave this unset.
   *
   * Stored as a passthrough `z.unknown()` to avoid baking the full
   * `Checkpoint` shape into `@app-factory/shared` (which would create a
   * dependency cycle on `@app-factory/orchestrator`).
   */
  resumeFromCheckpoint: z.unknown().optional(),
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
