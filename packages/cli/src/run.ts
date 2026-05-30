import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import {
  FactoryContext,
  createLogger,
  type RunResult,
} from '@app-factory/shared';
import { runCopilotStudio } from '@app-factory/copilot-studio';
import { runTeamsApp } from '@app-factory/teams-app';
import {
  elicit,
  getRecipe,
  renderPlanMarkdown,
  type Answers,
  type Question,
  type Recipe,
} from '@app-factory/elicitation';

const log = createLogger('cli');

export interface RunArgs {
  recipe: string;
  recipeFile?: string;
  plan?: boolean;
  workdir?: string;
  answers?: Answers;
  nonInteractive?: boolean;
}

async function defaultAsk(q: Question, _answers: Answers): Promise<unknown> {
  if (q.default !== undefined) return q.default;
  throw new Error(
    `required answer missing for "${q.id}" (${q.prompt}). Pass via --answers or run interactively.`,
  );
}

export async function run(args: RunArgs): Promise<RunResult> {
  const recipe = await loadRecipe(args);
  const ask = args.nonInteractive ? defaultAsk : defaultAsk;
  const answers = await elicit({ recipe, initialAnswers: args.answers ?? {}, ask });

  const runId = nanoid(10);
  const workdir = args.workdir ?? path.join(process.cwd(), '.app-factory', runId);
  await fs.mkdir(workdir, { recursive: true });

  if (args.plan) {
    const planMd = renderPlanMarkdown(recipe, answers);
    const planPath = path.join(workdir, 'plan.md');
    await fs.writeFile(planPath, planMd, 'utf8');
    log.info({ planPath }, 'plan written');
    return {
      ok: true,
      runId,
      artifacts: [],
      secrets: [],
      pasteBundle: planMd,
      log: planPath,
      warnings: [],
      errors: [],
    };
  }

  const fctx = FactoryContext.parse({
    runId,
    recipe: recipe.id,
    planOnly: false,
    workdir,
    brand: { name: String(answers['name'] ?? recipe.title), logoPath: stringOrUndef(answers['logoPath']) },
    kbSources: parseKbSources(answers['kbSources']),
    tenant: {
      subscriptionId: stringOrUndef(answers['subscription']),
      resourceGroup: stringOrUndef(answers['resourceGroup']),
      region: stringOrUndef(answers['region']),
      powerPlatformEnvironment: stringOrUndef(answers['environment']),
    },
  });

  if (recipe.target === 'copilot-studio') return runCopilotStudio(fctx);
  if (recipe.target === 'teams') return runTeamsApp(fctx);
  throw new Error(`unknown recipe target: ${recipe.target}`);
}

async function loadRecipe(args: RunArgs): Promise<Recipe> {
  if (args.recipeFile) {
    const yaml = await import('yaml');
    const txt = await fs.readFile(args.recipeFile, 'utf8');
    return yaml.parse(txt) as Recipe;
  }
  const r = getRecipe(args.recipe);
  if (!r) throw new Error(`unknown recipe: ${args.recipe}`);
  return r;
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function parseKbSources(v: unknown): { kind: 'local' | 'sharepoint' | 'url' | 'github' | 'aws-s3' | 'gcp-gcs' | 'foundry' | 'm365-admin'; uri: string }[] {
  if (typeof v !== 'string') return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [kind, ...rest] = entry.split(':');
      return { kind: (kind as 'local') ?? 'local', uri: rest.join(':') };
    });
}
