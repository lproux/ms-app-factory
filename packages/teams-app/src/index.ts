import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  AppFactoryError,
  JudgeVetoError,
  PortalRequiredError,
  ProvisioningError,
  createLogger,
  span,
  type ArtifactRef,
  type FactoryContext,
  type RunResult,
  type SecretRef,
} from '@app-factory/shared';
import { execute, type Step } from '@app-factory/orchestrator';
import { buildPasteBundle, buildSecretStore, type CostSuggestion } from '@app-factory/secret-store';
import { getCredential } from '@app-factory/auth-broker';
import {
  assignAppAdminRole,
  assignContributorOnResourceGroup,
  createBotRegistration,
  createEntraApp,
  createServicePrincipal,
  ensureResourceGroup,
  optimizeCost,
  pickSubscription,
  stampEnvFile,
} from '@app-factory/azure-ops';
import {
  autoImprove,
  JudgePanel,
  makeClaudeJudge,
  makeCopilotStudioJudge,
  makeGhCopilotJudge,
  type JudgeArtifact,
  type PanelResult,
  type Persona,
} from '@app-factory/judge-panel';
import * as atk from './atk.js';
import {
  agent365BlueprintCreate,
  agent365Publish,
} from '@app-factory/agent-365';

const log = createLogger('teams-app');

/**
 * Pick the scaffold engine for the current recipe. Agent 365 recipes use the
 * Microsoft Agent 365 CLI (`agent365 ...`); everything else stays on the
 * Teams Toolkit CLI (`atk ...`).
 */
type ScaffoldKind = 'atk' | 'agent-365';

function pickScaffold(ctx: TACtx): ScaffoldKind {
  return ctx.fctx.recipe === 'teams-agent-365' ? 'agent-365' : 'atk';
}

interface ProjectInfo {
  projectPath: string;
  appName: string;
}

interface AzureInfo {
  subscriptionId: string;
  resourceGroup: string;
  region: string;
}

interface EntraInfo {
  appId: string;
  objectId: string;
  secret: string;
  tenantId: string;
}

interface BotInfo {
  botId: string;
  resourceId: string;
  channels: string[];
}

interface SpInfo {
  appId: string;
  objectId: string;
  secret: string;
}

interface TACtx {
  fctx: FactoryContext;
  artifacts: ArtifactRef[];
  secrets: { ref: SecretRef; value: string }[];
  warnings: string[];
  project?: ProjectInfo;
  azure?: AzureInfo;
  sp?: SpInfo;
  entra?: EntraInfo;
  bot?: BotInfo;
  panel?: PanelResult;
  costSuggestions?: CostSuggestion[];
}

const DEFAULT_ENV = 'dev';
const DEFAULT_REGION = 'eastus';
const DEFAULT_RG = 'rg-app-factory';
const BOT_REDIRECT_URI = 'https://token.botframework.com/.auth/web/redirect';

/**
 * Map a recipe id (any string from `FactoryContext.recipe`) onto the atk
 * template + capability flags that `atk new` expects for the B2 scaffold step.
 * Unknown ids fall back to the legacy `bot` template so existing
 * `teams-bot-basic` flows are unaffected.
 *
 * Note: `teams-agent-365` is included for completeness but the B2 step
 * routes through the Agent 365 CLI (`agent365 blueprint create`) instead of
 * `atk new` — the template/capability values here are advisory only for that
 * recipe.
 */
export interface AtkTemplateChoice {
  template: string;
  capability: string;
}

export function selectAtkTemplate(recipe: string): AtkTemplateChoice {
  switch (recipe) {
    case 'teams-tab-basic':
      return { template: 'tab', capability: 'tab' };
    case 'teams-message-extension':
      return { template: 'messageExtension', capability: 'me' };
    case 'teams-agent-365':
      return { template: 'agent-365', capability: 'agent-365' };
    case 'teams-bot-basic':
    default:
      return { template: 'bot', capability: 'bot' };
  }
}

function requireProject(ctx: TACtx): ProjectInfo {
  if (!ctx.project) {
    throw new AppFactoryError('TEAMS_STATE', 'project info missing — B2-scaffold must run first');
  }
  return ctx.project;
}

function requireAzure(ctx: TACtx): AzureInfo {
  if (!ctx.azure) {
    throw new AppFactoryError('TEAMS_STATE', 'azure info missing — B3-azure-rg must run first');
  }
  return ctx.azure;
}

function requireEntra(ctx: TACtx): EntraInfo {
  if (!ctx.entra) {
    throw new AppFactoryError('TEAMS_STATE', 'entra info missing — B6-registrations must run first');
  }
  return ctx.entra;
}

function requireSp(ctx: TACtx): SpInfo {
  if (!ctx.sp) {
    throw new AppFactoryError('TEAMS_STATE', 'sp info missing — B4-sp must run first');
  }
  return ctx.sp;
}

const steps: Step<TACtx>[] = [
  {
    id: 'B2-scaffold',
    description: 'Scaffold project from atk template or Agent 365 blueprint.',
    run: async (ctx) =>
      span('B2', async () => {
        const appName = ctx.fctx.brand?.name ?? 'teams-bot';
        const folder = ctx.fctx.workdir;
        await mkdir(folder, { recursive: true });
        const projectPath = join(folder, appName);
        const scaffold = pickScaffold(ctx);

        if (scaffold === 'agent-365') {
          // The recipe's `kbSourcesAgent365` answer is not yet plumbed through
          // FactoryContext (no `answers` field); default to true to match the
          // recipe default and the Agent 365 grounding-pipeline expectation.
          // TODO: wire the elicited answer through once FactoryContext gains
          // an `answers` map.
          const kbSourcesAgent365 = true;
          try {
            await mkdir(projectPath, { recursive: true });
            await agent365BlueprintCreate({ name: appName, projectPath, kbSourcesAgent365 });
          } catch (err) {
            if (err instanceof PortalRequiredError) {
              ctx.warnings.push(
                `agent365 CLI unavailable; portal fallback required: ${err.message}`,
              );
              throw err;
            }
            throw err;
          }
          ctx.project = { projectPath, appName };
          ctx.artifacts.push({
            kind: 'teams-app',
            id: projectPath,
            displayName: appName,
            metadata: { scaffold: 'agent-365', kbSourcesAgent365 },
          });
          log.info({ projectPath, appName, kbSourcesAgent365 }, 'B2 Agent 365 blueprint complete');
          return;
        }

        const tmpl = selectAtkTemplate(ctx.fctx.recipe);
        try {
          await atk.atkNew({
            template: tmpl.template,
            name: appName,
            folder,
            capability: tmpl.capability,
          });
        } catch (err) {
          if (err instanceof PortalRequiredError) {
            ctx.warnings.push(`atk CLI unavailable; portal fallback required: ${err.message}`);
            throw err;
          }
          throw err;
        }
        ctx.project = { projectPath, appName };
        ctx.artifacts.push({
          kind: 'teams-app',
          id: projectPath,
          displayName: appName,
          metadata: { scaffold: `atk-${tmpl.template}` },
        });
        log.info({ projectPath, appName, template: tmpl.template }, 'B2 scaffold complete');
      }),
  },
  {
    id: 'B3-azure-rg',
    description: 'Resolve subscription + resource group.',
    dependsOn: ['B2-scaffold'],
    run: async (ctx) =>
      span('B3', async () => {
        const cred = getCredential({
          mode: ctx.fctx.auth.mode,
          tenantId: ctx.fctx.tenant?.tenantId,
        });
        const subHint = ctx.fctx.tenant?.subscriptionId ?? 'default';
        const sub = await pickSubscription(cred, subHint);
        const rgName = ctx.fctx.tenant?.resourceGroup ?? DEFAULT_RG;
        const region = ctx.fctx.tenant?.region ?? DEFAULT_REGION;
        const rg = await ensureResourceGroup(cred, sub.id, rgName, region);
        ctx.azure = { subscriptionId: sub.id, resourceGroup: rg.name, region: rg.location };
        ctx.artifacts.push({
          kind: 'azure-resource',
          id: rg.id,
          displayName: rg.name,
          metadata: { subscriptionId: sub.id, region: rg.location, kind: 'resourceGroup' },
        });
        log.info({ subId: sub.id, rgName: rg.name, region: rg.location }, 'B3 resource group ready');
      }),
  },
  {
    id: 'B4-sp',
    description: 'Create SP, grant Contributor + App Admin.',
    dependsOn: ['B3-azure-rg'],
    run: async (ctx) =>
      span('B4', async () => {
        const cred = getCredential({
          mode: ctx.fctx.auth.mode,
          tenantId: ctx.fctx.tenant?.tenantId,
        });
        const azure = requireAzure(ctx);
        const tenantId = ctx.fctx.tenant?.tenantId ?? 'common';
        const sp = await createServicePrincipal(cred, {
          displayName: `af-sp-${ctx.fctx.runId}`,
          tenantId,
        });
        await assignContributorOnResourceGroup(cred, {
          subId: azure.subscriptionId,
          rgName: azure.resourceGroup,
          principalObjectId: sp.objectId,
        });
        const appAdmin = await assignAppAdminRole(cred, { principalObjectId: sp.objectId });
        if (!appAdmin.assigned && appAdmin.warning) {
          ctx.warnings.push(appAdmin.warning);
          log.warn(appAdmin.warning);
        }
        ctx.sp = { appId: sp.appId, objectId: sp.objectId, secret: sp.secret };
        ctx.artifacts.push({
          kind: 'sp',
          id: sp.objectId,
          displayName: `af-sp-${ctx.fctx.runId}`,
          metadata: { appId: sp.appId, tenantId, secretExpiry: sp.secretExpiry },
        });
        ctx.secrets.push({
          ref: {
            scope: 'teams-app',
            name: 'sp-client-secret',
            description: `Service principal client secret (appId ${sp.appId})`,
          },
          value: sp.secret,
        });
        log.info({ appId: sp.appId }, 'B4 service principal provisioned');
      }),
  },
  {
    id: 'B5-pim',
    description: 'PIM elevation when needed.',
    dependsOn: ['B4-sp'],
    run: async (ctx) =>
      span('B5', async () => {
        const { activatePim } = await import('@app-factory/azure-ops');
        try {
          const result = await activatePim({
            roleName: 'Application Administrator',
            justification: 'App Factory provisioning',
          });
          log.info({ alreadyActive: result.alreadyActive }, 'B5 PIM activation complete');
        } catch (err) {
          const msg = `B5 PIM activation best-effort failed: ${(err as Error).message}`;
          ctx.warnings.push(msg);
          log.warn({ err: (err as Error).message }, msg);
        }
      }),
  },
  {
    id: 'B6-registrations',
    description: 'Entra app reg + bot registration; stamp env vars.',
    dependsOn: ['B5-pim'],
    run: async (ctx) =>
      span('B6', async () => {
        const cred = getCredential({
          mode: ctx.fctx.auth.mode,
          tenantId: ctx.fctx.tenant?.tenantId,
        });
        const azure = requireAzure(ctx);
        const project = requireProject(ctx);
        const displayName = ctx.fctx.brand?.name ?? 'teams-bot';
        const tenantId = ctx.fctx.tenant?.tenantId ?? 'common';

        const app = await createEntraApp(cred, {
          displayName,
          redirectUris: [BOT_REDIRECT_URI],
        });
        ctx.entra = {
          appId: app.appId,
          objectId: app.objectId,
          secret: app.secret,
          tenantId,
        };
        ctx.artifacts.push({
          kind: 'entra-app',
          id: app.objectId,
          displayName,
          metadata: { appId: app.appId, secretExpiry: app.secretExpiry },
        });
        ctx.secrets.push({
          ref: {
            scope: 'teams-app',
            name: 'entra-client-secret',
            description: `Entra app client secret (appId ${app.appId})`,
          },
          value: app.secret,
        });

        const bot = await createBotRegistration(cred, {
          subId: azure.subscriptionId,
          rgName: azure.resourceGroup,
          location: 'global',
          displayName,
          messagingEndpoint: 'https://<to-be-resolved>/api/messages',
          appId: app.appId,
          msaAppType: 'SingleTenant',
          tenantId,
        });
        ctx.bot = bot;
        ctx.artifacts.push({
          kind: 'bot',
          id: bot.resourceId,
          displayName,
          metadata: { botId: bot.botId, channels: bot.channels },
        });

        const envFile = join(project.projectPath, 'env', `.env.${DEFAULT_ENV}`);
        await stampEnvFile(envFile, {
          TEAMS_APP_ID: app.appId,
          AAD_APP_CLIENT_ID: app.appId,
          AAD_APP_OBJECT_ID: app.objectId,
          AAD_APP_TENANT_ID: tenantId,
          BOT_ID: bot.botId,
        });
        log.info({ envFile, appId: app.appId, botId: bot.botId }, 'B6 registrations + env stamp complete');
      }),
  },
  {
    id: 'B7-provision',
    description: '`atk provision --env <env>` (m365agents.yml ARM).',
    dependsOn: ['B6-registrations'],
    run: async (ctx) =>
      span('B7', async () => {
        const project = requireProject(ctx);
        if (pickScaffold(ctx) === 'agent-365') {
          // Agent 365 collapses provision/deploy/package into a single
          // `agent365 publish` invocation (see B11). B7/B8/B9 stay as
          // breadcrumb log entries so the WBS graph is intact.
          log.info('B7 provision: skipped (handled by agent365 publish in B11)');
          return;
        }
        try {
          await atk.atkProvision({ env: DEFAULT_ENV, projectPath: project.projectPath });
        } catch (err) {
          if (err instanceof PortalRequiredError) {
            ctx.warnings.push(`atk provision unavailable; portal fallback: ${err.message}`);
            throw err;
          }
          if (!(err instanceof ProvisioningError)) {
            throw new ProvisioningError(`atk provision wrapper failed: ${(err as Error).message}`, {
              cause: err,
            });
          }
          throw err;
        }
        log.info('B7 provision complete');
      }),
  },
  {
    id: 'B8-deploy',
    description: '`atk deploy --env <env>`.',
    dependsOn: ['B7-provision'],
    run: async (ctx) =>
      span('B8', async () => {
        const project = requireProject(ctx);
        if (pickScaffold(ctx) === 'agent-365') {
          log.info('B8 deploy: skipped (handled by agent365 publish in B11)');
          return;
        }
        try {
          await atk.atkDeploy({ env: DEFAULT_ENV, projectPath: project.projectPath });
        } catch (err) {
          if (err instanceof PortalRequiredError) {
            ctx.warnings.push(`atk deploy unavailable; portal fallback: ${err.message}`);
            throw err;
          }
          throw err;
        }
        log.info('B8 deploy complete');
      }),
  },
  {
    id: 'B9-package',
    description: '`atk package` manifest + icons.',
    dependsOn: ['B8-deploy'],
    run: async (ctx) =>
      span('B9', async () => {
        const project = requireProject(ctx);
        if (pickScaffold(ctx) === 'agent-365') {
          log.info('B9 package: skipped (handled by agent365 publish in B11)');
          return;
        }
        const outDir = join(project.projectPath, 'appPackage', 'build');
        await atk.atkPackage({ env: DEFAULT_ENV, projectPath: project.projectPath, outDir });
        log.info({ outDir }, 'B9 package complete');
      }),
  },
  {
    id: 'B10-validate',
    description: '`atk validate --manifest-path` + `--app-package-file-path`.',
    dependsOn: ['B9-package'],
    run: async (ctx) =>
      span('B10', async () => {
        const project = requireProject(ctx);
        if (pickScaffold(ctx) === 'agent-365') {
          // Agent 365 blueprints validate their own manifest as part of
          // `agent365 publish`; there is no equivalent free-standing
          // `validate` subcommand in the CLI as of 0.2.x.
          log.info('B10 validate: skipped for agent-365 recipe');
          return;
        }
        await atk.atkValidate({
          manifestPath: join(project.projectPath, 'appPackage', 'manifest.json'),
          projectPath: project.projectPath,
          env: DEFAULT_ENV,
        });
        await atk.atkValidate({
          appPackagePath: join(
            project.projectPath,
            'appPackage',
            'build',
            `appPackage.${DEFAULT_ENV}.zip`,
          ),
          projectPath: project.projectPath,
          env: DEFAULT_ENV,
        });
        log.info('B10 validate complete');
      }),
  },
  {
    id: 'B11-publish',
    description: 'Developer Portal publish / sideload.',
    dependsOn: ['B10-validate'],
    run: async (ctx) =>
      span('B11', async () => {
        const project = requireProject(ctx);
        if (pickScaffold(ctx) === 'agent-365') {
          try {
            await agent365Publish({ env: DEFAULT_ENV, projectPath: project.projectPath });
          } catch (err) {
            if (err instanceof PortalRequiredError) {
              ctx.warnings.push(`agent365 publish unavailable; portal fallback: ${err.message}`);
              throw err;
            }
            throw err;
          }
          log.info('B11 agent365 publish complete');
          return;
        }
        await atk.atkUpdateTeamsApp({ env: DEFAULT_ENV, projectPath: project.projectPath });
        log.info('B11 publish complete');
      }),
  },
  {
    id: 'B12-smoke-test',
    description: 'Local Agents Playground + Direct Line probe.',
    dependsOn: ['B11-publish'],
    run: async (ctx) =>
      span('B12', async () => {
        log.info('B12 placeholder — smoke-test wiring lands in Wave 2');
        ctx.warnings.push('B12 smoke-test placeholder (Wave 2).');
      }),
  },
  {
    id: 'B13-judge-panel',
    description: 'Judge-panel review (architect/security/cost/UX).',
    dependsOn: ['B12-smoke-test'],
    run: async (ctx) =>
      span('B13', async () => {
        const personas: Persona[] = ['architect', 'security', 'cost', 'ux'];
        const judges = personas.flatMap((persona) => [
          makeClaudeJudge({ persona }),
          makeGhCopilotJudge({ persona }),
          makeCopilotStudioJudge({ persona }),
        ]);
        const panel = new JudgePanel({ judges, policy: { vetoOn: ['security'] } });
        const buildArtifact = (extraNotes: string[]): JudgeArtifact => ({
          kind: 'teams-app',
          id: ctx.bot?.botId ?? ctx.entra?.appId ?? ctx.fctx.runId,
          displayName: ctx.fctx.brand?.name ?? 'teams-bot',
          summary: [
            `Recipe: ${ctx.fctx.recipe}`,
            `App: ${ctx.fctx.brand?.name ?? 'teams-bot'}`,
            `SubscriptionId: ${ctx.azure?.subscriptionId ?? '<unset>'}`,
            `ResourceGroup: ${ctx.azure?.resourceGroup ?? '<unset>'}`,
            `Region: ${ctx.azure?.region ?? '<unset>'}`,
            `BotId: ${ctx.bot?.botId ?? '<unset>'}`,
            `Artifacts: ${ctx.artifacts.length}`,
            `Warnings so far: ${ctx.warnings.length}`,
            ...(extraNotes.length > 0 ? [`RepairNotes: ${extraNotes.join(' | ')}`] : []),
          ].join('\n'),
          payload: {
            artifacts: ctx.artifacts,
            warnings: ctx.warnings,
            repairNotes: extraNotes,
          },
        });
        try {
          const converged = await autoImprove({
            panel,
            initial: { input: ctx, artifact: buildArtifact([]) },
            maxRounds: 3,
            regenerate: async (input, repairNotes) => {
              input.warnings.push(`B13 auto-improve repair notes: ${repairNotes.join(' | ')}`);
              return { input, artifact: buildArtifact(repairNotes) };
            },
          });
          // autoImprove returns once the panel passes — re-run to capture the passing PanelResult.
          ctx.panel = await panel.review(converged.artifact);
          log.info({ rounds: converged.rounds }, 'B13 auto-improve converged');
        } catch (err) {
          if (err instanceof JudgeVetoError) {
            ctx.warnings.push(`B13 judge veto after auto-improve: ${err.message}`);
            ctx.panel = {
              vetoed: true,
              approvals: 0,
              rejections: err.votes.length,
              verdicts: err.votes.map((v) => ({
                judge: v.judge,
                persona: 'architect',
                approved: false,
                reason: v.reason,
              })),
              repairNotes: err.votes.map((v) => v.reason),
            };
            return;
          }
          ctx.warnings.push(`B13 judge panel error: ${(err as Error).message}`);
        }
      }),
  },
  {
    id: 'B14-emit-secrets',
    description: 'Emit secrets bundle + cost optimizer summary.',
    dependsOn: ['B13-judge-panel'],
    run: async (ctx) =>
      span('B14', async () => {
        const vaultCred = ctx.fctx.emit.keyVault
          ? getCredential({ mode: ctx.fctx.auth.mode, tenantId: ctx.fctx.tenant?.tenantId })
          : undefined;
        const store = await buildSecretStore({
          keyVaultUrl: ctx.fctx.emit.keyVault,
          credential: vaultCred,
        });
        for (const s of ctx.secrets) {
          await store.set(s.ref.scope, s.ref.name, s.value);
        }

        if (ctx.azure) {
          try {
            const cred = getCredential({
              mode: ctx.fctx.auth.mode,
              tenantId: ctx.fctx.tenant?.tenantId,
            });
            const suggestions = await optimizeCost({
              subscriptionId: ctx.azure.subscriptionId,
              credential: cred,
              resources: [
                {
                  resource: ctx.azure.resourceGroup,
                  sku: 'Standard_DS2_v2',
                  region: ctx.azure.region,
                },
              ],
            });
            ctx.costSuggestions = suggestions;
            log.info({ count: suggestions.length }, 'B14 cost optimizer complete');
          } catch (err) {
            ctx.warnings.push(`B14 cost optimizer skipped: ${(err as Error).message}`);
          }
        }

        const summaryLines: string[] = [];
        if (ctx.entra) {
          summaryLines.push(`AAD_APP_CLIENT_ID=${ctx.entra.appId}`);
          summaryLines.push(`AAD_APP_TENANT_ID=${ctx.entra.tenantId}`);
        }
        if (ctx.bot) summaryLines.push(`BOT_ID=${ctx.bot.botId}`);
        if (ctx.sp) summaryLines.push(`SP_APP_ID=${ctx.sp.appId}`);
        if (ctx.azure) {
          summaryLines.push(`AZURE_SUBSCRIPTION_ID=${ctx.azure.subscriptionId}`);
          summaryLines.push(`AZURE_RESOURCE_GROUP=${ctx.azure.resourceGroup}`);
          summaryLines.push(`AZURE_REGION=${ctx.azure.region}`);
        }
        summaryLines.push(`TEAMS_ENV=${DEFAULT_ENV}`);

        if (summaryLines.length > 0) {
          ctx.secrets.push({
            ref: {
              scope: 'teams-app',
              name: 'identifiers',
              description: 'Public identifiers for downstream paste (no secrets).',
            },
            value: summaryLines.join('\n'),
          });
        }
        log.info({ secretCount: ctx.secrets.length }, 'B14 emit complete');
      }),
  },
];

export async function runTeamsApp(fctx: FactoryContext): Promise<RunResult> {
  const ctx: TACtx = { fctx, artifacts: [], secrets: [], warnings: [] };
  const log_ = log.child({ runId: fctx.runId, recipe: fctx.recipe });
  log_.info('starting Teams App WBS');

  await execute(steps, ctx, {
    planOnly: fctx.planOnly,
    onStep: (id, phase, err) => log_.info({ id, phase, err: err?.message }, `step:${id}:${phase}`),
  });

  const pasteBundle = buildPasteBundle(
    ctx.secrets.map((s) => ({
      scope: s.ref.scope,
      name: s.ref.name,
      value: s.value,
      description: s.ref.description,
    })),
    {
      title: '# App Factory — Teams app run report',
      artifacts: ctx.artifacts,
      warnings: ctx.warnings,
      ...(ctx.costSuggestions && ctx.costSuggestions.length > 0
        ? { costSuggestions: ctx.costSuggestions }
        : {}),
    },
  );

  return {
    ok: true,
    runId: fctx.runId,
    artifacts: ctx.artifacts,
    secrets: ctx.secrets.map((s) => s.ref),
    pasteBundle,
    log: '',
    warnings: ctx.warnings,
    errors: [],
  };
}

export { steps as teamsAppSteps };
export type { TACtx };
export { requireProject, requireAzure, requireEntra, requireSp };
