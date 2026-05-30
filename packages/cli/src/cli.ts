#!/usr/bin/env node
import { Command } from 'commander';
import { run } from './run.js';

const program = new Command();

program
  .name('app-factory')
  .description('Provision Copilot Studio agents and Teams apps end-to-end.')
  .version('0.1.0');

program
  .command('build')
  .description('Run a factory recipe end-to-end (or --plan only).')
  .requiredOption('-r, --recipe <id>', 'Recipe id (e.g., copilot-studio-support-bot, teams-bot-basic)')
  .option('--recipe-file <path>', 'Load recipe from a YAML file instead of the registry')
  .option('--plan', 'Plan mode — write plans/<run>/plan.md and exit without side effects')
  .option('--workdir <path>', 'Working directory for run artifacts')
  .option('--answer <kv...>', 'Pre-supplied answers as key=value pairs (repeatable)')
  .option('--non-interactive', 'Fail if a required answer is missing (CI mode)')
  .action(async (opts) => {
    const answers: Record<string, string> = {};
    for (const kv of (opts.answer ?? []) as string[]) {
      const ix = kv.indexOf('=');
      if (ix < 0) {
        console.error(`bad --answer (need key=value): ${kv}`);
        process.exit(2);
      }
      answers[kv.slice(0, ix)] = kv.slice(ix + 1);
    }
    try {
      const result = await run({
        recipe: opts.recipe,
        recipeFile: opts.recipeFile,
        plan: opts.plan,
        workdir: opts.workdir,
        nonInteractive: opts.nonInteractive,
        answers,
      });
      console.log(JSON.stringify(
        { runId: result.runId, ok: result.ok, warnings: result.warnings, errors: result.errors, log: result.log },
        null, 2,
      ));
      if (result.pasteBundle) {
        console.log('\n--- paste bundle ---\n');
        console.log(result.pasteBundle);
      }
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      console.error((err as Error).stack ?? String(err));
      process.exit(1);
    }
  });

program
  .command('list-recipes')
  .description('List built-in recipes.')
  .action(async () => {
    const { allRecipes } = await import('@app-factory/elicitation');
    for (const r of allRecipes) {
      console.log(`${r.id}\t[${r.target}]\t${r.title}`);
    }
  });

program.parseAsync(process.argv);
