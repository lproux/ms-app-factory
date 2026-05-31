#!/usr/bin/env tsx
/**
 * Live-tenant Copilot Studio smoke run. Requires every env var in `_env.ts`
 * to be set. Exits non-zero on any orchestrator error or any judge veto.
 */
import { runCopilotStudio } from '@app-factory/copilot-studio';
import { createLogger } from '@app-factory/shared';
import { buildSmokeContext, loadSmokeEnv, newRunId, summarize } from './_env.js';

const log = createLogger('smoke:cs');

async function main(): Promise<void> {
  const env = loadSmokeEnv();
  const runId = newRunId();
  log.info({ runId }, 'starting Copilot Studio smoke');

  const fctx = await buildSmokeContext({
    env,
    runId,
    recipe: 'copilot-studio-custom',
    planOnly: false,
    brandName: `App Factory Smoke ${runId}`,
  });

  const result = await runCopilotStudio(fctx);
  summarize(result, 'cs');
  if (!result.ok || result.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  log.error({ err: (err as Error).message }, 'fatal');
  process.exit(1);
});
