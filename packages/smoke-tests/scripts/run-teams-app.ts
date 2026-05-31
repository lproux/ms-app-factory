#!/usr/bin/env tsx
/**
 * Live-tenant Teams app smoke run. Requires every env var in `_env.ts`. Exits
 * non-zero if `runTeamsApp` returns `ok: false` or reports any errors.
 */
import { runTeamsApp } from '@app-factory/teams-app';
import { createLogger } from '@app-factory/shared';
import { buildSmokeContext, loadSmokeEnv, newRunId, summarize } from './_env.js';

const log = createLogger('smoke:teams');

async function main(): Promise<void> {
  const env = loadSmokeEnv();
  const runId = newRunId();
  log.info({ runId }, 'starting Teams app smoke');

  const fctx = await buildSmokeContext({
    env,
    runId,
    recipe: 'teams-bot-basic',
    planOnly: false,
    brandName: `App Factory Smoke ${runId}`,
  });

  const result = await runTeamsApp(fctx);
  summarize(result, 'teams');
  if (!result.ok || result.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  log.error({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
