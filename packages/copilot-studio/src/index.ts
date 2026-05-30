import {
  AppFactoryError,
  createLogger,
  type ArtifactRef,
  type FactoryContext,
  type RunResult,
  type SecretRef,
} from '@app-factory/shared';
import { execute, type Step } from '@app-factory/orchestrator';
import { buildPasteBundle, SecretStore } from '@app-factory/secret-store';

const log = createLogger('copilot-studio');

interface CSCtx {
  fctx: FactoryContext;
  artifacts: ArtifactRef[];
  secrets: { ref: SecretRef; value: string }[];
  warnings: string[];
}

const steps: Step<CSCtx>[] = [
  {
    id: 'A2-resolve-environment',
    description: 'Resolve target Power Platform environment via `pac env list/create`.',
    run: async (ctx) => {
      log.info('A2 placeholder — `pac env` integration lands in next iteration.');
      ctx.warnings.push('A2 placeholder: pac env wiring pending.');
    },
  },
  {
    id: 'A3-solution-skeleton',
    description: 'Create Dataverse solution skeleton (publisher, prefix).',
    dependsOn: ['A2-resolve-environment'],
    run: async (ctx) => {
      log.info('A3 placeholder — `pac solution init` integration pending.');
      ctx.warnings.push('A3 placeholder.');
    },
  },
  {
    id: 'A4-entra-app',
    description: 'Provision Entra app + admin consent URL.',
    dependsOn: ['A3-solution-skeleton'],
    run: async () => {
      log.info('A4 placeholder — Graph SDK wiring pending.');
    },
  },
  {
    id: 'A5-agent-definition',
    description: 'Build agent topics/instructions as Dataverse components.',
    parallelGroup: 'A-build',
    dependsOn: ['A4-entra-app'],
    run: async () => {
      log.info('A5 placeholder.');
    },
  },
  {
    id: 'A6-kb-ingest',
    description: 'Ingest KB sources (local/SharePoint/URL/GitHub/AWS/GCP/Foundry/M365).',
    parallelGroup: 'A-build',
    dependsOn: ['A4-entra-app'],
    run: async (ctx) => {
      log.info({ count: ctx.fctx.kbSources.length }, 'A6 placeholder.');
    },
  },
  {
    id: 'A7-rest-tools',
    description: 'Wire REST/OpenAPI v2 tools.',
    parallelGroup: 'A-build',
    dependsOn: ['A4-entra-app'],
    run: async () => {
      log.info('A7 placeholder.');
    },
  },
  {
    id: 'A8-brand',
    description: 'Upload logo variants, colors, greeting.',
    parallelGroup: 'A-build',
    dependsOn: ['A4-entra-app'],
    run: async () => {
      log.info('A8 placeholder.');
    },
  },
  {
    id: 'A9-publish',
    description: 'Channel publish (Teams/web/M365).',
    dependsOn: ['A5-agent-definition', 'A6-kb-ingest', 'A7-rest-tools', 'A8-brand'],
    run: async () => {
      log.info('A9 placeholder.');
    },
  },
  {
    id: 'A10-smoke-test',
    description: 'Direct Line + Copilot Studio Kit Test Automation smoke tests.',
    dependsOn: ['A9-publish'],
    run: async () => {
      log.info('A10 placeholder.');
    },
  },
  {
    id: 'A11-judge-panel',
    description: 'Multi-model judge panel review.',
    dependsOn: ['A10-smoke-test'],
    run: async () => {
      log.info('A11 placeholder.');
    },
  },
  {
    id: 'A12-emit-secrets',
    description: 'Emit secrets bundle to keyring + paste blob.',
    dependsOn: ['A11-judge-panel'],
    run: async () => {
      log.info('A12 placeholder.');
    },
  },
];

export async function runCopilotStudio(fctx: FactoryContext): Promise<RunResult> {
  const ctx: CSCtx = { fctx, artifacts: [], secrets: [], warnings: [] };
  const log_ = log.child({ runId: fctx.runId, recipe: fctx.recipe });
  log_.info('starting Copilot Studio WBS');

  await execute(steps, ctx, {
    planOnly: fctx.planOnly,
    onStep: (id, phase, err) => log_.info({ id, phase, err: err?.message }, `step:${id}:${phase}`),
  });

  const store = new SecretStore();
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

export { steps as copilotStudioSteps };
export type { CSCtx };
export { AppFactoryError };
