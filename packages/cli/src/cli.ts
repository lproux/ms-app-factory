#!/usr/bin/env node
import { Command } from 'commander';
import { AppFactoryError } from '@app-factory/shared';
import { getRecipe, type Recipe } from '@app-factory/elicitation';
import { promises as fs } from 'node:fs';
import { run } from './run.js';
import { printDoctorReport, runDoctor } from './doctor.js';

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
    '--skip-doctor',
    'Skip the preflight prerequisite checks. Default: doctor runs before elicitation.',
  )
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
      // Preflight: run doctor checks scoped to this recipe before elicitation,
      // unless the user explicitly opts out. This prevents the "90s into a live
      // run before discovering pac is missing" footgun the UX critic flagged.
      if (!opts.skipDoctor) {
        const recipe = await resolvePreflightRecipe(opts.recipe, opts.recipeFile);
        const report = await runDoctor({ recipe });
        if (!opts.json) printDoctorReport(report);
        if (!report.ok) {
          const failed = report.results
            .filter((r) => r.required && r.status === 'fail')
            .map((r) => r.name);
          throw new AppFactoryError(
            'DOCTOR_FAILED',
            `preflight prerequisite check failed: ${failed.join(', ')}. Install the missing tools (see fix hints above) or re-run with --skip-doctor to bypass.`,
            { recoverable: true, details: { failed, recipe: recipe?.id } },
          );
        }
      }
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

program
  .command('doctor')
  .description('Probe prerequisite tools (node/pnpm/tmux/pac/atk/agent365/gh/az + env vars).')
  .option('-r, --recipe <id>', 'Scope checks to a specific recipe (otherwise probes the full matrix).')
  .option('--recipe-file <path>', 'Scope checks to a recipe loaded from a YAML file.')
  .option('--json', 'Emit the report as JSON instead of the pretty table.')
  .action(async (opts) => {
    try {
      const recipe = await resolvePreflightRecipe(opts.recipe, opts.recipeFile);
      const report = await runDoctor({ recipe });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printDoctorReport(report);
      }
      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code) console.error(`[${e.code}] ${e.message}`);
      else console.error(e.stack ?? String(err));
      process.exit(1);
    }
  });

/**
 * Resolve a recipe for preflight purposes (only `id` and `target` are needed by the doctor).
 * Returns undefined if neither flag is set — that's fine for the standalone `doctor` command,
 * which then probes the full matrix.
 */
async function resolvePreflightRecipe(
  recipeId: string | undefined,
  recipeFile: string | undefined,
): Promise<Pick<Recipe, 'id' | 'target'> | undefined> {
  if (recipeFile) {
    const yaml = await import('yaml');
    const txt = await fs.readFile(recipeFile, 'utf8');
    const parsed = yaml.parse(txt) as Recipe;
    return { id: parsed.id, target: parsed.target };
  }
  if (recipeId) {
    const r = getRecipe(recipeId);
    // If the id is unknown, we don't throw here — the subsequent `run()` will. We just
    // fall back to a full-matrix probe so the user still sees useful preflight output.
    if (r) return { id: r.id, target: r.target };
  }
  return undefined;
}

program.parseAsync(process.argv);
