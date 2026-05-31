import { AppFactoryError, createLogger, span } from '@app-factory/shared';

const log = createLogger('orchestrator:wbs');

export interface Step<C> {
  id: string;
  description: string;
  parallelGroup?: string;
  dependsOn?: string[];
  run: (ctx: C) => Promise<void>;
}

export interface RunOptions {
  planOnly?: boolean;
  onStep?: (id: string, phase: 'start' | 'done' | 'fail', err?: Error) => void;
}

export async function execute<C>(steps: Step<C>[], ctx: C, opts: RunOptions = {}): Promise<void> {
  const done = new Set<string>();
  if (opts.planOnly) {
    for (const s of steps) {
      log.info({ id: s.id, parallelGroup: s.parallelGroup, dependsOn: s.dependsOn }, s.description);
    }
    return;
  }

  while (done.size < steps.length) {
    const ready = steps.filter(
      (s) => !done.has(s.id) && (s.dependsOn ?? []).every((d) => done.has(d)),
    );
    if (ready.length === 0) {
      const missing = steps.filter((s) => !done.has(s.id)).map((s) => s.id);
      throw new AppFactoryError('WBS_DEADLOCK', `cannot resolve dependencies for: ${missing.join(', ')}`);
    }

    // Fan out ALL ready steps in parallel. Steps that share a `parallelGroup`
    // value behave the same as steps with distinct ids — Promise.all over the
    // flat list runs them concurrently while still honouring `dependsOn`.
    // Previously only the first group ran per round, which serialized any
    // recipe that hadn't manually unified its parallelGroup keys.
    await Promise.all(
      ready.map((s) =>
        span(`step:${s.id}`, async () => {
          opts.onStep?.(s.id, 'start');
          try {
            await s.run(ctx);
            done.add(s.id);
            opts.onStep?.(s.id, 'done');
          } catch (err) {
            opts.onStep?.(s.id, 'fail', err as Error);
            throw err;
          }
        }),
      ),
    );
  }
}
