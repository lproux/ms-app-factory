import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger, type FactoryContext, type RunResult } from '@app-factory/shared';

/**
 * Env-var schema for every smoke script. Each script reads the same set so a
 * single shared `.env`-style export (or GitHub Actions secret block) drives all
 * four entry points. Required vars are validated up-front and the process
 * exits with a non-zero status when anything is missing.
 *
 * Required (live tenant):
 *   AZURE_TENANT_ID            — Entra tenant GUID for the test SP.
 *   AZURE_SUBSCRIPTION_ID      — Subscription that owns APP_FACTORY_TEST_RG.
 *   AZURE_CLIENT_ID            — Service principal app id.
 *   AZURE_CLIENT_SECRET        — Service principal secret.
 *   APP_FACTORY_TEST_RG        — Pre-created resource group the SP has Contributor on.
 *   APP_FACTORY_TEST_REGION    — Azure region for any net-new resources (e.g. eastus).
 *   APP_FACTORY_TEST_PP_ENV    — Power Platform environment id or display name.
 *   APP_FACTORY_TEST_LOGO      — Absolute path to a PNG/SVG logo for the brand step.
 *
 * Optional:
 *   APP_FACTORY_KEY_VAULT_URL  — When set, emitted secrets are written to this vault.
 */
export interface SmokeEnv {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly powerPlatformEnvironment: string;
  readonly logoPath: string;
  readonly keyVaultUrl?: string;
}

const REQUIRED_VARS = [
  'AZURE_TENANT_ID',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'APP_FACTORY_TEST_RG',
  'APP_FACTORY_TEST_REGION',
  'APP_FACTORY_TEST_PP_ENV',
  'APP_FACTORY_TEST_LOGO',
] as const;

export function loadSmokeEnv(): SmokeEnv {
  const missing: string[] = [];
  for (const name of REQUIRED_VARS) {
    const v = process.env[name];
    if (typeof v !== 'string' || v.length === 0) missing.push(name);
  }
  if (missing.length > 0) {
    const log = createLogger('smoke:env');
    log.error({ missing }, 'required env vars missing — refusing to run');
    process.stderr.write(
      `Missing required env vars for smoke tests: ${missing.join(', ')}\n` +
        'See docs/smoke-tests.md for the full schema.\n',
    );
    process.exit(2);
  }
  return {
    tenantId: process.env.AZURE_TENANT_ID as string,
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID as string,
    clientId: process.env.AZURE_CLIENT_ID as string,
    clientSecret: process.env.AZURE_CLIENT_SECRET as string,
    resourceGroup: process.env.APP_FACTORY_TEST_RG as string,
    region: process.env.APP_FACTORY_TEST_REGION as string,
    powerPlatformEnvironment: process.env.APP_FACTORY_TEST_PP_ENV as string,
    logoPath: process.env.APP_FACTORY_TEST_LOGO as string,
    keyVaultUrl: process.env.APP_FACTORY_KEY_VAULT_URL,
  };
}

/**
 * Deterministic run-id prefix so cleanup can match every artifact a smoke run
 * produced (resource groups, Entra apps, CS solutions, Teams app registrations,
 * secrets in Key Vault). The date component is UTC `YYYYMMDD`; the suffix is a
 * 4-character base36 token derived from the current millis + crypto random
 * jitter so two runs in the same minute don't collide.
 */
export function newRunId(now: Date = new Date()): string {
  const y = now.getUTCFullYear().toString().padStart(4, '0');
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = now.getUTCDate().toString().padStart(2, '0');
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
    .slice(-4);
  return `smoke-${y}${m}${d}-${rand}`;
}

export const RUN_ID_PREFIX = 'smoke-';

/**
 * Build a `FactoryContext`-shaped object from the smoke env-var schema. The
 * caller decides `planOnly` and `recipe`. The workdir is always under the OS
 * temp dir so artifacts are easy to discard.
 */
export async function buildSmokeContext(opts: {
  env: SmokeEnv;
  runId: string;
  recipe: FactoryContext['recipe'];
  planOnly: boolean;
  brandName: string;
}): Promise<FactoryContext> {
  const workdir = path.join(
    process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? '/tmp',
    'app-factory-smoke',
    opts.runId,
  );
  await fs.mkdir(workdir, { recursive: true });
  return {
    runId: opts.runId,
    recipe: opts.recipe,
    planOnly: opts.planOnly,
    workdir,
    brand: {
      name: opts.brandName,
      logoPath: opts.env.logoPath,
    },
    kbSources: [],
    tenant: {
      tenantId: opts.env.tenantId,
      subscriptionId: opts.env.subscriptionId,
      resourceGroup: opts.env.resourceGroup,
      region: opts.env.region,
      powerPlatformEnvironment: opts.env.powerPlatformEnvironment,
    },
    auth: { mode: 'sp', spClientId: opts.env.clientId },
    emit: {
      keyring: false,
      revealSecrets: false,
      ...(opts.env.keyVaultUrl ? { keyVault: opts.env.keyVaultUrl } : {}),
    },
    judge: { shape: 'cross-model', maxRounds: 3 },
  };
}

/**
 * Pretty-print a `RunResult` summary on the way out so a CI operator scanning
 * the workflow log can tell instantly whether the smoke succeeded and what was
 * provisioned.
 */
export function summarize(result: RunResult, label: string): void {
  const log = createLogger(`smoke:${label}`);
  log.info(
    {
      ok: result.ok,
      runId: result.runId,
      artifacts: result.artifacts.length,
      secrets: result.secrets.length,
      warnings: result.warnings.length,
      errors: result.errors.length,
    },
    `smoke ${label} complete`,
  );
  for (const w of result.warnings) log.warn({ w }, 'warning');
  for (const e of result.errors) log.error({ e }, 'error');
}
