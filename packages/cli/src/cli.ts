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
  .option('--json', 'Emit the run report as JSON only (no human summary or paste bundle)')
  .option(
    '--reveal-secrets',
    'Embed raw secret material into the paste bundle. Default is redacted placeholders so the bundle is safe to log/share. Real secrets always live in the OS keyring + optional Key Vault.',
  )
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
        revealSecrets: opts.revealSecrets,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        // Human-readable summary first, then the paste bundle.
        const status = result.ok ? 'OK' : 'FAILED';
        console.log(`Run ${result.runId} ${status}`);
        console.log(`  artifacts: ${result.artifacts.length}`);
        console.log(`  secrets:   ${result.secrets.length}${opts.revealSecrets ? '' : '  (values redacted; pass --reveal-secrets to embed)'}`);
        console.log(`  warnings:  ${result.warnings.length}`);
        if (result.warnings.length > 0) {
          for (const w of result.warnings) console.log(`    - ${w}`);
        }
        if (result.errors.length > 0) {
          console.log(`  errors:    ${result.errors.length}`);
          for (const e of result.errors) console.log(`    - ${e}`);
        }
        if (result.log) console.log(`  log:       ${result.log}`);
        if (result.pasteBundle) {
          console.log('\n--- paste bundle ---\n');
          console.log(result.pasteBundle);
        }
      }
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      const e = err as Error & { code?: string; details?: unknown; portalUrl?: string };
      if (e.portalUrl) {
        console.error(`\x1b[31m→ Open portal: ${e.portalUrl}\x1b[0m`);
      }
      if (e.code) console.error(`[${e.code}] ${e.message}`);
      else console.error(e.stack ?? String(err));
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
