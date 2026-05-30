import { createLogger } from '@app-factory/shared';
import { Recipe, type Question } from './schema.js';

const log = createLogger('elicitation');

export type Answers = Record<string, unknown>;

export interface AskFn {
  (q: Question, answersSoFar: Answers): Promise<unknown>;
}

export interface ElicitOptions {
  recipe: Recipe;
  initialAnswers?: Answers;
  ask: AskFn;
  infer?: (q: Question, answers: Answers) => unknown | undefined;
}

export async function elicit(opts: ElicitOptions): Promise<Answers> {
  const recipe = Recipe.parse(opts.recipe);
  const answers: Answers = { ...(recipe.defaults ?? {}), ...(opts.initialAnswers ?? {}) };
  for (const q of recipe.questions) {
    if (q.id in answers && answers[q.id] !== undefined) continue;
    const inferred = opts.infer?.(q, answers);
    if (inferred !== undefined) {
      answers[q.id] = inferred;
      log.debug({ id: q.id, value: inferred }, 'inferred answer');
      continue;
    }
    if (q.default !== undefined && !q.required) {
      answers[q.id] = q.default;
    }
    if (q.required && answers[q.id] === undefined) {
      answers[q.id] = await opts.ask(q, answers);
    }
  }
  return answers;
}

export function renderPlanMarkdown(recipe: Recipe, answers: Answers): string {
  const lines = [`# Plan — ${recipe.title}`, '', recipe.description, '', '## Inputs', ''];
  for (const q of recipe.questions) {
    const v = answers[q.id];
    lines.push(`- **${q.prompt}** — \`${formatValue(v)}\``);
  }
  lines.push('', '## Target', '', `- Engine: \`${recipe.target}\``);
  return lines.join('\n');
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return '(unset)';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
