#!/usr/bin/env tsx
/**
 * Cheapest live-tenant sanity check: invokes `runCopilotStudio` and
 * `runTeamsApp` with `planOnly: true`. This:
 *   - validates that every required env var is present and well-formed
 *   - exercises the orchestrator plan-rendering code path against a real
 *     tenant context (subscription / RG / region / PP env id)
 *   - writes a plan markdown into a per-run workdir under the OS temp dir
 *   - never makes provisioning API calls (no `pac`, no `atk`, no Graph)
 *
 * Use this as the first step of every smoke run; if it fails the live runs
 * cannot succeed.
 */
import { runCopilotStudio } from '@app-factory/copilot-studio';
import { runTeamsApp } from '@app-factory/teams-app';
import { createLogger } from '@app-factory/shared';
import { buildSmokeContext, loadSmokeEnv, newRunId, summarize } from './_env.js';

const log = createLogger('smoke:dry');

async function main(): Promise<void> {
  const env = loadSmokeEnv();
  const runId = newRunId();
  log.info({ runId }, 'starting dry-run (planOnly=true) for CS + Teams');

  const csCtx = await buildSmokeContext({
    env,
    runId: `${runId}-cs`,
    recipe: 'copilot-studio-custom',
    planOnly: true,
    brandName: `App Factory Smoke ${runId}`,
  });
  const csResult = await runCopilotStudio(csCtx);
  summarize(csResult, 'dry:cs');

  const teamsCtx = await buildSmokeContext({
    env,
    runId: `${runId}-teams`,
    recipe: 'teams-bot-basic',
    planOnly: true,
    brandName: `App Factory Smoke ${runId}`,
  });
  const teamsResult = await runTeamsApp(teamsCtx);
  summarize(teamsResult, 'dry:teams');

  const failed = !csResult.ok || !teamsResult.ok ||
    csResult.errors.length > 0 || teamsResult.errors.length > 0;
  if (failed) {
    log.error('dry-run reported failures — see above');
    process.exit(1);
  }
  log.info('dry-run passed');
}

main().catch((err: unknown) => {
  log.error({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
