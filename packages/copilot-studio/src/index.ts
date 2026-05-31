import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AppFactoryError,
  JudgeVetoError,
  createLogger,
  PortalRequiredError,
  span,
  type ArtifactRef,
  type FactoryContext,
  type RunResult,
  type SecretRef,
} from '@app-factory/shared';
import { execute, type Step } from '@app-factory/orchestrator';
import { buildPasteBundle, buildSecretStore } from '@app-factory/secret-store';
import { buildLogoSet } from '@app-factory/logo-pipeline';
import { getCredential } from '@app-factory/auth-broker';
import {
  autoImprove,
  buildJudgePanel,
  type JudgeArtifact,
  type PanelResult,
  type Persona,
} from '@app-factory/judge-panel';
import {
  envCreate,
  envList,
  envSelect,
  pac,
  solutionInit,
  type PacEnv,
} from './pac.js';
import { DataverseClient } from './dataverse.js';
import {
  writeAgentDefinition,
  zipSolution,
  type AgentDefinition,
  type Topic,
} from './agent-definition.js';
import { uploadKb, type KbDispatchOptions, type KbUploadResult } from './kb-upload.js';
import { createCustomConnector, loadOpenApi } from './openapi.js';
import { importSolution, publishAgent } from './publish.js';

const log = createLogger('copilot-studio');

interface CSCtx {
  fctx: FactoryContext;
  artifacts: ArtifactRef[];
  secrets: { ref: SecretRef; value: string }[];
  warnings: string[];
  environment?: PacEnv;
  solutionDir?: string;
  solutionZip?: string;
  agentDef?: AgentDefinition;
  authProfile?: string;
  agentRecordId?: string;
  invokeUrl?: string;
  panel?: PanelResult;
}

const steps: Step<CSCtx>[] = [
  {
    id: 'A2-resolve-environment',
    description: 'Resolve target Power Platform environment via `pac env list/create`.',
    run: async (ctx) =>
      span('A2', async () => {
        try {
          const desired = ctx.fctx.tenant?.powerPlatformEnvironment;
          const envs = await envList();
          let chosen = envs.find((e) => e.id === desired || e.displayName === desired);
          if (!chosen && desired === 'new') {
            const name = ctx.fctx.brand?.name ?? `factory-${ctx.fctx.runId.slice(0, 6)}`;
            const region = ctx.fctx.tenant?.region ?? 'unitedstates';
            log.info({ name, region }, 'creating new Power Platform environment');
            chosen = await envCreate({ name, region, type: 'Sandbox' });
          }
          if (!chosen) {
            ctx.warnings.push(
              `A2: no environment matched ${desired ?? '<unset>'}; downstream steps will skip.`,
            );
            return;
          }
          await envSelect(chosen.id);
          ctx.environment = chosen;
          ctx.artifacts.push({
            kind: 'azure-resource',
            id: chosen.id,
            displayName: chosen.displayName,
            metadata: { url: chosen.url, region: chosen.region },
          });
          log.info({ envId: chosen.id, url: chosen.url }, 'environment selected');
        } catch (err) {
          if (err instanceof PortalRequiredError) throw err;
          throw err;
        }
      }),
  },
  {
    id: 'A3-solution-skeleton',
    description: 'Create Dataverse solution skeleton (publisher, prefix) via `pac solution init`.',
    dependsOn: ['A2-resolve-environment'],
    run: async (ctx) =>
      span('A3', async () => {
        const slug = sanitizeUniqueName(ctx.fctx.brand?.name ?? ctx.fctx.runId);
        const solutionDir = path.join(ctx.fctx.workdir, 'solution');
        await fs.mkdir(solutionDir, { recursive: true });
        ctx.solutionDir = solutionDir;

        try {
          await solutionInit({
            publisherName: 'AppFactory',
            publisherPrefix: 'af',
            outputDirectory: solutionDir,
          });
        } catch (err) {
          // pac may complain about an existing directory — we tolerate that and fall through to
          // direct XML synth via writeAgentDefinition.
          log.warn({ err: (err as Error).message }, 'pac solution init skipped; synthesizing manually');
        }

        const baseDef: AgentDefinition = {
          uniqueName: slug,
          displayName: ctx.fctx.brand?.name ?? slug,
          description: undefined,
          instructions: 'You are a helpful assistant. Use the configured knowledge base when answering.',
          topics: [
            {
              name: 'Greeting',
              triggerPhrases: ['hi', 'hello', 'hey'],
              nodes: [
                {
                  kind: 'message',
                  text: ctx.fctx.brand?.greeting ?? `Hello! I'm ${ctx.fctx.brand?.name ?? 'your assistant'}.`,
                },
              ],
            },
          ],
        };
        ctx.agentDef = baseDef;
        await writeAgentDefinition(solutionDir, baseDef);
        const zipPath = path.join(ctx.fctx.workdir, 'solution.zip');
        await zipSolution(solutionDir, zipPath);
        ctx.solutionZip = zipPath;
        ctx.artifacts.push({
          kind: 'cs-agent',
          id: slug,
          displayName: baseDef.displayName,
          metadata: { solutionDir, solutionZip: zipPath, phase: 'skeleton' },
        });
      }),
  },
  {
    id: 'A4-entra-app',
    description: 'Provision Entra app + admin consent URL (delegates to teams-app/azure-ops).',
    dependsOn: ['A3-solution-skeleton'],
    run: async (ctx) =>
      span('A4', async () => {
        log.info('A4: Entra app provisioning is owned by teams-app/azure-ops; emitting placeholder ref.');
        ctx.artifacts.push({
          kind: 'entra-app',
          id: `placeholder-${ctx.fctx.runId.slice(0, 8)}`,
          displayName: `${ctx.fctx.brand?.name ?? 'cs-agent'} (deferred)`,
          metadata: { deferredTo: 'teams-app|azure-ops' },
        });
      }),
  },
  {
    id: 'A5-agent-definition',
    description: 'Enrich agent topics/instructions (uses fctx.brand greeting + KB-derived fallback).',
    parallelGroup: 'A-build',
    dependsOn: ['A4-entra-app'],
    run: async (ctx) =>
      span('A5', async () => {
        if (!ctx.agentDef || !ctx.solutionDir) {
          ctx.warnings.push('A5 skipped: A3 did not produce an agent definition.');
          return;
        }
        const greeting =
          ctx.fctx.brand?.greeting ?? `Hi! I'm ${ctx.agentDef.displayName}. How can I help today?`;
        const topics: Topic[] = [
          {
            name: 'Greeting',
            triggerPhrases: ['hi', 'hello', 'hey', 'good morning', 'good afternoon'],
            nodes: [{ kind: 'message', text: greeting }],
          },
          {
            name: 'Fallback',
            triggerPhrases: ['__fallback__'],
            nodes: [
              {
                kind: 'message',
                text: "I'm not sure about that yet. Could you rephrase or ask something more specific?",
              },
            ],
          },
        ];
        ctx.agentDef = {
          ...ctx.agentDef,
          greeting,
          topics,
          generativeAnswers: {
            enabled: ctx.fctx.kbSources.length > 0,
            sources: ctx.fctx.kbSources.map((s) => `${s.kind}:${s.uri}`),
          },
        };
        await writeAgentDefinition(ctx.solutionDir, ctx.agentDef);
        if (ctx.solutionZip) {
          await zipSolution(ctx.solutionDir, ctx.solutionZip);
        }
      }),
  },
  {
    id: 'A6-kb-ingest',
    description: 'Ingest KB sources (local/SharePoint/URL/GitHub/AWS/GCP/Foundry/M365).',
    parallelGroup: 'A-build',
    dependsOn: ['A4-entra-app'],
    run: async (ctx) =>
      span('A6', async () => {
        if (ctx.fctx.kbSources.length === 0) {
          log.info('A6: no KB sources configured');
          return;
        }
        const dispatch: KbDispatchOptions = {
          tenantId: ctx.fctx.tenant?.tenantId,
          dataverseUrl: ctx.environment?.url,
          agentRecordId: ctx.agentRecordId,
          libraryName: 'AppFactoryKB',
        };
        const results: KbUploadResult[] = [];
        for (const src of ctx.fctx.kbSources) {
          try {
            const r = await uploadKb(src, dispatch);
            results.push(r);
            ctx.warnings.push(...r.warnings);
          } catch (err) {
            ctx.warnings.push(`A6 ${src.kind}:${src.uri} → ${(err as Error).message}`);
          }
        }
        log.info({ results }, 'A6 complete');
      }),
  },
  {
    id: 'A7-rest-tools',
    description: 'Wire REST/OpenAPI v2 tools (only when fctx.brand.options.restSpecPath is set).',
    parallelGroup: 'A-build',
    dependsOn: ['A4-entra-app'],
    run: async (ctx) =>
      span('A7', async () => {
        const restSpecPath = (ctx.fctx.brand as { options?: { restSpecPath?: string } } | undefined)
          ?.options?.restSpecPath;
        if (!restSpecPath) {
          log.info('A7: no REST tools requested');
          return;
        }
        try {
          const loaded = await loadOpenApi(restSpecPath);
          await createCustomConnector(loaded.spec, {
            pacWrapper: pac,
            envId: ctx.environment?.id,
          });
        } catch (err) {
          if (err instanceof AppFactoryError && err.code === 'OPENAPI_DOWNGRADE_UNSUPPORTED') {
            throw new PortalRequiredError(
              `REST spec uses v3 features not representable in v2: ${err.message}`,
              'https://make.powerautomate.com/connectors',
              { cause: err, details: err.details },
            );
          }
          throw err;
        }
      }),
  },
  {
    id: 'A8-brand',
    description: 'Upload logo variants + colors + greeting to the agent record.',
    parallelGroup: 'A-build',
    dependsOn: ['A4-entra-app'],
    run: async (ctx) =>
      span('A8', async () => {
        try {
          const logoSet = await buildLogoSet({
            sourcePath: ctx.fctx.brand?.logoPath,
            promptHint: `Logo for ${ctx.fctx.brand?.name ?? 'an AI agent'}`,
          });
          if (!ctx.environment?.url || !ctx.agentRecordId) {
            log.info('A8: no live agent record — skipping Dataverse upload, retaining buffers in memory');
            return;
          }
          const dv = new DataverseClient({
            envUrl: ctx.environment.url,
            credential: getCredential({ mode: 'chained', tenantId: ctx.fctx.tenant?.tenantId }),
          });
          await dv.uploadBinaryColumn('bots', ctx.agentRecordId, 'iconbase64', logoSet.color192.bytes, 'image/png');
          log.info('A8: brand uploaded');
        } catch (err) {
          if (err instanceof AppFactoryError && err.code === 'LOGO_MISSING') {
            ctx.warnings.push('A8: no logo provided and LOGO_PROVIDER==skip; continuing without brand.');
            return;
          }
          if (
            err instanceof AppFactoryError &&
            (err.code === 'LOGO_PROVIDER_NOT_CONFIGURED' || err.code === 'LOGO_PROVIDER_NOT_INSTALLED')
          ) {
            ctx.warnings.push(`A8: ${err.message}`);
            return;
          }
          throw err;
        }
      }),
  },
  {
    id: 'A9-publish',
    description: 'Import solution then publish via Copilot Studio / pac.',
    dependsOn: ['A5-agent-definition', 'A6-kb-ingest', 'A7-rest-tools', 'A8-brand'],
    run: async (ctx) =>
      span('A9', async () => {
        if (!ctx.solutionZip) {
          ctx.warnings.push('A9 skipped: no solution.zip available.');
          return;
        }
        try {
          const importRes = await importSolution(ctx.solutionZip, {
            envId: ctx.environment?.id,
            asyncWaitTimeMins: 30,
          });
          const agentId = importRes.solutionId ?? (ctx.agentDef?.uniqueName ?? ctx.fctx.runId);
          const pubRes = await publishAgent(agentId, { envId: ctx.environment?.id });
          ctx.invokeUrl = pubRes.invokeUrl;
          ctx.agentRecordId = agentId;
          ctx.artifacts.push({
            kind: 'cs-agent',
            id: agentId,
            displayName: ctx.agentDef?.displayName ?? agentId,
            metadata: { invokeUrl: pubRes.invokeUrl, channels: pubRes.channels, envId: ctx.environment?.id },
          });
        } catch (err) {
          if (err instanceof PortalRequiredError) throw err;
          throw err;
        }
      }),
  },
  {
    id: 'A10-smoke-test',
    description: 'Direct Line + Copilot Studio Kit Test Automation smoke tests (Wave 2).',
    dependsOn: ['A9-publish'],
    run: async () =>
      span('A10', async () => {
        log.info('A10 placeholder — smoke-test integration lands in Wave 2.');
      }),
  },
  {
    id: 'A11-judge-panel',
    description: 'Multi-model judge panel review (architect/security/cost/UX).',
    dependsOn: ['A10-smoke-test'],
    run: async (ctx) =>
      span('A11', async () => {
        const personas: Persona[] = ['architect', 'security', 'cost', 'ux'];
        const panel = buildJudgePanel({
          shape: ctx.fctx.judge.shape,
          personas,
          policy: { vetoOn: ['security'] },
        });
        const buildArtifact = (extraNotes: string[]): JudgeArtifact => ({
          kind: 'cs-agent',
          id: ctx.agentRecordId ?? ctx.agentDef?.uniqueName ?? ctx.fctx.runId,
          displayName: ctx.agentDef?.displayName ?? ctx.fctx.brand?.name ?? 'cs-agent',
          summary: [
            `Recipe: ${ctx.fctx.recipe}`,
            `Agent: ${ctx.agentDef?.displayName ?? '<unnamed>'}`,
            `Environment: ${ctx.environment?.displayName ?? '<unset>'} (${ctx.environment?.url ?? '<no url>'})`,
            `KB sources: ${ctx.fctx.kbSources.length}`,
            `Topics: ${ctx.agentDef?.topics.length ?? 0}`,
            `Invoke URL: ${ctx.invokeUrl ?? '<not published>'}`,
            `Warnings so far: ${ctx.warnings.length}`,
            ...(extraNotes.length > 0 ? [`RepairNotes: ${extraNotes.join(' | ')}`] : []),
          ].join('\n'),
          payload: {
            agentDef: ctx.agentDef,
            artifacts: ctx.artifacts,
            warnings: ctx.warnings,
            repairNotes: extraNotes,
          },
        });
        try {
          const converged = await autoImprove({
            panel,
            initial: { input: ctx, artifact: buildArtifact([]) },
            maxRounds: ctx.fctx.judge.maxRounds,
            regenerate: async (input, repairNotes) => {
              input.warnings.push(`A11 auto-improve repair notes: ${repairNotes.join(' | ')}`);
              return { input, artifact: buildArtifact(repairNotes) };
            },
          });
          ctx.panel = await panel.review(converged.artifact);
          log.info({ rounds: converged.rounds }, 'A11 auto-improve converged');
        } catch (err) {
          if (err instanceof JudgeVetoError) {
            ctx.warnings.push(`A11 judge veto after auto-improve: ${err.message}`);
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
          ctx.warnings.push(`A11 judge panel error: ${(err as Error).message}`);
        }
      }),
  },
  {
    id: 'A12-emit-secrets',
    description: 'Emit secrets bundle (pac auth profile, envId, agentId) to keyring + paste blob.',
    dependsOn: ['A11-judge-panel'],
    run: async (ctx) =>
      span('A12', async () => {
        const scope = 'copilot-studio';
        if (ctx.authProfile) {
          ctx.secrets.push({
            ref: { scope, name: 'pacAuthProfile', description: 'pac auth profile name' },
            value: ctx.authProfile,
          });
        }
        if (ctx.environment?.id) {
          ctx.secrets.push({
            ref: { scope, name: 'envId', description: 'Power Platform environment id' },
            value: ctx.environment.id,
          });
        }
        if (ctx.environment?.url) {
          ctx.secrets.push({
            ref: { scope, name: 'envUrl', description: 'Power Platform environment URL' },
            value: ctx.environment.url,
          });
        }
        if (ctx.agentRecordId) {
          ctx.secrets.push({
            ref: { scope, name: 'agentId', description: 'Published Copilot Studio agent id' },
            value: ctx.agentRecordId,
          });
        }
        if (ctx.invokeUrl) {
          ctx.secrets.push({
            ref: { scope, name: 'invokeUrl', description: 'Direct Line invocation URL' },
            value: ctx.invokeUrl,
          });
        }
      }),
  },
];

export async function runCopilotStudio(fctx: FactoryContext): Promise<RunResult> {
  const ctx: CSCtx = { fctx, artifacts: [], secrets: [], warnings: [] };
  const log_ = log.child({ runId: fctx.runId, recipe: fctx.recipe });
  log_.info('starting Copilot Studio WBS');

  const errors: string[] = [];
  try {
    await execute(steps, ctx, {
      planOnly: fctx.planOnly,
      onStep: (id, phase, err) => log_.info({ id, phase, err: err?.message }, `step:${id}:${phase}`),
    });
  } catch (err) {
    errors.push((err as Error).message);
    log_.error({ err }, 'WBS execution halted');
  }

  const vaultCred = fctx.emit.keyVault
    ? getCredential({ mode: fctx.auth.mode, tenantId: fctx.tenant?.tenantId })
    : undefined;
  const store = await buildSecretStore({
    keyVaultUrl: fctx.emit.keyVault,
    credential: vaultCred,
  });
  for (const s of ctx.secrets) {
    await store.set(s.ref.scope, s.ref.name, s.value);
  }
  const pasteBundle = buildPasteBundle(
    ctx.secrets.map((s) => ({
      scope: s.ref.scope,
      name: s.ref.name,
      value: s.value,
      description: s.ref.description,
    })),
    {
      title: '# App Factory — Copilot Studio run report',
      artifacts: ctx.artifacts,
      warnings: ctx.warnings,
      revealSecrets: fctx.emit.revealSecrets === true,
    },
  );

  return {
    ok: errors.length === 0,
    runId: fctx.runId,
    artifacts: ctx.artifacts,
    secrets: ctx.secrets.map((s) => s.ref),
    pasteBundle,
    log: '',
    warnings: ctx.warnings,
    errors,
  };
}

function sanitizeUniqueName(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return cleaned.length > 0 ? `af_${cleaned}` : `af_${Date.now().toString(36)}`;
}

export { steps as copilotStudioSteps };
export type { CSCtx };
export { AppFactoryError };
export * from './pac.js';
export * from './dataverse.js';
export * from './agent-definition.js';
export * from './kb-upload.js';
export * from './openapi.js';
export * from './publish.js';
