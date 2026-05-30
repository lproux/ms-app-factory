import {
  createLogger,
  type ArtifactRef,
  type FactoryContext,
  type RunResult,
  type SecretRef,
} from '@app-factory/shared';
import { execute, type Step } from '@app-factory/orchestrator';
import { buildPasteBundle, SecretStore } from '@app-factory/secret-store';

const log = createLogger('teams-app');

interface TACtx {
  fctx: FactoryContext;
  artifacts: ArtifactRef[];
  secrets: { ref: SecretRef; value: string }[];
  warnings: string[];
}

const steps: Step<TACtx>[] = [
  {
    id: 'B2-scaffold',
    description: 'Scaffold project from atk template + overlays.',
    run: async () => log.info('B2 placeholder — atk new wiring pending.'),
  },
  {
    id: 'B3-azure-rg',
    description: 'Resolve subscription + resource group.',
    dependsOn: ['B2-scaffold'],
    run: async () => log.info('B3 placeholder.'),
  },
  {
    id: 'B4-sp',
    description: 'Create SP, grant Contributor + App Admin.',
    dependsOn: ['B3-azure-rg'],
    run: async () => log.info('B4 placeholder.'),
  },
  {
    id: 'B5-pim',
    description: 'PIM elevation when needed.',
    dependsOn: ['B4-sp'],
    run: async () => log.info('B5 placeholder.'),
  },
  {
    id: 'B6-registrations',
    description: 'Entra app reg + bot registration; stamp env vars.',
    dependsOn: ['B5-pim'],
    run: async () => log.info('B6 placeholder.'),
  },
  {
    id: 'B7-provision',
    description: '`atk provision --env <env>` (m365agents.yml ARM).',
    dependsOn: ['B6-registrations'],
    run: async () => log.info('B7 placeholder — atk provision wiring pending.'),
  },
  {
    id: 'B8-deploy',
    description: '`atk deploy --env <env>`.',
    dependsOn: ['B7-provision'],
    run: async () => log.info('B8 placeholder.'),
  },
  {
    id: 'B9-package',
    description: '`atk package` manifest + icons.',
    dependsOn: ['B8-deploy'],
    run: async () => log.info('B9 placeholder.'),
  },
  {
    id: 'B10-validate',
    description: '`atk validate --manifest-path` + `--app-package-file-path`.',
    dependsOn: ['B9-package'],
    run: async () => log.info('B10 placeholder.'),
  },
  {
    id: 'B11-publish',
    description: 'Developer Portal publish / sideload.',
    dependsOn: ['B10-validate'],
    run: async () => log.info('B11 placeholder.'),
  },
  {
    id: 'B12-smoke-test',
    description: 'Local Agents Playground + Direct Line probe.',
    dependsOn: ['B11-publish'],
    run: async () => log.info('B12 placeholder.'),
  },
  {
    id: 'B13-judge-panel',
    description: 'Judge-panel review.',
    dependsOn: ['B12-smoke-test'],
    run: async () => log.info('B13 placeholder.'),
  },
  {
    id: 'B14-emit-secrets',
    description: 'Emit secrets bundle.',
    dependsOn: ['B13-judge-panel'],
    run: async () => log.info('B14 placeholder.'),
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

export { steps as teamsAppSteps };
